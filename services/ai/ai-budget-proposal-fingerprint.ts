import { createHash } from 'node:crypto';

import type { AiCostEstimate, AiCostRunEstimate } from './ai-cost-estimator';
import type { AiCostEstimateRun } from './ai-cost-estimator';
import type { AiExecutionCostPlan } from './ai-execution-cost-plan';
import {
  getAiOrchestrationPolicy,
  type AiOrchestrationModeKey,
  type AiOrchestrationRoleKey,
} from './ai-orchestration-policy';
import {
  isFixedPrecisionUsd,
  isLanguageModelTokenCount,
  sumLanguageModelCostUsd,
} from './language-model-pricing';

export type AiBudgetProposalFingerprints = Readonly<{
  estimateFingerprint: string;
  executionPlanFingerprint: string;
}>;

export class AiBudgetProposalFingerprintValidationError extends Error {
  readonly code = 'budget_proposal_fingerprint_invalid';
}

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PLAN_KEYS = ['mode', 'runs'] as const;
const PLAN_RUN_KEYS = [
  'inputTokens',
  'modelKey',
  'modelVersion',
  'outputTokens',
  'pricingContext',
  'providerKey',
  'role',
] as const;
const PLAN_RUN_KEYS_WITHOUT_CONTEXT = PLAN_RUN_KEYS.filter((key) => key !== 'pricingContext');
const ESTIMATE_KEYS = [
  'hasUnknownCost',
  'knownEstimatedCostUsd',
  'mode',
  'pricingEffectiveAt',
  'runEstimates',
  'unknownCostRunCount',
] as const;
const ESTIMATE_RUN_KEYS = [
  'assumedInputTokens',
  'assumedOutputTokens',
  'estimatedCostUsd',
  'modelKey',
  'modelVersion',
  'pricingKnown',
  'providerKey',
  'role',
] as const;

function invalid(): never {
  throw new AiBudgetProposalFingerprintValidationError(
    'The AI budget proposal fingerprint input is invalid.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isMode(value: unknown): value is AiOrchestrationModeKey {
  return typeof value === 'string' && ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'].includes(value);
}

function isRole(value: unknown): value is AiOrchestrationRoleKey {
  return (
    typeof value === 'string' && ['CANDIDATE', 'CRITIC', 'VERIFIER', 'SYNTHESIZER'].includes(value)
  );
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPricingContext(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, ['inferenceGeo']) &&
    (value.inferenceGeo === undefined || isIdentity(value.inferenceGeo))
  );
}

function validatePlanRun(
  run: unknown,
  mode: AiOrchestrationModeKey,
  step: number,
): asserts run is AiCostEstimateRun {
  if (
    !isRecord(run) ||
    !hasExactKeys(
      run,
      run.pricingContext === undefined ? PLAN_RUN_KEYS_WITHOUT_CONTEXT : PLAN_RUN_KEYS,
    ) ||
    !isIdentity(run.providerKey) ||
    !isIdentity(run.modelKey) ||
    !isIdentity(run.modelVersion) ||
    !isRole(run.role) ||
    run.role !== getAiOrchestrationPolicy(mode).steps[step]?.role ||
    !isLanguageModelTokenCount(run.inputTokens) ||
    !isLanguageModelTokenCount(run.outputTokens) ||
    !isPricingContext(run.pricingContext)
  ) {
    invalid();
  }
}

function validatePlan(plan: AiExecutionCostPlan): void {
  if (
    !isRecord(plan) ||
    !hasExactKeys(plan, PLAN_KEYS) ||
    !isMode(plan.mode) ||
    !Array.isArray(plan.runs)
  ) {
    invalid();
  }
  const policy = getAiOrchestrationPolicy(plan.mode);
  if (plan.runs.length !== policy.steps.length) invalid();
  plan.runs.forEach((run, step) => validatePlanRun(run, plan.mode, step));
}

function validateEstimateRun(
  run: unknown,
  planRun: AiCostEstimateRun,
  mode: AiOrchestrationModeKey,
  step: number,
): asserts run is AiCostRunEstimate {
  if (
    !isRecord(run) ||
    !hasExactKeys(run, ESTIMATE_RUN_KEYS) ||
    !isIdentity(run.providerKey) ||
    !isIdentity(run.modelKey) ||
    !isIdentity(run.modelVersion) ||
    !isRole(run.role) ||
    run.role !== getAiOrchestrationPolicy(mode).steps[step]?.role ||
    run.providerKey !== planRun.providerKey ||
    run.modelKey !== planRun.modelKey ||
    run.modelVersion !== planRun.modelVersion ||
    run.role !== planRun.role ||
    run.assumedInputTokens !== planRun.inputTokens ||
    run.assumedOutputTokens !== planRun.outputTokens ||
    !isLanguageModelTokenCount(run.assumedInputTokens) ||
    !isLanguageModelTokenCount(run.assumedOutputTokens) ||
    typeof run.pricingKnown !== 'boolean' ||
    (run.pricingKnown && !isFixedPrecisionUsd(run.estimatedCostUsd)) ||
    (!run.pricingKnown && run.estimatedCostUsd !== null)
  ) {
    invalid();
  }
}

function validateEstimate(plan: AiExecutionCostPlan, estimate: AiCostEstimate): void {
  if (
    !isRecord(estimate) ||
    !hasExactKeys(estimate, ESTIMATE_KEYS) ||
    !isMode(estimate.mode) ||
    estimate.mode !== plan.mode ||
    !isCanonicalTimestamp(estimate.pricingEffectiveAt) ||
    !Array.isArray(estimate.runEstimates) ||
    estimate.runEstimates.length !== plan.runs.length ||
    typeof estimate.hasUnknownCost !== 'boolean' ||
    !Number.isSafeInteger(estimate.unknownCostRunCount) ||
    estimate.unknownCostRunCount < 0 ||
    !isFixedPrecisionUsd(estimate.knownEstimatedCostUsd)
  ) {
    invalid();
  }

  estimate.runEstimates.forEach((run, step) =>
    validateEstimateRun(run, plan.runs[step] as AiCostEstimateRun, plan.mode, step),
  );
  const knownCosts = estimate.runEstimates.flatMap((run) =>
    run.estimatedCostUsd === null ? [] : [run.estimatedCostUsd],
  );
  const unknownCostRunCount = estimate.runEstimates.length - knownCosts.length;
  if (
    estimate.hasUnknownCost !== unknownCostRunCount > 0 ||
    estimate.unknownCostRunCount !== unknownCostRunCount ||
    estimate.knownEstimatedCostUsd !== sumLanguageModelCostUsd(knownCosts)
  ) {
    invalid();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalExecutionPlan(plan: AiExecutionCostPlan): string {
  return JSON.stringify([
    'skyos.ai-budget-execution-plan.v1',
    plan.mode,
    plan.runs.map((run, step) => [
      step,
      run.role,
      run.providerKey,
      run.modelKey,
      run.modelVersion,
      run.inputTokens,
      run.outputTokens,
      run.outputTokens,
      run.pricingContext?.inferenceGeo ?? null,
    ]),
  ]);
}

/**
 * Produces the canonical execution-identity hash without reconstructing a cost
 * estimate. Confirmation revalidation uses this first, before pricing either
 * the historic approved basis or the current proposal.
 */
export function fingerprintAiBudgetExecutionPlan(executionPlan: AiExecutionCostPlan): string {
  validatePlan(executionPlan);
  return sha256(canonicalExecutionPlan(executionPlan));
}

function canonicalEstimate(planFingerprint: string, estimate: AiCostEstimate): string {
  return JSON.stringify([
    'skyos.ai-budget-estimate.v1',
    planFingerprint,
    estimate.mode,
    estimate.pricingEffectiveAt,
    estimate.hasUnknownCost,
    estimate.unknownCostRunCount,
    estimate.knownEstimatedCostUsd,
    estimate.runEstimates.map((run, step) => [
      step,
      run.role,
      run.providerKey,
      run.modelKey,
      run.modelVersion,
      run.assumedInputTokens,
      run.assumedOutputTokens,
      run.pricingKnown,
      run.estimatedCostUsd,
    ]),
  ]);
}

/**
 * Creates deterministic SHA-256 bindings for one exact, already-resolved budget
 * proposal. It intentionally has no environment, provider, database, or network access.
 */
export function fingerprintAiBudgetProposal(
  input: Readonly<{ estimate: AiCostEstimate; executionPlan: AiExecutionCostPlan }>,
): AiBudgetProposalFingerprints {
  if (!isRecord(input) || !hasExactKeys(input, ['estimate', 'executionPlan'])) invalid();
  validateEstimate(input.executionPlan, input.estimate);
  const executionPlanFingerprint = fingerprintAiBudgetExecutionPlan(input.executionPlan);
  return Object.freeze({
    estimateFingerprint: sha256(canonicalEstimate(executionPlanFingerprint, input.estimate)),
    executionPlanFingerprint,
  });
}

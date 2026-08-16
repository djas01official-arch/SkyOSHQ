import type { AiCostEstimateRun } from './ai-cost-estimator';
import type { AiExecutionCostPlan } from './ai-execution-cost-plan';
import {
  AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_METHODS,
  AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_UNAVAILABLE_REASONS,
  evaluateAiPlannedInputTokenFit,
  requireAiProviderInputTokenMeasurementForIdentity,
  type AiBoundProviderInputTokenMeasurement,
  type AiProviderInputTokenMeasurementIdentity,
  type AiProviderInputTokenMeasurementMethod,
  type AiProviderInputTokenMeasurementUnavailableReason,
} from './ai-input-token-measurement';
import { getAiOrchestrationPolicy } from './ai-orchestration-policy';
import { isLanguageModelTokenCount } from './language-model-pricing';

type AiResolvedInputTokenBudgetBase = AiProviderInputTokenMeasurementIdentity &
  Readonly<{
    effectiveInputTokens: number;
    plannedInputTokens: number;
  }>;

export type AiResolvedInputTokenBudget =
  | (AiResolvedInputTokenBudgetBase &
      Readonly<{
        measuredInputTokens: number;
        measurementMethod: AiProviderInputTokenMeasurementMethod;
        status: 'PLAN_ELEVATED_TO_MEASUREMENT' | 'VERIFIED_WITHIN_PLAN';
      }>)
  | (AiResolvedInputTokenBudgetBase &
      Readonly<{
        measuredInputTokens: null;
        status: 'MEASUREMENT_UNAVAILABLE';
        unavailableReason: AiProviderInputTokenMeasurementUnavailableReason;
      }>);

export type AiInputTokenBudgetResolutionSummary = Readonly<{
  elevatedRunCount: number;
  hasElevatedInputPlan: boolean;
  hasUnavailableMeasurement: boolean;
  unavailableRunCount: number;
  verifiedRunCount: number;
}>;

export type AiAdjustedInputTokenCostPlan = Readonly<{
  adjustedPlan: AiExecutionCostPlan;
  resolvedInputs: readonly AiResolvedInputTokenBudget[];
  summary: AiInputTokenBudgetResolutionSummary;
}>;

export class AiInputTokenBudgetError extends Error {
  readonly code: 'input_token_budget_identity_mismatch' | 'input_token_budget_invalid';

  constructor(message: string, code: AiInputTokenBudgetError['code']) {
    super(message);
    this.code = code;
  }
}

function expectedIdentity(
  run: AiCostEstimateRun,
  step: number,
): AiProviderInputTokenMeasurementIdentity {
  if (!Number.isSafeInteger(step) || step < 0 || !isLanguageModelTokenCount(run.inputTokens)) {
    throw new AiInputTokenBudgetError(
      'The planned input-token budget is invalid.',
      'input_token_budget_invalid',
    );
  }
  return Object.freeze({
    modelKey: run.modelKey,
    modelVersion: run.modelVersion,
    providerKey: run.providerKey,
    role: run.role,
    step,
  });
}

export function resolveAiInputTokenBudget(
  input: Readonly<{
    measurement: AiBoundProviderInputTokenMeasurement;
    plannedRun: AiCostEstimateRun;
    step: number;
  }>,
): AiResolvedInputTokenBudget {
  const identity = expectedIdentity(input.plannedRun, input.step);
  let measurement;
  try {
    measurement = requireAiProviderInputTokenMeasurementForIdentity(input.measurement, identity);
  } catch {
    throw new AiInputTokenBudgetError(
      'The input-token measurement does not match the planned run.',
      'input_token_budget_identity_mismatch',
    );
  }
  const plannedInputTokens = input.plannedRun.inputTokens;
  const fit = evaluateAiPlannedInputTokenFit({ measurement, plannedInputTokens });
  if (measurement.status === 'UNAVAILABLE') {
    return Object.freeze({
      ...identity,
      effectiveInputTokens: plannedInputTokens,
      measuredInputTokens: null,
      plannedInputTokens,
      status: 'MEASUREMENT_UNAVAILABLE',
      unavailableReason: measurement.reason,
    });
  }
  const elevated = fit.status === 'EXCEEDS_PLAN';
  return Object.freeze({
    ...identity,
    effectiveInputTokens: elevated ? measurement.inputTokens : plannedInputTokens,
    measuredInputTokens: measurement.inputTokens,
    measurementMethod: measurement.method,
    plannedInputTokens,
    status: elevated ? 'PLAN_ELEVATED_TO_MEASUREMENT' : 'VERIFIED_WITHIN_PLAN',
  });
}

function validateResolvedBudget(
  resolved: AiResolvedInputTokenBudget,
  run: AiCostEstimateRun,
  step: number,
): void {
  const identity = expectedIdentity(run, step);
  if (
    !['MEASUREMENT_UNAVAILABLE', 'PLAN_ELEVATED_TO_MEASUREMENT', 'VERIFIED_WITHIN_PLAN'].includes(
      resolved.status,
    ) ||
    resolved.providerKey !== identity.providerKey ||
    resolved.modelKey !== identity.modelKey ||
    resolved.modelVersion !== identity.modelVersion ||
    resolved.role !== identity.role ||
    resolved.step !== identity.step ||
    resolved.plannedInputTokens !== run.inputTokens ||
    !isLanguageModelTokenCount(resolved.effectiveInputTokens)
  ) {
    throw new AiInputTokenBudgetError(
      'The resolved input-token budget does not match the planned run.',
      'input_token_budget_identity_mismatch',
    );
  }

  if (resolved.status === 'MEASUREMENT_UNAVAILABLE') {
    if (
      resolved.measuredInputTokens !== null ||
      resolved.effectiveInputTokens !== resolved.plannedInputTokens ||
      !AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_UNAVAILABLE_REASONS.includes(resolved.unavailableReason)
    ) {
      throw new AiInputTokenBudgetError(
        'The unavailable input-token budget is invalid.',
        'input_token_budget_invalid',
      );
    }
    return;
  }

  if (
    !isLanguageModelTokenCount(resolved.measuredInputTokens) ||
    !AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_METHODS.includes(resolved.measurementMethod) ||
    (resolved.status === 'VERIFIED_WITHIN_PLAN' &&
      (resolved.measuredInputTokens > resolved.plannedInputTokens ||
        resolved.effectiveInputTokens !== resolved.plannedInputTokens)) ||
    (resolved.status === 'PLAN_ELEVATED_TO_MEASUREMENT' &&
      (resolved.measuredInputTokens <= resolved.plannedInputTokens ||
        resolved.effectiveInputTokens !== resolved.measuredInputTokens))
  ) {
    throw new AiInputTokenBudgetError(
      'The resolved input-token budget is invalid.',
      'input_token_budget_invalid',
    );
  }
}

export function applyAiResolvedInputBudgetsToExecutionCostPlan(
  input: Readonly<{
    plan: AiExecutionCostPlan;
    resolvedInputs: readonly AiResolvedInputTokenBudget[];
  }>,
): AiAdjustedInputTokenCostPlan {
  const policy = getAiOrchestrationPolicy(input.plan.mode);
  if (
    input.plan.runs.length !== policy.steps.length ||
    input.resolvedInputs.length !== input.plan.runs.length
  ) {
    throw new AiInputTokenBudgetError(
      'The resolved input-token budgets do not match the execution plan.',
      'input_token_budget_invalid',
    );
  }

  const runs = input.plan.runs.map((run, step) => {
    const resolved = input.resolvedInputs[step];
    if (!resolved || run.role !== policy.steps[step]?.role) {
      throw new AiInputTokenBudgetError(
        'The resolved input-token budget execution shape is invalid.',
        'input_token_budget_invalid',
      );
    }
    validateResolvedBudget(resolved, run, step);
    return Object.freeze({ ...run, inputTokens: resolved.effectiveInputTokens });
  });
  const verifiedRunCount = input.resolvedInputs.filter(
    ({ status }) => status === 'VERIFIED_WITHIN_PLAN',
  ).length;
  const elevatedRunCount = input.resolvedInputs.filter(
    ({ status }) => status === 'PLAN_ELEVATED_TO_MEASUREMENT',
  ).length;
  const unavailableRunCount = input.resolvedInputs.filter(
    ({ status }) => status === 'MEASUREMENT_UNAVAILABLE',
  ).length;

  return Object.freeze({
    adjustedPlan: Object.freeze({ mode: input.plan.mode, runs: Object.freeze(runs) }),
    resolvedInputs: Object.freeze([...input.resolvedInputs]),
    summary: Object.freeze({
      elevatedRunCount,
      hasElevatedInputPlan: elevatedRunCount > 0,
      hasUnavailableMeasurement: unavailableRunCount > 0,
      unavailableRunCount,
      verifiedRunCount,
    }),
  });
}

/**
 * Applies one request-local measurement to its exact planned step while leaving
 * every other run in the immutable preflight plan unchanged.
 */
export function applyAiResolvedInputBudgetToExecutionCostPlan(
  input: Readonly<{
    plan: AiExecutionCostPlan;
    resolvedInput: AiResolvedInputTokenBudget;
  }>,
): AiExecutionCostPlan {
  const policy = getAiOrchestrationPolicy(input.plan.mode);
  const step = input.resolvedInput.step;
  const run = input.plan.runs[step];
  if (
    input.plan.runs.length !== policy.steps.length ||
    !run ||
    run.role !== policy.steps[step]?.role
  ) {
    throw new AiInputTokenBudgetError(
      'The resolved input-token budget execution step is invalid.',
      'input_token_budget_invalid',
    );
  }
  validateResolvedBudget(input.resolvedInput, run, step);
  return Object.freeze({
    mode: input.plan.mode,
    runs: Object.freeze(
      input.plan.runs.map((plannedRun, index) =>
        index === step
          ? Object.freeze({
              ...plannedRun,
              inputTokens: input.resolvedInput.effectiveInputTokens,
            })
          : plannedRun,
      ),
    ),
  });
}

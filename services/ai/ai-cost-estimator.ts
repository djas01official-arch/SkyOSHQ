import {
  AI_ORCHESTRATION_MODES,
  AI_ORCHESTRATION_ROLES,
  getAiOrchestrationPolicy,
  type AiOrchestrationModeKey,
  type AiOrchestrationRoleKey,
} from './ai-orchestration-policy';
import {
  estimateLanguageModelCostUsd,
  isLanguageModelTokenCount,
  sumLanguageModelCostUsd,
  type FixedPrecisionUsd,
  type LanguageModelPricingContext,
} from './language-model-pricing';

export type AiCostEstimateRun = Readonly<{
  inputTokens: number;
  modelKey: string;
  modelVersion: string;
  outputTokens: number;
  pricingContext?: LanguageModelPricingContext;
  providerKey: string;
  role: AiOrchestrationRoleKey;
}>;

export type AiCostEstimateInput = Readonly<{
  mode: AiOrchestrationModeKey;
  pricingEffectiveAt: string;
  runs: readonly AiCostEstimateRun[];
}>;

export type AiCostRunEstimate = Readonly<{
  assumedInputTokens: number;
  assumedOutputTokens: number;
  estimatedCostUsd: FixedPrecisionUsd | null;
  modelKey: string;
  modelVersion: string;
  pricingKnown: boolean;
  providerKey: string;
  role: AiOrchestrationRoleKey;
}>;

export type AiCostEstimate = Readonly<{
  hasUnknownCost: boolean;
  knownEstimatedCostUsd: FixedPrecisionUsd;
  mode: AiOrchestrationModeKey;
  pricingEffectiveAt: string;
  runEstimates: readonly AiCostRunEstimate[];
  unknownCostRunCount: number;
}>;

export class AiCostEstimatorValidationError extends Error {
  readonly code = 'cost_estimate_input_invalid';
}

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const INPUT_KEYS = ['mode', 'pricingEffectiveAt', 'runs'] as const;
const RUN_KEYS = [
  'inputTokens',
  'modelKey',
  'modelVersion',
  'outputTokens',
  'pricingContext',
  'providerKey',
  'role',
] as const;

function hasOnlyKeys(candidate: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(candidate).every((key) => allowed.includes(key));
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_PATTERN.test(value);
}

function isPricingContext(value: unknown): value is LanguageModelPricingContext | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    hasOnlyKeys(candidate, ['inferenceGeo']) &&
    (candidate.inferenceGeo === undefined || isIdentity(candidate.inferenceGeo))
  );
}

function isMode(value: unknown): value is AiOrchestrationModeKey {
  return (
    typeof value === 'string' && AI_ORCHESTRATION_MODES.includes(value as AiOrchestrationModeKey)
  );
}

function isRole(value: unknown): value is AiOrchestrationRoleKey {
  return (
    typeof value === 'string' && AI_ORCHESTRATION_ROLES.includes(value as AiOrchestrationRoleKey)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateInput(input: AiCostEstimateInput): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AiCostEstimatorValidationError('The AI cost estimate input is invalid.');
  }
  const candidate = input as unknown as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== INPUT_KEYS.length ||
    !hasOnlyKeys(candidate, INPUT_KEYS) ||
    !isMode(candidate.mode) ||
    !isCanonicalTimestamp(candidate.pricingEffectiveAt) ||
    !Array.isArray(candidate.runs) ||
    candidate.runs.length === 0
  ) {
    throw new AiCostEstimatorValidationError('The AI cost estimate input is invalid.');
  }

  const policy = getAiOrchestrationPolicy(candidate.mode);
  if (candidate.runs.length !== policy.steps.length) {
    throw new AiCostEstimatorValidationError(
      'The AI cost estimate execution shape does not match its orchestration mode.',
    );
  }

  for (const [index, value] of candidate.runs.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new AiCostEstimatorValidationError('The AI cost estimate run is invalid.');
    }
    const run = value as Record<string, unknown>;
    const requiredKeyCount =
      run.pricingContext === undefined ? RUN_KEYS.length - 1 : RUN_KEYS.length;
    if (
      Object.keys(run).length !== requiredKeyCount ||
      !hasOnlyKeys(run, RUN_KEYS) ||
      !isIdentity(run.providerKey) ||
      !isIdentity(run.modelKey) ||
      !isIdentity(run.modelVersion) ||
      !isRole(run.role) ||
      run.role !== policy.steps[index]?.role ||
      !isLanguageModelTokenCount(run.inputTokens) ||
      !isLanguageModelTokenCount(run.outputTokens) ||
      !isPricingContext(run.pricingContext)
    ) {
      throw new AiCostEstimatorValidationError('The AI cost estimate run is invalid.');
    }
  }
}

/**
 * Prices an already-resolved execution plan without routing, provider execution, or I/O.
 */
export function estimateAiExecutionCost(input: AiCostEstimateInput): AiCostEstimate {
  validateInput(input);
  const effectiveAt = new Date(input.pricingEffectiveAt);
  const runEstimates = input.runs.map((run): AiCostRunEstimate => {
    const estimatedCostUsd = estimateLanguageModelCostUsd(
      run.providerKey,
      run.modelKey,
      {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        totalTokens: run.inputTokens + run.outputTokens,
      },
      effectiveAt,
      run.pricingContext,
    );
    return Object.freeze({
      assumedInputTokens: run.inputTokens,
      assumedOutputTokens: run.outputTokens,
      estimatedCostUsd: estimatedCostUsd ?? null,
      modelKey: run.modelKey,
      modelVersion: run.modelVersion,
      pricingKnown: estimatedCostUsd !== undefined,
      providerKey: run.providerKey,
      role: run.role,
    });
  });
  const unknownCostRunCount = runEstimates.filter((run) => !run.pricingKnown).length;
  return Object.freeze({
    hasUnknownCost: unknownCostRunCount > 0,
    knownEstimatedCostUsd: sumLanguageModelCostUsd(
      runEstimates.flatMap((run) => (run.estimatedCostUsd === null ? [] : [run.estimatedCostUsd])),
    ),
    mode: input.mode,
    pricingEffectiveAt: input.pricingEffectiveAt,
    runEstimates: Object.freeze(runEstimates),
    unknownCostRunCount,
  });
}

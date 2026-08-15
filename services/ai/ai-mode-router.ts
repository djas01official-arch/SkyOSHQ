import type { AiOrchestrationModeKey } from './ai-orchestration-policy';

export const AI_TASK_COMPLEXITIES = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'] as const;
export type AiTaskComplexity = (typeof AI_TASK_COMPLEXITIES)[number];

export const AI_TASK_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type AiTaskRisk = (typeof AI_TASK_RISK_LEVELS)[number];

export const AI_TASK_AMBIGUITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiTaskAmbiguity = (typeof AI_TASK_AMBIGUITY_LEVELS)[number];

export const AI_TASK_VERIFICATION_NEEDS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiTaskVerificationNeed = (typeof AI_TASK_VERIFICATION_NEEDS)[number];

export const AI_TASK_EXPECTED_EFFORTS = ['SMALL', 'MEDIUM', 'LARGE'] as const;
export type AiTaskExpectedEffort = (typeof AI_TASK_EXPECTED_EFFORTS)[number];

export const AI_TASK_ROUTING_REASONS = [
  'CRITICAL_RISK',
  'HIGH_RISK',
  'HIGH_VERIFICATION_NEED',
  'VERY_HIGH_COMPLEXITY',
  'HIGH_COMPLEXITY',
  'HIGH_AMBIGUITY',
  'LARGE_EXPECTED_EFFORT',
  'MODERATE_RISK',
  'MODERATE_COMPLEXITY',
  'MODERATE_AMBIGUITY',
  'MODERATE_VERIFICATION_NEED',
  'MODERATE_EXPECTED_EFFORT',
  'LOW_COMPLEXITY',
] as const;
export type AiTaskRoutingReason = (typeof AI_TASK_ROUTING_REASONS)[number];

export type AiTaskRoutingInput = Readonly<{
  ambiguity: AiTaskAmbiguity;
  complexity: AiTaskComplexity;
  expectedEffort: AiTaskExpectedEffort;
  risk: AiTaskRisk;
  verificationNeed: AiTaskVerificationNeed;
}>;

export type AiTaskRoutingDecision = Readonly<{
  mode: AiOrchestrationModeKey;
  reason: AiTaskRoutingReason;
}>;

export class AiModeRouterValidationError extends Error {
  readonly code = 'routing_input_invalid';
}

const ROUTING_INPUT_KEYS = [
  'ambiguity',
  'complexity',
  'expectedEffort',
  'risk',
  'verificationNeed',
] as const;

function includes<const Value extends string>(
  values: readonly Value[],
  value: unknown,
): value is Value {
  return typeof value === 'string' && values.includes(value as Value);
}

function isAiTaskRoutingInput(value: unknown): value is AiTaskRoutingInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.length === ROUTING_INPUT_KEYS.length &&
    keys.every((key) => ROUTING_INPUT_KEYS.includes(key as (typeof ROUTING_INPUT_KEYS)[number])) &&
    includes(AI_TASK_AMBIGUITY_LEVELS, candidate.ambiguity) &&
    includes(AI_TASK_COMPLEXITIES, candidate.complexity) &&
    includes(AI_TASK_EXPECTED_EFFORTS, candidate.expectedEffort) &&
    includes(AI_TASK_RISK_LEVELS, candidate.risk) &&
    includes(AI_TASK_VERIFICATION_NEEDS, candidate.verificationNeed)
  );
}

function decision(
  mode: AiOrchestrationModeKey,
  reason: AiTaskRoutingReason,
): AiTaskRoutingDecision {
  return Object.freeze({ mode, reason });
}

/**
 * Applies the reviewable mode-routing precedence without scoring, I/O, or runtime configuration.
 */
export function routeAiTask(input: AiTaskRoutingInput): AiTaskRoutingDecision {
  if (!isAiTaskRoutingInput(input)) {
    throw new AiModeRouterValidationError('The AI task routing input is invalid.');
  }

  if (input.risk === 'CRITICAL') return decision('CRITICAL', 'CRITICAL_RISK');
  if (input.risk === 'HIGH') return decision('CRITICAL', 'HIGH_RISK');

  if (input.verificationNeed === 'HIGH') return decision('DEEP', 'HIGH_VERIFICATION_NEED');
  if (input.complexity === 'VERY_HIGH') return decision('DEEP', 'VERY_HIGH_COMPLEXITY');
  if (input.complexity === 'HIGH') return decision('DEEP', 'HIGH_COMPLEXITY');
  if (input.ambiguity === 'HIGH') return decision('DEEP', 'HIGH_AMBIGUITY');
  if (input.expectedEffort === 'LARGE') return decision('DEEP', 'LARGE_EXPECTED_EFFORT');

  if (input.risk === 'MEDIUM') return decision('BALANCED', 'MODERATE_RISK');
  if (input.complexity === 'MEDIUM') return decision('BALANCED', 'MODERATE_COMPLEXITY');
  if (input.ambiguity === 'MEDIUM') return decision('BALANCED', 'MODERATE_AMBIGUITY');
  if (input.verificationNeed === 'MEDIUM') {
    return decision('BALANCED', 'MODERATE_VERIFICATION_NEED');
  }
  if (input.expectedEffort === 'MEDIUM') {
    return decision('BALANCED', 'MODERATE_EXPECTED_EFFORT');
  }

  return decision('FAST', 'LOW_COMPLEXITY');
}

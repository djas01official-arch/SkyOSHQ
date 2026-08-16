import type { AiOrchestrationRoleKey } from './ai-orchestration-policy';

export const AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_METHODS = ['PROVIDER_COUNT_API'] as const;
export type AiProviderInputTokenMeasurementMethod =
  (typeof AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_METHODS)[number];

export const AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_UNAVAILABLE_REASONS = [
  'COUNTING_NOT_SUPPORTED',
  'EXACT_REQUEST_MEASUREMENT_UNAVAILABLE',
  'PROVIDER_COUNT_ACCOUNTING_UNRESOLVED',
  'UNSUPPORTED_REQUEST_SHAPE',
] as const;
export type AiProviderInputTokenMeasurementUnavailableReason =
  (typeof AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_UNAVAILABLE_REASONS)[number];

export type AiProviderInputTokenMeasurement =
  | Readonly<{
      inputTokens: number;
      method: AiProviderInputTokenMeasurementMethod;
      status: 'KNOWN';
    }>
  | Readonly<{
      reason: AiProviderInputTokenMeasurementUnavailableReason;
      status: 'UNAVAILABLE';
    }>;

export type AiProviderInputTokenMeasurementIdentity = Readonly<{
  modelKey: string;
  modelVersion: string;
  providerKey: string;
  role: AiOrchestrationRoleKey;
  step: number;
}>;

export type AiBoundProviderInputTokenMeasurement = Readonly<{
  identity: AiProviderInputTokenMeasurementIdentity;
  measurement: AiProviderInputTokenMeasurement;
}>;

export type AiPlannedInputTokenFit = Readonly<{
  status: 'EXCEEDS_PLAN' | 'MEASUREMENT_UNAVAILABLE' | 'WITHIN_PLAN';
}>;

export class AiInputTokenMeasurementError extends Error {
  readonly code:
    | 'input_token_measurement_failed'
    | 'input_token_measurement_identity_mismatch'
    | 'input_token_measurement_invalid'
    | 'input_token_measurement_timeout';

  constructor(message: string, code: AiInputTokenMeasurementError['code']) {
    super(message);
    this.code = code;
  }
}

function tokenCount(value: unknown, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) < 1)) {
    throw new AiInputTokenMeasurementError(
      'The provider input-token measurement is invalid.',
      'input_token_measurement_invalid',
    );
  }
  return value as number;
}

export function knownAiProviderInputTokenMeasurement(
  inputTokens: unknown,
  method: AiProviderInputTokenMeasurementMethod = 'PROVIDER_COUNT_API',
): AiProviderInputTokenMeasurement {
  if (!AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_METHODS.includes(method)) {
    throw new AiInputTokenMeasurementError(
      'The provider input-token measurement method is invalid.',
      'input_token_measurement_invalid',
    );
  }
  return Object.freeze({ inputTokens: tokenCount(inputTokens, true), method, status: 'KNOWN' });
}

export function unavailableAiProviderInputTokenMeasurement(
  reason: AiProviderInputTokenMeasurementUnavailableReason,
): AiProviderInputTokenMeasurement {
  if (!AI_PROVIDER_INPUT_TOKEN_MEASUREMENT_UNAVAILABLE_REASONS.includes(reason)) {
    throw new AiInputTokenMeasurementError(
      'The provider input-token measurement reason is invalid.',
      'input_token_measurement_invalid',
    );
  }
  return Object.freeze({ reason, status: 'UNAVAILABLE' });
}

export function bindAiProviderInputTokenMeasurement(
  expected: AiProviderInputTokenMeasurementIdentity,
  actualProvider: Readonly<{ modelKey: string; modelVersion: string; providerKey: string }>,
  measurement: AiProviderInputTokenMeasurement,
): AiBoundProviderInputTokenMeasurement {
  const identity = validateAiProviderInputTokenMeasurementIdentity(expected, actualProvider);
  return Object.freeze({ identity, measurement });
}

export function validateAiProviderInputTokenMeasurementIdentity(
  expected: AiProviderInputTokenMeasurementIdentity,
  actualProvider: Readonly<{ modelKey: string; modelVersion: string; providerKey: string }>,
): AiProviderInputTokenMeasurementIdentity {
  if (
    expected.providerKey !== actualProvider.providerKey ||
    expected.modelKey !== actualProvider.modelKey ||
    expected.modelVersion !== actualProvider.modelVersion ||
    !Number.isSafeInteger(expected.step) ||
    expected.step < 0
  ) {
    throw new AiInputTokenMeasurementError(
      'The input-token measurement identity does not match the provider request.',
      'input_token_measurement_identity_mismatch',
    );
  }
  return Object.freeze({ ...expected });
}

export function requireAiProviderInputTokenMeasurementForIdentity(
  result: AiBoundProviderInputTokenMeasurement,
  expected: AiProviderInputTokenMeasurementIdentity,
): AiProviderInputTokenMeasurement {
  const actual = result.identity;
  if (
    actual.providerKey !== expected.providerKey ||
    actual.modelKey !== expected.modelKey ||
    actual.modelVersion !== expected.modelVersion ||
    actual.role !== expected.role ||
    actual.step !== expected.step
  ) {
    throw new AiInputTokenMeasurementError(
      'The input-token measurement is bound to a different execution step.',
      'input_token_measurement_identity_mismatch',
    );
  }
  return result.measurement;
}

export function evaluateAiPlannedInputTokenFit(
  input: Readonly<{
    measurement: AiProviderInputTokenMeasurement;
    plannedInputTokens: number;
  }>,
): AiPlannedInputTokenFit {
  const plannedInputTokens = tokenCount(input.plannedInputTokens, true);
  if (input.measurement.status === 'UNAVAILABLE') {
    return Object.freeze({ status: 'MEASUREMENT_UNAVAILABLE' });
  }
  return Object.freeze({
    status: input.measurement.inputTokens <= plannedInputTokens ? 'WITHIN_PLAN' : 'EXCEEDS_PLAN',
  });
}

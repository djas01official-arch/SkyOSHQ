import type { AiInputTokenMeasurementPolicy } from './ai-budget-runtime-config';
import { estimateAiExecutionCost, type AiCostRunEstimate } from './ai-cost-estimator';
import type { AiExecutionCostPlan } from './ai-execution-cost-plan';
import {
  applyAiResolvedInputBudgetToExecutionCostPlan,
  resolveAiInputTokenBudget,
} from './ai-input-token-budget';
import {
  bindAiProviderInputTokenMeasurement,
  unavailableAiProviderInputTokenMeasurement,
  type AiProviderInputTokenMeasurementIdentity,
} from './ai-input-token-measurement';
import type { LanguageModelProvider, LanguageModelRequest } from './language-model-provider';

export class AiDynamicInputBudgetError extends Error {
  readonly code: 'input_measurement_failed' | 'input_measurement_required';

  constructor(message: string, code: AiDynamicInputBudgetError['code']) {
    super(message);
    this.code = code;
  }
}

export type AiDynamicInputBudgetResult = Readonly<{
  adjustedPlan: AiExecutionCostPlan;
  nextRunEstimate: AiCostRunEstimate;
}>;

/**
 * Measures one already-constructed provider request and re-prices only its
 * exact immutable plan step. It never reserves, generates, or mutates usage.
 */
export async function resolveAiDynamicInputBudget(
  input: Readonly<{
    measurementPolicy: Exclude<AiInputTokenMeasurementPolicy, 'DISABLED'>;
    plan: AiExecutionCostPlan;
    pricingEffectiveAt: string;
    provider: LanguageModelProvider;
    request: LanguageModelRequest;
    step: number;
  }>,
): Promise<AiDynamicInputBudgetResult> {
  const plannedRun = input.plan.runs[input.step];
  if (!plannedRun) {
    throw new AiDynamicInputBudgetError(
      'The dynamic input-token plan step is invalid.',
      'input_measurement_failed',
    );
  }
  const identity: AiProviderInputTokenMeasurementIdentity = Object.freeze({
    modelKey: plannedRun.modelKey,
    modelVersion: plannedRun.modelVersion,
    providerKey: plannedRun.providerKey,
    role: plannedRun.role,
    step: input.step,
  });

  try {
    const measurement = !input.provider.measureInputTokens
      ? bindAiProviderInputTokenMeasurement(
          identity,
          input.provider,
          unavailableAiProviderInputTokenMeasurement('COUNTING_NOT_SUPPORTED'),
        )
      : !input.provider.inputTokenMeasurementAccounting ||
          input.provider.inputTokenMeasurementAccounting === 'UNRESOLVED'
        ? bindAiProviderInputTokenMeasurement(
            identity,
            input.provider,
            unavailableAiProviderInputTokenMeasurement('PROVIDER_COUNT_ACCOUNTING_UNRESOLVED'),
          )
        : input.provider.inputTokenMeasurementAccounting === 'NO_PROVIDER_CALL'
          ? bindAiProviderInputTokenMeasurement(
              identity,
              input.provider,
              unavailableAiProviderInputTokenMeasurement('EXACT_REQUEST_MEASUREMENT_UNAVAILABLE'),
            )
          : await input.provider.measureInputTokens(input.request, identity, {
              signal: AbortSignal.timeout(input.provider.timeoutMs),
            });
    const resolvedInput = resolveAiInputTokenBudget({
      measurement,
      plannedRun,
      step: input.step,
    });
    if (
      resolvedInput.status === 'MEASUREMENT_UNAVAILABLE' &&
      input.measurementPolicy === 'REQUIRED'
    ) {
      throw new AiDynamicInputBudgetError(
        'A reliable input-token measurement is required before orchestration can continue.',
        'input_measurement_required',
      );
    }
    const adjustedPlan = applyAiResolvedInputBudgetToExecutionCostPlan({
      plan: input.plan,
      resolvedInput,
    });
    const estimate = estimateAiExecutionCost({
      ...adjustedPlan,
      pricingEffectiveAt: input.pricingEffectiveAt,
    });
    const nextRunEstimate = estimate.runEstimates[input.step];
    if (!nextRunEstimate || !nextRunEstimate.pricingKnown) {
      throw new AiDynamicInputBudgetError(
        'The measured orchestration step could not be priced safely.',
        'input_measurement_failed',
      );
    }
    return Object.freeze({ adjustedPlan, nextRunEstimate });
  } catch (error) {
    if (error instanceof AiDynamicInputBudgetError) throw error;
    throw new AiDynamicInputBudgetError(
      'The input-token measurement could not be completed safely.',
      'input_measurement_failed',
    );
  }
}

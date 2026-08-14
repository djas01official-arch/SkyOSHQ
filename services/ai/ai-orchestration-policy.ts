import type { LanguageModelProviderDescriptor } from './language-model-provider';

export const AI_ORCHESTRATION_MODES = ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const;
export type AiOrchestrationModeKey = (typeof AI_ORCHESTRATION_MODES)[number];

export const AI_ORCHESTRATION_ROLES = ['CANDIDATE', 'CRITIC', 'VERIFIER', 'SYNTHESIZER'] as const;
export type AiOrchestrationRoleKey = (typeof AI_ORCHESTRATION_ROLES)[number];

export const AI_ORCHESTRATION_VERSION = 'grounded-multi-model-v1';
const ALL_PROVIDER_KEYS = ['openai', 'anthropic', 'gemini'] as const;

export type AiOrchestrationPolicyStep = Readonly<{
  allowedModelKeys: 'registry-approved';
  allowedProviderKeys: readonly string[];
  index: number;
  maxAttemptsPolicyKey: 'provider-bounded-retry-v1';
  required: boolean;
  role: AiOrchestrationRoleKey;
  stage: number;
}>;

export type AiOrchestrationPolicy = Readonly<{
  key: string;
  mode: AiOrchestrationModeKey;
  steps: readonly AiOrchestrationPolicyStep[];
  version: string;
}>;

function step(
  index: number,
  stage: number,
  role: AiOrchestrationRoleKey,
  required: boolean,
): AiOrchestrationPolicyStep {
  return Object.freeze({
    allowedModelKeys: 'registry-approved' as const,
    allowedProviderKeys: ALL_PROVIDER_KEYS,
    index,
    maxAttemptsPolicyKey: 'provider-bounded-retry-v1' as const,
    required,
    role,
    stage,
  });
}

const policies: Readonly<Record<AiOrchestrationModeKey, AiOrchestrationPolicy>> = Object.freeze({
  FAST: Object.freeze({
    key: 'skyos.fast',
    mode: 'FAST',
    steps: Object.freeze([step(0, 0, 'CANDIDATE', true)]),
    version: '1.0.0',
  }),
  BALANCED: Object.freeze({
    key: 'skyos.balanced',
    mode: 'BALANCED',
    steps: Object.freeze([
      step(0, 0, 'CANDIDATE', true),
      step(1, 0, 'CANDIDATE', true),
      step(2, 1, 'SYNTHESIZER', true),
    ]),
    version: '1.0.0',
  }),
  DEEP: Object.freeze({
    key: 'skyos.deep',
    mode: 'DEEP',
    steps: Object.freeze([
      step(0, 0, 'CANDIDATE', true),
      step(1, 0, 'CANDIDATE', true),
      step(2, 1, 'CRITIC', true),
      step(3, 1, 'VERIFIER', true),
      step(4, 2, 'SYNTHESIZER', true),
    ]),
    version: '1.0.0',
  }),
  CRITICAL: Object.freeze({
    key: 'skyos.critical',
    mode: 'CRITICAL',
    steps: Object.freeze([
      step(0, 0, 'CANDIDATE', true),
      step(1, 0, 'CANDIDATE', true),
      step(2, 0, 'CANDIDATE', true),
      step(3, 1, 'CRITIC', true),
      step(4, 1, 'VERIFIER', true),
      step(5, 2, 'SYNTHESIZER', true),
    ]),
    version: '1.0.0',
  }),
});

export function getAiOrchestrationPolicy(mode: AiOrchestrationModeKey): AiOrchestrationPolicy {
  return policies[mode];
}

export function getAiOrchestrationPolicyStep(
  policy: AiOrchestrationPolicy,
  stepIndex: number,
  role: AiOrchestrationRoleKey,
  provider: LanguageModelProviderDescriptor,
): AiOrchestrationPolicyStep | undefined {
  const candidate = policy.steps.find((item) => item.index === stepIndex && item.role === role);
  if (!candidate || !candidate.allowedProviderKeys.includes(provider.providerKey)) return undefined;
  return candidate;
}

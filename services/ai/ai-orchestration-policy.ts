import {
  LanguageModelProviderError,
  type LanguageModelProviderDescriptor,
  type LanguageModelProviderRegistry,
} from './language-model-provider';

export const AI_ORCHESTRATION_MODES = ['FAST', 'BALANCED', 'DEEP', 'CRITICAL'] as const;
export type AiOrchestrationModeKey = (typeof AI_ORCHESTRATION_MODES)[number];

export const AI_ORCHESTRATION_ROLES = ['CANDIDATE', 'CRITIC', 'VERIFIER', 'SYNTHESIZER'] as const;
export type AiOrchestrationRoleKey = (typeof AI_ORCHESTRATION_ROLES)[number];

export type AiOrchestrationProviderIdentity = Readonly<
  Pick<LanguageModelProviderDescriptor, 'modelKey' | 'modelVersion' | 'providerKey'>
>;

export type BalancedAiProviderAssignment = Readonly<{
  candidates: readonly [AiOrchestrationProviderIdentity, AiOrchestrationProviderIdentity];
  synthesizer: AiOrchestrationProviderIdentity;
}>;

export type BalancedAiRuntimeConfiguration = Readonly<{
  candidateA: AiOrchestrationProviderIdentity;
  candidateB: AiOrchestrationProviderIdentity;
  synthesizer: AiOrchestrationProviderIdentity;
}>;

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
  allowDegradedSynthesis: boolean;
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
    allowDegradedSynthesis: false,
    key: 'skyos.fast',
    mode: 'FAST',
    steps: Object.freeze([step(0, 0, 'CANDIDATE', true)]),
    version: '1.0.0',
  }),
  BALANCED: Object.freeze({
    allowDegradedSynthesis: true,
    key: 'skyos.balanced',
    mode: 'BALANCED',
    steps: Object.freeze([
      step(0, 0, 'CANDIDATE', true),
      step(1, 0, 'CANDIDATE', true),
      step(2, 1, 'SYNTHESIZER', true),
    ]),
    version: '1.1.0',
  }),
  DEEP: Object.freeze({
    allowDegradedSynthesis: false,
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
    allowDegradedSynthesis: false,
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

function configuredIdentity(
  providers: LanguageModelProviderRegistry,
  identity: AiOrchestrationProviderIdentity,
): AiOrchestrationProviderIdentity {
  const provider = providers.getVersion(
    identity.providerKey.trim(),
    identity.modelKey.trim(),
    identity.modelVersion.trim(),
  );
  return Object.freeze({
    modelKey: provider.modelKey,
    modelVersion: provider.modelVersion,
    providerKey: provider.providerKey,
  });
}

function runtimeConfiguration(environment: NodeJS.ProcessEnv): BalancedAiRuntimeConfiguration {
  const identity = (prefix: string): AiOrchestrationProviderIdentity => {
    const providerKey = environment[`${prefix}_PROVIDER`]?.trim();
    const modelKey = environment[`${prefix}_MODEL`]?.trim();
    const modelVersion = environment[`${prefix}_MODEL_VERSION`]?.trim();
    if (!providerKey || !modelKey || !modelVersion) {
      throw new LanguageModelProviderError(
        'The BALANCED provider assignment is incomplete.',
        'provider_configuration_invalid',
      );
    }
    return { modelKey, modelVersion, providerKey };
  };
  return {
    candidateA: identity('AI_BALANCED_CANDIDATE_A'),
    candidateB: identity('AI_BALANCED_CANDIDATE_B'),
    synthesizer: identity('AI_BALANCED_SYNTHESIZER'),
  };
}

export function resolveBalancedAiProviderAssignment(
  providers: LanguageModelProviderRegistry,
  configuration: BalancedAiRuntimeConfiguration = runtimeConfiguration(process.env),
): BalancedAiProviderAssignment {
  const assignment = Object.freeze({
    candidates: Object.freeze([
      configuredIdentity(providers, configuration.candidateA),
      configuredIdentity(providers, configuration.candidateB),
    ]) as readonly [AiOrchestrationProviderIdentity, AiOrchestrationProviderIdentity],
    synthesizer: configuredIdentity(providers, configuration.synthesizer),
  });
  const policy = getAiOrchestrationPolicy('BALANCED');
  for (const [index, provider] of assignment.candidates.entries()) {
    if (
      !getAiOrchestrationPolicyStep(
        policy,
        index,
        'CANDIDATE',
        providers.getVersion(provider.providerKey, provider.modelKey, provider.modelVersion),
      )
    ) {
      throw new LanguageModelProviderError(
        'The BALANCED candidate assignment is not permitted by policy.',
        'provider_configuration_invalid',
      );
    }
  }
  if (
    !getAiOrchestrationPolicyStep(
      policy,
      2,
      'SYNTHESIZER',
      providers.getVersion(
        assignment.synthesizer.providerKey,
        assignment.synthesizer.modelKey,
        assignment.synthesizer.modelVersion,
      ),
    )
  ) {
    throw new LanguageModelProviderError(
      'The BALANCED synthesizer assignment is not permitted by policy.',
      'provider_configuration_invalid',
    );
  }
  return assignment;
}

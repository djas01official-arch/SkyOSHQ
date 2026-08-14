import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_ORCHESTRATION_MODES,
  AI_ORCHESTRATION_ROLES,
  getAiOrchestrationPolicy,
  getAiOrchestrationPolicyStep,
  resolveBalancedAiProviderAssignment,
} from './ai-orchestration-policy';
import {
  LanguageModelProviderRegistry,
  type LanguageModelProvider,
} from './language-model-provider';

const providers = [
  ['openai', 'gpt-5.6-terra', 'responses-json-schema-v1'],
  ['anthropic', 'claude-sonnet-5', 'messages-json-schema-v1'],
  ['gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1'],
] as const;

test('defines immutable FAST, BALANCED, DEEP, and CRITICAL policy identities', () => {
  assert.deepEqual(AI_ORCHESTRATION_MODES, ['FAST', 'BALANCED', 'DEEP', 'CRITICAL']);
  assert.deepEqual(AI_ORCHESTRATION_ROLES, ['CANDIDATE', 'CRITIC', 'VERIFIER', 'SYNTHESIZER']);
  for (const mode of AI_ORCHESTRATION_MODES) {
    const policy = getAiOrchestrationPolicy(mode);
    assert.equal(policy.mode, mode);
    assert.match(policy.key, /^skyos\./u);
    assert.match(policy.version, /^\d+\.\d+\.\d+$/u);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.steps));
  }
});

test('provider identity and orchestration role remain independent dimensions', () => {
  const policy = getAiOrchestrationPolicy('DEEP');
  for (const [providerKey, modelKey, modelVersion] of providers) {
    for (const [index, role] of [
      [0, 'CANDIDATE'],
      [2, 'CRITIC'],
      [3, 'VERIFIER'],
      [4, 'SYNTHESIZER'],
    ] as const) {
      assert.ok(
        getAiOrchestrationPolicyStep(policy, index, role, {
          maxInputCharacters: 20_000,
          maxOutputCharacters: 2_000,
          modelKey,
          modelVersion,
          providerKey,
          timeoutMs: 45_000,
        }),
      );
    }
  }
});

test('BALANCED explicitly permits degraded synthesis from one successful candidate', () => {
  assert.equal(getAiOrchestrationPolicy('BALANCED').allowDegradedSynthesis, true);
  assert.equal(getAiOrchestrationPolicy('FAST').allowDegradedSynthesis, false);
  assert.equal(getAiOrchestrationPolicy('DEEP').allowDegradedSynthesis, false);
  assert.equal(getAiOrchestrationPolicy('CRITICAL').allowDegradedSynthesis, false);
});

test('runtime BALANCED assignment resolves two candidates and one synthesizer', () => {
  const registered = providers.map(
    ([providerKey, modelKey, modelVersion]): LanguageModelProvider => ({
      generate: async () => ({ citationIds: [], text: 'Offline.' }),
      maxInputCharacters: 20_000,
      maxOutputCharacters: 2_000,
      modelKey,
      modelVersion,
      providerKey,
      timeoutMs: 3_000,
    }),
  );
  const registry = new LanguageModelProviderRegistry(registered[0]!, registered.slice(1));
  const assignment = resolveBalancedAiProviderAssignment(registry, {
    candidateA: registered[2]!,
    candidateB: registered[0]!,
    synthesizer: registered[1]!,
  });
  assert.deepEqual(
    assignment.candidates.map(({ providerKey }) => providerKey),
    ['gemini', 'openai'],
  );
  assert.equal(assignment.synthesizer.providerKey, 'anthropic');
  assert.ok(Object.isFrozen(assignment));
  assert.ok(Object.isFrozen(assignment.candidates));
});

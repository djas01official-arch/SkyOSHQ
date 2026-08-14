import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_ORCHESTRATION_MODES,
  AI_ORCHESTRATION_ROLES,
  getAiOrchestrationPolicy,
  getAiOrchestrationPolicyStep,
} from './ai-orchestration-policy';

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

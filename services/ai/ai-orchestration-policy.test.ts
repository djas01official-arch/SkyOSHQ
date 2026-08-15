import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_ORCHESTRATION_MODES,
  AI_ORCHESTRATION_ROLES,
  getAiOrchestrationPolicy,
  getAiOrchestrationPolicyStep,
  resolveBalancedAiProviderAssignment,
  resolveDeepAiProviderAssignment,
} from './ai-orchestration-policy';
import {
  LanguageModelProviderError,
  LanguageModelProviderRegistry,
  type LanguageModelProvider,
} from './language-model-provider';

const providers = [
  ['openai', 'gpt-5.6-terra', 'responses-json-schema-v1'],
  ['anthropic', 'claude-sonnet-5', 'messages-json-schema-v1'],
  ['gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1'],
] as const;

function registeredProviders(): LanguageModelProvider[] {
  return providers.map(([providerKey, modelKey, modelVersion]): LanguageModelProvider => ({
    generate: async () => ({ citationIds: [], text: 'Offline.' }),
    maxInputCharacters: 20_000,
    maxOutputCharacters: 2_000,
    modelKey,
    modelVersion,
    providerKey,
    timeoutMs: 3_000,
  }));
}

function providerRegistry(registered = registeredProviders()): LanguageModelProviderRegistry {
  return new LanguageModelProviderRegistry(registered[0]!, registered.slice(1));
}

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
      [1, 'CANDIDATE'],
      [2, 'CANDIDATE'],
      [3, 'CRITIC'],
      [4, 'VERIFIER'],
      [5, 'SYNTHESIZER'],
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

test('BALANCED policy remains the three-step version 1.1 contract', () => {
  const policy = getAiOrchestrationPolicy('BALANCED');
  assert.equal(policy.version, '1.1.0');
  assert.deepEqual(
    policy.steps.map(({ index, role, stage }) => ({ index, role, stage })),
    [
      { index: 0, role: 'CANDIDATE', stage: 0 },
      { index: 1, role: 'CANDIDATE', stage: 0 },
      { index: 2, role: 'SYNTHESIZER', stage: 1 },
    ],
  );
});

test('DEEP policy defines three candidates, critic, verifier, and synthesizer in order', () => {
  const policy = getAiOrchestrationPolicy('DEEP');
  assert.equal(policy.version, '1.1.0');
  assert.equal(policy.steps.length, 6);
  assert.deepEqual(
    policy.steps.map(({ index, role, stage }) => ({ index, role, stage })),
    [
      { index: 0, role: 'CANDIDATE', stage: 0 },
      { index: 1, role: 'CANDIDATE', stage: 0 },
      { index: 2, role: 'CANDIDATE', stage: 0 },
      { index: 3, role: 'CRITIC', stage: 1 },
      { index: 4, role: 'VERIFIER', stage: 2 },
      { index: 5, role: 'SYNTHESIZER', stage: 3 },
    ],
  );
  assert.deepEqual(
    policy.steps.filter(({ role }) => role === 'SYNTHESIZER').map(({ index }) => index),
    [5],
  );
});

test('BALANCED explicitly permits degraded synthesis from one successful candidate', () => {
  assert.equal(getAiOrchestrationPolicy('BALANCED').allowDegradedSynthesis, true);
  assert.equal(getAiOrchestrationPolicy('FAST').allowDegradedSynthesis, false);
  assert.equal(getAiOrchestrationPolicy('DEEP').allowDegradedSynthesis, false);
  assert.equal(getAiOrchestrationPolicy('CRITICAL').allowDegradedSynthesis, false);
});

test('runtime BALANCED assignment resolves two candidates and one synthesizer', () => {
  const registered = registeredProviders();
  const registry = providerRegistry(registered);
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

test('runtime DEEP assignment resolves six explicit provider identities', () => {
  const registered = registeredProviders();
  const assignment = resolveDeepAiProviderAssignment(providerRegistry(registered), {
    candidateA: registered[0]!,
    candidateB: registered[1]!,
    candidateC: registered[2]!,
    critic: registered[2]!,
    synthesizer: registered[1]!,
    verifier: registered[0]!,
  });
  assert.deepEqual(
    assignment.candidates.map(({ providerKey }) => providerKey),
    ['openai', 'anthropic', 'gemini'],
  );
  assert.equal(assignment.critic.providerKey, 'gemini');
  assert.equal(assignment.verifier.providerKey, 'openai');
  assert.equal(assignment.synthesizer.providerKey, 'anthropic');
  assert.deepEqual(assignment.critic, {
    modelKey: 'gemini-3.6-flash',
    modelVersion: 'interactions-json-schema-v1',
    providerKey: 'gemini',
  });
  assert.ok(Object.isFrozen(assignment));
  assert.ok(Object.isFrozen(assignment.candidates));
});

test('DEEP runtime environment parses every explicit assignment', () => {
  const prefixes = [
    'AI_DEEP_CANDIDATE_A',
    'AI_DEEP_CANDIDATE_B',
    'AI_DEEP_CANDIDATE_C',
    'AI_DEEP_CRITIC',
    'AI_DEEP_VERIFIER',
    'AI_DEEP_SYNTHESIZER',
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const [index, prefix] of prefixes.entries()) {
    const [providerKey, modelKey, modelVersion] = providers[index % providers.length]!;
    for (const [suffix, value] of [
      ['PROVIDER', providerKey],
      ['MODEL', modelKey],
      ['MODEL_VERSION', modelVersion],
    ] as const) {
      const name = `${prefix}_${suffix}`;
      previous.set(name, process.env[name]);
      process.env[name] = value;
    }
  }
  try {
    const assignment = resolveDeepAiProviderAssignment(providerRegistry());
    assert.deepEqual(
      assignment.candidates.map(({ providerKey }) => providerKey),
      ['openai', 'anthropic', 'gemini'],
    );
    assert.equal(assignment.critic.providerKey, 'openai');
    assert.equal(assignment.verifier.providerKey, 'anthropic');
    assert.equal(assignment.synthesizer.providerKey, 'gemini');

    delete process.env.AI_DEEP_VERIFIER_MODEL_VERSION;
    assert.throws(
      () => resolveDeepAiProviderAssignment(providerRegistry()),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('DEEP runtime assignment rejects identities absent from the registry', () => {
  const registered = registeredProviders();
  assert.throws(
    () =>
      resolveDeepAiProviderAssignment(providerRegistry(registered), {
        candidateA: { ...registered[0]!, providerKey: 'unknown' },
        candidateB: registered[1]!,
        candidateC: registered[2]!,
        critic: registered[0]!,
        synthesizer: registered[2]!,
        verifier: registered[1]!,
      }),
    (error: unknown) =>
      error instanceof LanguageModelProviderError &&
      error.code === 'provider_configuration_invalid',
  );
});

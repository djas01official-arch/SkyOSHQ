import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDefaultLanguageModelProviderRegistry,
  DeterministicFakeLanguageModelProvider,
  LanguageModelProviderError,
  LanguageModelProviderRegistry,
  type LanguageModelRequest,
} from './language-model-provider';

const request: LanguageModelRequest = {
  citations: [],
  context: '',
  history: [],
  userMessage: 'hello',
};

test('the deterministic provider supports explicit success and failure scenarios', async () => {
  const success = new DeterministicFakeLanguageModelProvider();
  assert.match((await success.generate(request)).text, /No grounded Knowledge context/u);

  const failure = new DeterministicFakeLanguageModelProvider({ failureMessage: 'fail safely' });
  await assert.rejects(
    failure.generate({ ...request, userMessage: 'fail safely' }),
    (error: unknown) =>
      error instanceof LanguageModelProviderError && error.code === 'provider_unavailable',
  );
});

test('production prohibits the deterministic local provider', async () => {
  const provider = createDefaultLanguageModelProviderRegistry({
    configuredProvider: 'local',
    runtime: 'production',
  }).getCurrent();

  assert.equal(provider.providerKey, 'unconfigured');
  await assert.rejects(
    provider.generate(request),
    (error: unknown) =>
      error instanceof LanguageModelProviderError && error.code === 'provider_not_configured',
  );
});

test('production selects only explicitly configured providers and never falls back', async () => {
  const openAiRegistry = createDefaultLanguageModelProviderRegistry({
    chatMode: 'FAST',
    configuredProvider: 'openai',
    model: 'gpt-5.6-terra',
    openAiApiKey: 'production-secret-shaped-value',
    runtime: 'production',
  });
  const configured = openAiRegistry.getCurrent();
  assert.equal(configured.providerKey, 'openai');
  assert.equal(configured.modelKey, 'gpt-5.6-terra');
  assert.equal(openAiRegistry.list().length, 1);

  const anthropicRegistry = createDefaultLanguageModelProviderRegistry({
    anthropicApiKey: 'production-secret-shaped-value',
    chatMode: 'FAST',
    configuredProvider: 'anthropic',
    model: 'claude-sonnet-5',
    runtime: 'production',
  });
  const anthropic = anthropicRegistry.getCurrent();
  assert.equal(anthropic.providerKey, 'anthropic');
  assert.equal(anthropic.modelKey, 'claude-sonnet-5');
  assert.equal(anthropicRegistry.list().length, 2);

  const geminiRegistry = createDefaultLanguageModelProviderRegistry({
    chatMode: 'FAST',
    configuredProvider: 'gemini',
    geminiApiKey: 'production-secret-shaped-value',
    model: 'gemini-3.6-flash',
    runtime: 'production',
  });
  const gemini = geminiRegistry.getCurrent();
  assert.equal(gemini.providerKey, 'gemini');
  assert.equal(gemini.modelKey, 'gemini-3.6-flash');
  assert.equal(geminiRegistry.list().length, 1);

  const vertexGeminiRegistry = createDefaultLanguageModelProviderRegistry({
    chatMode: 'FAST',
    configuredProvider: 'gemini',
    geminiTransport: 'vertex',
    googleCloudLocation: 'global',
    googleCloudProject: 'skyos-test-project',
    model: 'gemini-3.6-flash',
    runtime: 'production',
  });
  assert.equal(vertexGeminiRegistry.getCurrent().providerKey, 'gemini');
  assert.equal(vertexGeminiRegistry.getCurrent().modelKey, 'gemini-3.6-flash');

  for (const options of [
    { configuredProvider: '', model: 'gpt-5.6-terra', openAiApiKey: 'valid-value' },
    { configuredProvider: 'unknown', model: 'gpt-5.6-terra', openAiApiKey: 'valid-value' },
    { configuredProvider: 'openai', model: 'gpt-5.6', openAiApiKey: 'valid-value' },
    { configuredProvider: 'openai', model: 'gpt-5.6-terra', openAiApiKey: '   ' },
    {
      configuredProvider: 'openai',
      model: 'gpt-5.6-terra',
      openAiApiKey: '<server-secret>',
    },
    {
      anthropicApiKey: 'valid-value',
      configuredProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
    },
    {
      anthropicApiKey: '<server-secret>',
      configuredProvider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    {
      configuredProvider: 'gemini',
      geminiApiKey: 'valid-value',
      model: 'gemini-3.7-flash',
    },
    {
      configuredProvider: 'gemini',
      geminiApiKey: '<server-secret>',
      model: 'gemini-3.6-flash',
    },
    {
      configuredProvider: 'gemini',
      geminiTransport: 'vertex',
      googleCloudLocation: 'global',
      model: 'gemini-3.6-flash',
    },
    {
      configuredProvider: 'gemini',
      geminiTransport: 'vertex',
      googleCloudProject: 'skyos-test-project',
      model: 'gemini-3.6-flash',
    },
  ]) {
    const unavailable = createDefaultLanguageModelProviderRegistry({
      ...options,
      runtime: 'production',
    }).getCurrent();
    assert.equal(unavailable.providerKey, 'unconfigured');
    await assert.rejects(
      unavailable.generate(request),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
  }
});

test('BALANCED production registry resolves every approved cross-provider identity', () => {
  const expectedIdentities = [
    'anthropic/claude-sonnet-4-6/messages-json-schema-v1',
    'anthropic/claude-sonnet-5/messages-json-schema-v1',
    'gemini/gemini-3.6-flash/interactions-json-schema-v1',
    'openai/gpt-5.6-terra/responses-json-schema-v1',
  ];
  for (const [configuredProvider, model] of [
    ['openai', 'gpt-5.6-terra'],
    ['anthropic', 'claude-sonnet-5'],
    ['gemini', 'gemini-3.6-flash'],
  ] as const) {
    const registry = createDefaultLanguageModelProviderRegistry({
      anthropicApiKey: 'production-secret-shaped-value',
      chatMode: 'BALANCED',
      configuredProvider,
      geminiApiKey: 'production-secret-shaped-value',
      model,
      openAiApiKey: 'production-secret-shaped-value',
      runtime: 'production',
    });
    assert.equal(registry.getCurrent().providerKey, configuredProvider);
    assert.equal(registry.getCurrent().modelKey, model);
    assert.deepEqual(
      registry
        .list()
        .map((provider) => `${provider.providerKey}/${provider.modelKey}/${provider.modelVersion}`)
        .sort(),
      expectedIdentities,
    );
    assert.equal(
      registry.getVersion('openai', 'gpt-5.6-terra', 'responses-json-schema-v1').providerKey,
      'openai',
    );
    assert.equal(
      registry.getVersion('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1').providerKey,
      'anthropic',
    );
    assert.equal(
      registry.getVersion('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1').providerKey,
      'gemini',
    );
  }
});

test('multi-provider registry accepts explicitly configured Vertex Gemini without a Developer API key', () => {
  const registry = createDefaultLanguageModelProviderRegistry({
    anthropicApiKey: 'production-secret-shaped-value',
    chatMode: 'BALANCED',
    configuredProvider: 'openai',
    geminiTransport: 'vertex',
    googleCloudLocation: 'global',
    googleCloudProject: 'skyos-test-project',
    model: 'gpt-5.6-terra',
    openAiApiKey: 'production-secret-shaped-value',
    runtime: 'production',
  });
  assert.equal(registry.getCurrent().providerKey, 'openai');
  assert.equal(
    registry.getVersion('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1').providerKey,
    'gemini',
  );
});

test('DEEP production registry resolves every approved cross-provider identity', () => {
  for (const [configuredProvider, model] of [
    ['openai', 'gpt-5.6-terra'],
    ['anthropic', 'claude-sonnet-5'],
    ['gemini', 'gemini-3.6-flash'],
  ] as const) {
    const registry = createDefaultLanguageModelProviderRegistry({
      anthropicApiKey: 'production-secret-shaped-value',
      chatMode: 'DEEP',
      configuredProvider,
      geminiApiKey: 'production-secret-shaped-value',
      model,
      openAiApiKey: 'production-secret-shaped-value',
      runtime: 'production',
    });
    assert.equal(registry.getCurrent().providerKey, configuredProvider);
    assert.equal(registry.getCurrent().modelKey, model);
    assert.equal(
      registry.getVersion('openai', 'gpt-5.6-terra', 'responses-json-schema-v1').providerKey,
      'openai',
    );
    assert.equal(
      registry.getVersion('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1').providerKey,
      'anthropic',
    );
    assert.equal(
      registry.getVersion('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1').providerKey,
      'gemini',
    );
  }
});

test('CRITICAL production registry resolves every approved cross-provider identity', () => {
  for (const [configuredProvider, model] of [
    ['openai', 'gpt-5.6-terra'],
    ['anthropic', 'claude-sonnet-5'],
    ['gemini', 'gemini-3.6-flash'],
  ] as const) {
    const registry = createDefaultLanguageModelProviderRegistry({
      anthropicApiKey: 'production-secret-shaped-value',
      chatMode: 'CRITICAL',
      configuredProvider,
      geminiApiKey: 'production-secret-shaped-value',
      model,
      openAiApiKey: 'production-secret-shaped-value',
      runtime: 'production',
    });
    assert.equal(registry.getCurrent().providerKey, configuredProvider);
    assert.equal(registry.getCurrent().modelKey, model);
    assert.equal(
      registry.getVersion('openai', 'gpt-5.6-terra', 'responses-json-schema-v1').providerKey,
      'openai',
    );
    assert.equal(
      registry.getVersion('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1').providerKey,
      'anthropic',
    );
    assert.equal(
      registry.getVersion('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1').providerKey,
      'gemini',
    );
  }
});

test('AUTO production registry resolves every approved cross-provider identity', () => {
  for (const [configuredProvider, model] of [
    ['openai', 'gpt-5.6-terra'],
    ['anthropic', 'claude-sonnet-5'],
    ['gemini', 'gemini-3.6-flash'],
  ] as const) {
    const registry = createDefaultLanguageModelProviderRegistry({
      anthropicApiKey: 'production-secret-shaped-value',
      chatMode: 'AUTO',
      configuredProvider,
      geminiApiKey: 'production-secret-shaped-value',
      model,
      openAiApiKey: 'production-secret-shaped-value',
      runtime: 'production',
    });
    assert.equal(registry.getCurrent().providerKey, configuredProvider);
    assert.equal(registry.getCurrent().modelKey, model);
    assert.equal(
      registry.getVersion('openai', 'gpt-5.6-terra', 'responses-json-schema-v1').providerKey,
      'openai',
    );
    assert.equal(
      registry.getVersion('anthropic', 'claude-sonnet-5', 'messages-json-schema-v1').providerKey,
      'anthropic',
    );
    assert.equal(
      registry.getVersion('gemini', 'gemini-3.6-flash', 'interactions-json-schema-v1').providerKey,
      'gemini',
    );
  }
});

test('BALANCED production registry fails closed when a required provider is unconfigured', async () => {
  for (const missing of ['openai', 'anthropic', 'gemini'] as const) {
    const registry = createDefaultLanguageModelProviderRegistry({
      anthropicApiKey: missing === 'anthropic' ? '   ' : 'production-secret-shaped-value',
      chatMode: 'BALANCED',
      configuredProvider: 'openai',
      geminiApiKey: missing === 'gemini' ? '   ' : 'production-secret-shaped-value',
      model: 'gpt-5.6-terra',
      openAiApiKey: missing === 'openai' ? '   ' : 'production-secret-shaped-value',
      runtime: 'production',
    });
    await assert.rejects(
      registry.getCurrent().generate(request),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
    assert.throws(
      () => registry.getVersion('openai', 'gpt-5.6-terra', 'responses-json-schema-v1'),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
  }
});

test('DEEP production registry fails closed when a required provider is unconfigured', async () => {
  for (const missing of ['openai', 'anthropic', 'gemini'] as const) {
    const registry = createDefaultLanguageModelProviderRegistry({
      anthropicApiKey: missing === 'anthropic' ? '   ' : 'production-secret-shaped-value',
      chatMode: 'DEEP',
      configuredProvider: 'openai',
      geminiApiKey: missing === 'gemini' ? '   ' : 'production-secret-shaped-value',
      model: 'gpt-5.6-terra',
      openAiApiKey: missing === 'openai' ? '   ' : 'production-secret-shaped-value',
      runtime: 'production',
    });
    await assert.rejects(
      registry.getCurrent().generate(request),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
    assert.throws(
      () => registry.getVersion('openai', 'gpt-5.6-terra', 'responses-json-schema-v1'),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
  }
});

test('CRITICAL production registry fails closed when a required provider is unconfigured', async () => {
  for (const missing of ['openai', 'anthropic', 'gemini'] as const) {
    const registry = createDefaultLanguageModelProviderRegistry({
      anthropicApiKey: missing === 'anthropic' ? '   ' : 'production-secret-shaped-value',
      chatMode: 'CRITICAL',
      configuredProvider: 'openai',
      geminiApiKey: missing === 'gemini' ? '   ' : 'production-secret-shaped-value',
      model: 'gpt-5.6-terra',
      openAiApiKey: missing === 'openai' ? '   ' : 'production-secret-shaped-value',
      runtime: 'production',
    });
    await assert.rejects(
      registry.getCurrent().generate(request),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
    assert.throws(
      () => registry.getVersion('openai', 'gpt-5.6-terra', 'responses-json-schema-v1'),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
  }
});

test('AUTO production registry fails closed when a potentially routed provider is unconfigured', async () => {
  const registry = createDefaultLanguageModelProviderRegistry({
    anthropicApiKey: '   ',
    chatMode: 'AUTO',
    configuredProvider: 'openai',
    geminiApiKey: 'production-secret-shaped-value',
    model: 'gpt-5.6-terra',
    openAiApiKey: 'production-secret-shaped-value',
    runtime: 'production',
  });
  await assert.rejects(
    registry.getCurrent().generate(request),
    (error: unknown) =>
      error instanceof LanguageModelProviderError &&
      error.code === 'provider_configuration_invalid',
  );
});

test('development local provider remains deterministic for orchestration modes', () => {
  for (const chatMode of ['AUTO', 'BALANCED', 'DEEP', 'CRITICAL'] as const) {
    const registry = createDefaultLanguageModelProviderRegistry({
      chatMode,
      configuredProvider: 'local',
      runtime: 'development',
    });
    assert.equal(registry.getCurrent().providerKey, 'local');
    assert.equal(registry.list().length, 1);
  }
});

test('Anthropic registry retains Sonnet 5 and 4.6 as separate approved versions', () => {
  const registry = createDefaultLanguageModelProviderRegistry({
    anthropicApiKey: 'production-secret-shaped-value',
    configuredProvider: 'anthropic',
    model: 'claude-sonnet-5',
    runtime: 'production',
  });
  assert.equal(registry.getCurrent().modelKey, 'claude-sonnet-5');
  assert.deepEqual(
    registry.list().map((provider) => provider.modelKey),
    ['claude-sonnet-5', 'claude-sonnet-4-6'],
  );
  assert.equal(
    registry.getVersion('anthropic', 'claude-sonnet-4-6', 'messages-json-schema-v1').modelKey,
    'claude-sonnet-4-6',
  );
});

test('the registry can retain peer provider versions without changing the selected backend', () => {
  const current = new DeterministicFakeLanguageModelProvider();
  const peer = {
    ...current,
    generate: current.generate.bind(current),
    modelKey: 'peer-model',
    modelVersion: '1.0.0',
    providerKey: 'peer',
  };
  const registry = new LanguageModelProviderRegistry(current, [peer]);

  assert.equal(registry.getCurrent(), current);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.getVersion('peer', 'peer-model', '1.0.0'), peer);
  assert.throws(
    () => registry.getVersion('missing', 'missing', '1.0.0'),
    (error: unknown) =>
      error instanceof LanguageModelProviderError && error.code === 'provider_not_configured',
  );
});

test('non-production OpenAI selection requires an explicitly injected offline transport', async () => {
  const provider = createDefaultLanguageModelProviderRegistry({
    configuredProvider: 'openai',
    model: 'gpt-5.6-terra',
    openAiApiKey: 'offline-test-value',
    runtime: 'test',
  }).getCurrent();
  assert.equal(provider.providerKey, 'unconfigured');
  await assert.rejects(
    provider.generate(request),
    (error: unknown) =>
      error instanceof LanguageModelProviderError && error.code === 'provider_network_disabled',
  );
});

test('non-production Anthropic selection requires an explicitly injected offline transport', async () => {
  const provider = createDefaultLanguageModelProviderRegistry({
    anthropicApiKey: 'offline-test-value',
    configuredProvider: 'anthropic',
    model: 'claude-sonnet-4-6',
    runtime: 'test',
  }).getCurrent();
  assert.equal(provider.providerKey, 'unconfigured');
  await assert.rejects(
    provider.generate(request),
    (error: unknown) =>
      error instanceof LanguageModelProviderError && error.code === 'provider_network_disabled',
  );
});

test('non-production Gemini selection requires an explicitly injected offline transport', async () => {
  const provider = createDefaultLanguageModelProviderRegistry({
    configuredProvider: 'gemini',
    geminiApiKey: 'offline-test-value',
    model: 'gemini-3.6-flash',
    runtime: 'test',
  }).getCurrent();
  assert.equal(provider.providerKey, 'unconfigured');
  await assert.rejects(
    provider.generate(request),
    (error: unknown) =>
      error instanceof LanguageModelProviderError && error.code === 'provider_network_disabled',
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDefaultLanguageModelProviderRegistry,
  DeterministicFakeLanguageModelProvider,
  LanguageModelProviderError,
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

test('production selects only explicitly configured OpenAI and never falls back', async () => {
  const configured = createDefaultLanguageModelProviderRegistry({
    configuredProvider: 'openai',
    model: 'gpt-5.6-terra',
    openAiApiKey: 'production-secret-shaped-value',
    runtime: 'production',
  }).getCurrent();
  assert.equal(configured.providerKey, 'openai');
  assert.equal(configured.modelKey, 'gpt-5.6-terra');

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

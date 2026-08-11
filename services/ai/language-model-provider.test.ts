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

test('production uses an unavailable provider until a real adapter is installed', async () => {
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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSkyosAuthProviders } from './auth-providers';
import { isDevelopmentCredentialsEnabled } from './development-credentials';

function providerIds(runtime: unknown): string[] {
  return createSkyosAuthProviders(async () => null, runtime).map((provider) => provider.id);
}

test('development and test runtimes enable development Credentials authentication', () => {
  assert.equal(isDevelopmentCredentialsEnabled('development'), true);
  assert.equal(isDevelopmentCredentialsEnabled('test'), true);
  assert.deepEqual(providerIds('development'), ['credentials']);
  assert.deepEqual(providerIds('test'), ['credentials']);
});

test('production and unknown runtimes fail closed for development Credentials authentication', () => {
  assert.equal(isDevelopmentCredentialsEnabled('production'), false);
  assert.equal(isDevelopmentCredentialsEnabled(undefined), false);
  assert.equal(isDevelopmentCredentialsEnabled('staging'), false);
  assert.equal(isDevelopmentCredentialsEnabled({ runtime: 'development' }), false);
});

test('production Auth.js configuration has no Credentials provider or callback endpoint', () => {
  const providers = createSkyosAuthProviders(async () => null, 'production');

  assert.deepEqual(providers, []);
  assert.equal(providerIds('production').includes('credentials'), false);
});

test('unknown runtime Auth.js configuration has no Credentials provider or callback endpoint', () => {
  const providers = createSkyosAuthProviders(async () => null, 'preview');

  assert.deepEqual(providers, []);
  assert.equal(providerIds('preview').includes('credentials'), false);
});

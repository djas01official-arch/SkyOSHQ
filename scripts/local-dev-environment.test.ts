import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getLocalDevelopmentEnvironmentDiagnostics,
  loadAuthoritativeLocalDevelopmentEnvironment,
  LocalDevelopmentEnvironmentError,
} from './local-dev-environment';

const ROOT_ENVIRONMENT = [
  'DATABASE_URL=postgresql://root-only-value',
  'AUTH_SECRET=root-secret-only-value',
  'AUTH_DEV_EMAIL=developer@example.test',
  'AUTH_DEV_PASSWORD=root-password-only-value',
].join('\n');

function load(options: Parameters<typeof loadAuthoritativeLocalDevelopmentEnvironment>[0] = {}) {
  return loadAuthoritativeLocalDevelopmentEnvironment({
    inheritedEnvironment: {
      DATABASE_URL: 'postgresql://stale-shell-value',
      AUTH_DEV_EMAIL: 'stale@example.test',
      OS_ENVIRONMENT_TO_PRESERVE: 'preserved',
    },
    readFile: () => ROOT_ENVIRONMENT,
    repositoryRoot: 'C:/skyos',
    ...options,
  });
}

test('root .env values override stale inherited values while unrelated OS values remain available', () => {
  const loaded = load();

  assert.equal(loaded.environment.DATABASE_URL, 'postgresql://root-only-value');
  assert.equal(loaded.environment.AUTH_DEV_EMAIL, 'developer@example.test');
  assert.equal(loaded.environment.OS_ENVIRONMENT_TO_PRESERVE, 'preserved');
  assert.equal(loaded.environmentPath, 'C:\\skyos\\.env');
});

test('missing root .env fails closed without revealing inherited secrets', () => {
  assert.throws(
    () =>
      load({
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    (error: unknown) =>
      error instanceof LocalDevelopmentEnvironmentError &&
      error.code === 'local_development_environment_missing' &&
      !error.message.includes('stale-shell-value'),
  );
});

test('required root .env variables cannot be supplied by inherited shell values', () => {
  assert.throws(
    () =>
      load({
        readFile: () => ROOT_ENVIRONMENT.replace('AUTH_DEV_PASSWORD=root-password-only-value', ''),
      }),
    (error: unknown) =>
      error instanceof LocalDevelopmentEnvironmentError &&
      error.code === 'local_development_environment_invalid' &&
      error.message.includes('AUTH_DEV_PASSWORD') &&
      !error.message.includes('root-password-only-value'),
  );
});

test('local environment diagnostics expose names and presence only', () => {
  const diagnostics = getLocalDevelopmentEnvironmentDiagnostics();

  assert.deepEqual(diagnostics, [
    'DATABASE_URL: PRESENT',
    'AUTH_SECRET: PRESENT',
    'AUTH_DEV_EMAIL: PRESENT',
    'AUTH_DEV_PASSWORD: PRESENT',
  ]);
  assert.doesNotMatch(diagnostics.join('\n'), /root-(?:secret|password)-only-value/u);
});

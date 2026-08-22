import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthError } from 'next-auth';

import {
  attemptDevelopmentCredentialsLogin,
  CREDENTIALS_SIGN_IN_NOT_CONFIGURED,
} from './credential-login';

function credentialFormData(
  input: Partial<Record<'email' | 'password' | 'redirectTo', string>> = {},
) {
  const formData = new FormData();
  formData.set('email', input.email ?? 'developer@skyos.local');
  formData.set('password', input.password ?? 'correct-development-password');
  formData.set('redirectTo', input.redirectTo ?? '/settings');
  return formData;
}

test('development login invokes Auth.js Credentials sign-in and preserves a safe redirect', async () => {
  const calls: unknown[][] = [];
  const result = await attemptDevelopmentCredentialsLogin(credentialFormData(), {
    runtime: 'development',
    signIn: async (...args) => {
      calls.push(args);
    },
  });

  assert.deepEqual(calls, [
    [
      'credentials',
      {
        email: 'developer@skyos.local',
        password: 'correct-development-password',
        redirect: false,
      },
    ],
  ]);
  assert.deepEqual(result, { redirectTo: '/settings', status: 'success' });
});

test('production and unknown login attempts never call Auth.js Credentials sign-in', async () => {
  let signInCalls = 0;
  const signIn = async () => {
    signInCalls += 1;
  };

  for (const runtime of ['production', 'preview', undefined] as const) {
    const result = await attemptDevelopmentCredentialsLogin(credentialFormData(), {
      runtime,
      signIn,
    });
    assert.deepEqual(result, { error: CREDENTIALS_SIGN_IN_NOT_CONFIGURED, status: 'error' });
  }

  assert.equal(signInCalls, 0);
});

test('development login preserves malformed and invalid-credential errors', async () => {
  const malformed = await attemptDevelopmentCredentialsLogin(
    credentialFormData({ email: '', password: '' }),
    { runtime: 'development', signIn: async () => undefined },
  );
  assert.deepEqual(malformed, {
    error: 'Enter an email address and password.',
    status: 'error',
  });

  const invalid = await attemptDevelopmentCredentialsLogin(credentialFormData(), {
    runtime: 'development',
    signIn: async () => {
      throw new AuthError('CredentialsSignin');
    },
  });
  assert.deepEqual(invalid, {
    error: 'The email address or password is incorrect.',
    status: 'error',
  });
});

test('development login continues to reject unsafe redirects and rethrows unexpected errors', async () => {
  const unsafeRedirect = await attemptDevelopmentCredentialsLogin(
    credentialFormData({ redirectTo: 'https://attacker.example/collect' }),
    { runtime: 'development', signIn: async () => undefined },
  );
  assert.deepEqual(unsafeRedirect, { redirectTo: '/dashboard', status: 'success' });

  await assert.rejects(
    attemptDevelopmentCredentialsLogin(credentialFormData(), {
      runtime: 'development',
      signIn: async () => {
        throw new Error('unexpected authentication failure');
      },
    }),
    /unexpected authentication failure/u,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthError } from 'next-auth';

import { createSkyosAuthProviders } from './auth-providers';
import {
  getGoogleOidcConfiguration,
  getValidatedGoogleOidcIdentity,
  isGoogleOidcProviderEnabled,
} from './google-oidc';
import { attemptGoogleOidcSignIn, prepareGoogleOidcSignIn } from './google-login';

const googleConfiguration = {
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
};

function providerIds(runtime: unknown, configured = false): string[] {
  return createSkyosAuthProviders(async () => null, {
    googleOidcConfiguration: configured ? googleConfiguration : null,
    runtime,
  }).map((provider) => provider.id);
}

function validGoogleIdentity() {
  return {
    account: { provider: 'google', providerAccountId: 'google-subject-123', type: 'oidc' },
    profile: {
      email: 'operator@example.test',
      email_verified: true,
      sub: 'google-subject-123',
    },
  };
}

test('Google configuration requires both explicit non-blank server-only values', () => {
  assert.deepEqual(
    getGoogleOidcConfiguration({
      AUTH_GOOGLE_ID: 'client-id',
      AUTH_GOOGLE_SECRET: 'client-secret',
    }),
    { clientId: 'client-id', clientSecret: 'client-secret' },
  );
  assert.equal(getGoogleOidcConfiguration({ AUTH_GOOGLE_ID: 'client-id' }), null);
  assert.equal(getGoogleOidcConfiguration({ AUTH_GOOGLE_SECRET: 'client-secret' }), null);
  assert.equal(
    getGoogleOidcConfiguration({ AUTH_GOOGLE_ID: ' ', AUTH_GOOGLE_SECRET: 'secret' }),
    null,
  );
});

test('provider registration matrix preserves Credentials and fails closed without Google configuration', () => {
  assert.deepEqual(providerIds('development'), ['credentials']);
  assert.deepEqual(providerIds('test'), ['credentials']);
  assert.deepEqual(providerIds('production'), []);
  assert.deepEqual(providerIds('preview'), []);

  assert.deepEqual(providerIds('development', true), ['credentials', 'google']);
  assert.deepEqual(providerIds('test', true), ['credentials', 'google']);
  assert.deepEqual(providerIds('production', true), ['google']);
  assert.deepEqual(providerIds('preview', true), []);
});

test('Google provider never enables dangerous email account linking', () => {
  const google = createSkyosAuthProviders(async () => null, {
    googleOidcConfiguration: googleConfiguration,
    runtime: 'production',
  })[0] as {
    id: string;
    options?: { allowDangerousEmailAccountLinking?: boolean };
  };

  assert.equal(google.id, 'google');
  assert.equal(google.options?.allowDangerousEmailAccountLinking, false);
});

test('Google identity validation requires the exact verified OIDC subject binding shape', () => {
  const valid = validGoogleIdentity();
  assert.deepEqual(getValidatedGoogleOidcIdentity(valid.account, valid.profile), {
    email: 'operator@example.test',
    subject: 'google-subject-123',
  });

  assert.equal(getValidatedGoogleOidcIdentity(valid.account, { ...valid.profile, sub: '' }), null);
  assert.equal(
    getValidatedGoogleOidcIdentity(
      { ...valid.account, providerAccountId: 'different-subject' },
      valid.profile,
    ),
    null,
  );
  assert.equal(
    getValidatedGoogleOidcIdentity(valid.account, { ...valid.profile, email_verified: false }),
    null,
  );
  assert.equal(
    getValidatedGoogleOidcIdentity(valid.account, { ...valid.profile, email_verified: undefined }),
    null,
  );
  assert.equal(
    getValidatedGoogleOidcIdentity({ ...valid.account, provider: 'other' }, valid.profile),
    null,
  );
});

test('Google sign-in action preparation is configured-only and retains safe local redirects', () => {
  const safeForm = new FormData();
  safeForm.set('redirectTo', '/settings');
  assert.deepEqual(
    prepareGoogleOidcSignIn(safeForm, {
      configuration: googleConfiguration,
      runtime: 'production',
    }),
    { redirectTo: '/settings', status: 'ready' },
  );

  const unsafeForm = new FormData();
  unsafeForm.set('redirectTo', 'https://attacker.example/collect');
  assert.deepEqual(
    prepareGoogleOidcSignIn(unsafeForm, {
      configuration: googleConfiguration,
      runtime: 'production',
    }),
    { redirectTo: '/dashboard', status: 'ready' },
  );
  assert.deepEqual(
    prepareGoogleOidcSignIn(safeForm, { configuration: null, runtime: 'production' }),
    { error: 'Sign-in is not configured for this environment.', status: 'error' },
  );
  assert.equal(isGoogleOidcProviderEnabled('preview', googleConfiguration), false);
});

test('Google sign-in action uses the provider only after policy validation and keeps failures generic', async () => {
  const formData = new FormData();
  formData.set('redirectTo', '/dashboard');
  const calls: unknown[][] = [];
  const started = await attemptGoogleOidcSignIn(formData, {
    configuration: googleConfiguration,
    runtime: 'production',
    signIn: async (...args) => {
      calls.push(args);
    },
  });
  assert.deepEqual(calls, [['google', { redirectTo: '/dashboard' }]]);
  assert.deepEqual(started, { error: 'Sign-in could not be started.' });

  const denied = await attemptGoogleOidcSignIn(formData, {
    configuration: null,
    runtime: 'production',
    signIn: async () => {
      throw new Error('must not be called');
    },
  });
  assert.deepEqual(denied, { error: 'Sign-in is not configured for this environment.' });

  const failed = await attemptGoogleOidcSignIn(formData, {
    configuration: googleConfiguration,
    runtime: 'production',
    signIn: async () => {
      throw new AuthError('OAuthSignin');
    },
  });
  assert.deepEqual(failed, { error: 'Sign-in could not be started.' });

  await assert.rejects(
    attemptGoogleOidcSignIn(formData, {
      configuration: googleConfiguration,
      runtime: 'production',
      signIn: async () => {
        throw new Error('unexpected Google sign-in failure');
      },
    }),
    /unexpected Google sign-in failure/u,
  );
});

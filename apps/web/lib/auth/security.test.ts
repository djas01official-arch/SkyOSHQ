import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  DEFAULT_SIGN_IN_REDIRECT,
  getSafeSignInRedirect,
  getSessionCookie,
  hasAuthenticatedUser,
  requireAuthSecret,
} from './security';

test('authentication requires a non-placeholder secret with sufficient entropy capacity', () => {
  assert.throws(() => requireAuthSecret(undefined), /AUTH_SECRET/);
  assert.throws(() => requireAuthSecret('too-short'), /AUTH_SECRET/);
  assert.throws(() => requireAuthSecret('replace-with-a-local-random-secret'), /AUTH_SECRET/);
  assert.equal(
    requireAuthSecret('a-unique-auth-secret-containing-more-than-32-characters'),
    'a-unique-auth-secret-containing-more-than-32-characters',
  );
});

test('session cookies are inaccessible to scripts and secure in production', () => {
  assert.deepEqual(getSessionCookie(false), {
    name: 'authjs.session-token',
    options: {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: false,
    },
  });
  assert.deepEqual(getSessionCookie(true), {
    name: '__Secure-authjs.session-token',
    options: {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: true,
    },
  });
  assert.equal(AUTH_SESSION_MAX_AGE_SECONDS, 28_800);
});

test('only sessions with a stable internal user id pass route authorization', () => {
  assert.equal(hasAuthenticatedUser(undefined), false);
  assert.equal(hasAuthenticatedUser(null), false);
  assert.equal(hasAuthenticatedUser({ user: null }), false);
  assert.equal(hasAuthenticatedUser({ user: { id: '' } }), false);
  assert.equal(hasAuthenticatedUser({ user: { id: 'user-id' } }), true);
});

test('sign-in redirects accept local paths and reject unsafe destinations', () => {
  assert.equal(
    getSafeSignInRedirect('/knowledge/document-1?version=2#history'),
    '/knowledge/document-1?version=2#history',
  );

  for (const unsafeValue of [
    undefined,
    'dashboard',
    'https://attacker.example/path',
    '//attacker.example/path',
    '/\\attacker.example/path',
    '/%5c%5cattacker.example/path',
    '/dashboard%0d%0aLocation:https://attacker.example',
    '/login',
    '/login/again',
  ]) {
    assert.equal(getSafeSignInRedirect(unsafeValue), DEFAULT_SIGN_IN_REDIRECT);
  }
});

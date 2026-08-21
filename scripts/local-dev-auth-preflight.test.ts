import assert from 'node:assert/strict';
import { test } from 'node:test';

import argon2 from 'argon2';

import {
  LocalDevelopmentAuthPreflightError,
  verifyLocalDevelopmentCredentials,
} from './local-dev-auth-preflight';
import { UserStatus } from '../database/generated/client/client';

const ENVIRONMENT = {
  AUTH_DEV_EMAIL: 'developer@example.test',
  AUTH_DEV_PASSWORD: 'test-password',
};

async function expectSafeMismatch(
  findUserByEmail: Parameters<typeof verifyLocalDevelopmentCredentials>[1]['findUserByEmail'],
): Promise<void> {
  await assert.rejects(
    verifyLocalDevelopmentCredentials(ENVIRONMENT, {
      findUserByEmail,
      verifyPassword: async () => false,
    }),
    (error: unknown) =>
      error instanceof LocalDevelopmentAuthPreflightError &&
      error.code === 'local_development_auth_credentials_invalid' &&
      !error.message.includes(ENVIRONMENT.AUTH_DEV_EMAIL) &&
      !error.message.includes(ENVIRONMENT.AUTH_DEV_PASSWORD),
  );
}

test('matching local development credentials pass through read-only dependencies', async () => {
  const passwordHash = await argon2.hash(ENVIRONMENT.AUTH_DEV_PASSWORD, { type: argon2.argon2id });
  const calls: string[] = [];
  await verifyLocalDevelopmentCredentials(ENVIRONMENT, {
    findUserByEmail: async (email) => {
      calls.push(`find:${email}`);
      return { deletedAt: null, passwordHash, status: UserStatus.ACTIVE };
    },
    verifyPassword: async (hash, password) => {
      calls.push('verify');
      return argon2.verify(hash, password);
    },
  });

  assert.deepEqual(calls, ['find:developer@example.test', 'verify']);
});

test('missing, inactive, deleted, and hashless users fail safely without mutation capabilities', async () => {
  for (const user of [
    null,
    { deletedAt: new Date(), passwordHash: 'unused', status: UserStatus.ACTIVE },
    { deletedAt: null, passwordHash: 'unused', status: UserStatus.SUSPENDED },
    { deletedAt: null, passwordHash: null, status: UserStatus.ACTIVE },
  ]) {
    await expectSafeMismatch(async () => user);
  }
});

test('a password mismatch and unavailable database both use safe diagnostics', async () => {
  await expectSafeMismatch(async () => ({
    deletedAt: null,
    passwordHash: 'unused',
    status: UserStatus.ACTIVE,
  }));
  await assert.rejects(
    verifyLocalDevelopmentCredentials(ENVIRONMENT, {
      findUserByEmail: async () => {
        throw new Error('database connection string must remain secret');
      },
      verifyPassword: async () => true,
    }),
    (error: unknown) =>
      error instanceof LocalDevelopmentAuthPreflightError &&
      error.code === 'local_development_auth_unavailable' &&
      !error.message.includes('connection string'),
  );
});

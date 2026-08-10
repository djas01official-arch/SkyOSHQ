import argon2 from 'argon2';

import { UserStatus, type PrismaClient } from '../generated/client/client';

import { bootstrapOrganizationForFirstSignIn } from './bootstrap';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export type AuthenticatedUser = {
  email: string;
  id: string;
  image: string | null;
  name: string | null;
};

export type CredentialInput = Readonly<{
  email?: unknown;
  password?: unknown;
}>;

export type NormalizedCredentials = Readonly<{
  email: string;
  password: string;
}>;

function getEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL_PATTERN.test(email) ? email : null;
}

function getPassword(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : null;
}

export function normalizeCredentials(input: CredentialInput): NormalizedCredentials | null {
  const email = getEmail(input.email);
  const password = getPassword(input.password);

  return email && password ? { email, password } : null;
}

/**
 * Verifies development credentials without exposing whether a user or password was invalid.
 */
export async function authenticateCredentials(
  prisma: PrismaClient,
  input: CredentialInput,
): Promise<AuthenticatedUser | null> {
  const credentials = normalizeCredentials(input);

  if (!credentials) {
    return null;
  }

  const user = await prisma.user.findUnique({ where: { email: credentials.email } });

  if (
    !user ||
    !user.passwordHash ||
    user.deletedAt ||
    user.status !== UserStatus.ACTIVE ||
    !user.email
  ) {
    return null;
  }

  const passwordMatches = await argon2.verify(user.passwordHash, credentials.password);

  if (!passwordMatches) {
    return null;
  }

  await bootstrapOrganizationForFirstSignIn(prisma, user.id);

  return {
    email: user.email,
    id: user.id,
    image: user.image,
    name: user.name ?? user.displayName,
  };
}

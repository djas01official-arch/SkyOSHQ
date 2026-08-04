import argon2 from 'argon2';

import { UserStatus, type PrismaClient } from '../generated/client/client';

import { bootstrapOrganizationForFirstSignIn } from './bootstrap';

export type AuthenticatedUser = {
  email: string;
  id: string;
  image: string | null;
  name: string | null;
};

type CredentialInput = Readonly<{
  email?: unknown;
  password?: unknown;
}>;

function getEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 320 && email.includes('@') ? email : null;
}

function getPassword(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : null;
}

/**
 * Verifies development credentials without exposing whether a user or password was invalid.
 */
export async function authenticateCredentials(
  prisma: PrismaClient,
  input: CredentialInput,
): Promise<AuthenticatedUser | null> {
  const email = getEmail(input.email);
  const password = getPassword(input.password);

  if (!email || !password) {
    return null;
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (
    !user ||
    !user.passwordHash ||
    user.deletedAt ||
    user.status !== UserStatus.ACTIVE ||
    !user.email
  ) {
    return null;
  }

  const passwordMatches = await argon2.verify(user.passwordHash, password);

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

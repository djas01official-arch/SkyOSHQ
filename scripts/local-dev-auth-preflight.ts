import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient, UserStatus } from '../database/generated/client/client';

export class LocalDevelopmentAuthPreflightError extends Error {
  readonly code:
    'local_development_auth_credentials_invalid' | 'local_development_auth_unavailable';

  constructor(code: LocalDevelopmentAuthPreflightError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export type LocalDevelopmentAuthUser = Readonly<{
  deletedAt: Date | null;
  passwordHash: string | null;
  status: UserStatus;
}>;

export type LocalDevelopmentAuthPreflightDependencies = Readonly<{
  findUserByEmail(email: string): Promise<LocalDevelopmentAuthUser | null>;
  verifyPassword(passwordHash: string, password: string): Promise<boolean>;
}>;

function credentialsMismatch(): never {
  throw new LocalDevelopmentAuthPreflightError(
    'local_development_auth_credentials_invalid',
    'Local development credentials do not match the seeded database. Run: pnpm db:seed',
  );
}

/** Performs only a read and password verification; it never bootstraps or mutates tenancy data. */
export async function verifyLocalDevelopmentCredentials(
  environment: Readonly<{
    AUTH_DEV_EMAIL: string;
    AUTH_DEV_PASSWORD: string;
  }>,
  dependencies: LocalDevelopmentAuthPreflightDependencies,
): Promise<void> {
  let user: LocalDevelopmentAuthUser | null;
  try {
    user = await dependencies.findUserByEmail(environment.AUTH_DEV_EMAIL);
  } catch {
    throw new LocalDevelopmentAuthPreflightError(
      'local_development_auth_unavailable',
      'Local development credentials could not be checked because the database is unavailable.',
    );
  }

  if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE || !user.passwordHash) {
    credentialsMismatch();
  }

  try {
    if (!(await dependencies.verifyPassword(user.passwordHash, environment.AUTH_DEV_PASSWORD))) {
      credentialsMismatch();
    }
  } catch (error) {
    if (error instanceof LocalDevelopmentAuthPreflightError) throw error;
    credentialsMismatch();
  }
}

export async function runLocalDevelopmentAuthPreflight(
  environment: Readonly<{
    AUTH_DEV_EMAIL: string;
    AUTH_DEV_PASSWORD: string;
    DATABASE_URL: string;
  }>,
): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
  });
  try {
    await verifyLocalDevelopmentCredentials(environment, {
      findUserByEmail: (email) =>
        prisma.user.findUnique({
          select: { deletedAt: true, passwordHash: true, status: true },
          where: { email },
        }),
      verifyPassword: (passwordHash, password) => argon2.verify(passwordHash, password),
    });
  } finally {
    await prisma.$disconnect();
  }
}

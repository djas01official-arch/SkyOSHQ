import { UserStatus, type Prisma, type PrismaClient } from '../generated/client/client';

import { appendIdentityAuditEvent, IdentityAuditAction } from './identity-audit';

export const GOOGLE_PROVIDER_ID = 'google';
export const GOOGLE_ACCOUNT_TYPE = 'oidc';

const MAX_GOOGLE_SUBJECT_LENGTH = 512;

type GoogleAccount = Readonly<{
  provider?: unknown;
  providerAccountId?: unknown;
  type?: unknown;
}>;

type GoogleProfile = Readonly<{
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
}>;

type GoogleIdentityTransaction = Prisma.TransactionClient;

export type GoogleAdmissionResult =
  | Readonly<{ allowed: true; userId: string }>
  | Readonly<{ allowed: false; reason: 'inactive' | 'invalid' | 'unknown' }>;

export class GoogleIdentityBindingError extends Error {}

export class GoogleIdentityBindingConflictError extends GoogleIdentityBindingError {}

function getGoogleSubject(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GOOGLE_SUBJECT_LENGTH) {
    return null;
  }

  return value;
}

function getValidatedGoogleSubject(
  account: GoogleAccount | null | undefined,
  profile: GoogleProfile | null | undefined,
): string | null {
  const subject = getGoogleSubject(profile?.sub);

  if (
    !subject ||
    typeof profile?.email !== 'string' ||
    profile.email.trim().length === 0 ||
    profile.email_verified !== true ||
    account?.provider !== GOOGLE_PROVIDER_ID ||
    account.type !== GOOGLE_ACCOUNT_TYPE ||
    account.providerAccountId !== subject
  ) {
    return null;
  }

  return subject;
}

/**
 * Authoritative OAuth admission boundary. Auth.js calls this from `callbacks.signIn`
 * before its own `handleLoginOrRegister` path, so unknown identities cannot create
 * a User or Account through the Prisma adapter.
 */
export async function admitPreProvisionedGoogleIdentity(
  prisma: PrismaClient,
  input: Readonly<{
    account: GoogleAccount | null | undefined;
    profile: GoogleProfile | null | undefined;
  }>,
): Promise<GoogleAdmissionResult> {
  const subject = getValidatedGoogleSubject(input.account, input.profile);

  if (!subject) {
    await appendIdentityAuditEvent(prisma, {
      action: IdentityAuditAction.GOOGLE_SIGN_IN_REJECTED_INVALID,
      metadata: { reason: 'invalid_google_identity' },
      provider: GOOGLE_PROVIDER_ID,
      subject: null,
    });
    return { allowed: false, reason: 'invalid' };
  }

  const account = await prisma.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: GOOGLE_PROVIDER_ID,
        providerAccountId: subject,
      },
    },
    include: { user: true },
  });

  if (!account) {
    await appendIdentityAuditEvent(prisma, {
      action: IdentityAuditAction.GOOGLE_SIGN_IN_REJECTED_UNKNOWN,
      metadata: { reason: 'unknown_google_subject' },
      provider: GOOGLE_PROVIDER_ID,
      subject,
    });
    return { allowed: false, reason: 'unknown' };
  }

  if (account.user.status !== UserStatus.ACTIVE || account.user.deletedAt !== null) {
    await appendIdentityAuditEvent(prisma, {
      action: IdentityAuditAction.GOOGLE_SIGN_IN_REJECTED_INACTIVE,
      metadata: { reason: 'inactive_skyos_user' },
      provider: GOOGLE_PROVIDER_ID,
      subject,
      targetUserId: account.userId,
    });
    return { allowed: false, reason: 'inactive' };
  }

  return { allowed: true, userId: account.userId };
}

export async function recordGoogleIdentitySignInSuccess(
  prisma: PrismaClient,
  input: Readonly<{
    account: GoogleAccount | null | undefined;
    profile: GoogleProfile | null | undefined;
    userId: string;
  }>,
): Promise<void> {
  const subject = getValidatedGoogleSubject(input.account, input.profile);

  if (!subject) {
    throw new GoogleIdentityBindingError(
      'A successful Google sign-in must have a validated subject.',
    );
  }

  await appendIdentityAuditEvent(prisma, {
    action: IdentityAuditAction.GOOGLE_SIGN_IN_SUCCEEDED,
    actorUserId: input.userId,
    metadata: {},
    provider: GOOGLE_PROVIDER_ID,
    subject,
    targetUserId: input.userId,
  });
}

async function requireActiveUser(
  transaction: GoogleIdentityTransaction,
  userId: string,
): Promise<void> {
  const user = await transaction.user.findFirst({
    where: { deletedAt: null, id: userId, status: UserStatus.ACTIVE },
    select: { id: true },
  });

  if (!user) {
    throw new GoogleIdentityBindingError('The target or operator is not an active SkyOS user.');
  }
}

export type GoogleIdentityBindingResult = Readonly<{
  accountId: string;
  outcome: 'created' | 'observed';
}>;

/**
 * Trusted-operator-only pre-provisioning operation. It never matches by email
 * and writes no OAuth tokens. An advisory lock makes the subject conflict check
 * and binding atomic across concurrent operator invocations.
 */
export async function bindGoogleIdentity(
  prisma: PrismaClient,
  input: Readonly<{ actorUserId: string; googleSubject: string; targetUserId: string }>,
): Promise<GoogleIdentityBindingResult> {
  const subject = getGoogleSubject(input.googleSubject);

  if (!subject) {
    throw new GoogleIdentityBindingError('A Google subject is required.');
  }

  const result = await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`skyos:google-subject:${subject}`}))
    `;
    await requireActiveUser(transaction, input.actorUserId);
    await requireActiveUser(transaction, input.targetUserId);

    const existing = await transaction.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: GOOGLE_PROVIDER_ID,
          providerAccountId: subject,
        },
      },
      select: { id: true, userId: true },
    });

    if (existing && existing.userId !== input.targetUserId) {
      await appendIdentityAuditEvent(transaction, {
        action: IdentityAuditAction.GOOGLE_BINDING_CONFLICT_REJECTED,
        actorUserId: input.actorUserId,
        metadata: { reason: 'subject_already_bound' },
        provider: GOOGLE_PROVIDER_ID,
        subject,
        targetUserId: input.targetUserId,
      });
      return { accountId: existing.id, outcome: 'conflict' as const };
    }

    if (existing) {
      await appendIdentityAuditEvent(transaction, {
        action: IdentityAuditAction.GOOGLE_BINDING_OBSERVED,
        actorUserId: input.actorUserId,
        metadata: {},
        provider: GOOGLE_PROVIDER_ID,
        subject,
        targetUserId: input.targetUserId,
      });
      return { accountId: existing.id, outcome: 'observed' as const };
    }

    const account = await transaction.account.create({
      data: {
        provider: GOOGLE_PROVIDER_ID,
        providerAccountId: subject,
        type: GOOGLE_ACCOUNT_TYPE,
        userId: input.targetUserId,
      },
      select: { id: true },
    });
    await appendIdentityAuditEvent(transaction, {
      action: IdentityAuditAction.GOOGLE_BINDING_CREATED,
      actorUserId: input.actorUserId,
      metadata: {},
      provider: GOOGLE_PROVIDER_ID,
      subject,
      targetUserId: input.targetUserId,
    });
    return { accountId: account.id, outcome: 'created' as const };
  });

  if (result.outcome === 'conflict') {
    throw new GoogleIdentityBindingConflictError('This Google identity is already bound.');
  }

  return result;
}

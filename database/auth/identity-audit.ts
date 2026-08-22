import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '../generated/client/client';

export const IdentityAuditAction = {
  GOOGLE_BINDING_CREATED: 'google_identity.binding_created',
  GOOGLE_BINDING_OBSERVED: 'google_identity.binding_observed',
  GOOGLE_BINDING_CONFLICT_REJECTED: 'google_identity.binding_conflict_rejected',
  GOOGLE_SIGN_IN_REJECTED_INVALID: 'google_identity.sign_in_rejected_invalid',
  GOOGLE_SIGN_IN_REJECTED_UNKNOWN: 'google_identity.sign_in_rejected_unknown',
  GOOGLE_SIGN_IN_REJECTED_INACTIVE: 'google_identity.sign_in_rejected_inactive',
  GOOGLE_SIGN_IN_SUCCEEDED: 'google_identity.sign_in_succeeded',
} as const;

type IdentityAuditWriter = Pick<PrismaClient, 'identityAuditEvent'>;

export type IdentityAuditEventInput = Readonly<{
  action: (typeof IdentityAuditAction)[keyof typeof IdentityAuditAction];
  actorUserId?: string;
  metadata?: Prisma.InputJsonObject;
  provider: 'google';
  subject: string | null;
  targetUserId?: string;
}>;

/** Returns a one-way correlation value; raw external subjects are never audited. */
export function getIdentitySubjectFingerprint(subject: string | null): string {
  return createHash('sha256')
    .update(subject ?? 'missing-subject', 'utf8')
    .digest('hex');
}

/** Writes one global, append-only identity security event without tenant attribution. */
export async function appendIdentityAuditEvent(
  prisma: IdentityAuditWriter,
  input: IdentityAuditEventInput,
): Promise<void> {
  await prisma.identityAuditEvent.create({
    data: {
      action: input.action,
      actorUserId: input.actorUserId,
      metadata: input.metadata ?? {},
      provider: input.provider,
      subjectFingerprint: getIdentitySubjectFingerprint(input.subject),
      targetUserId: input.targetUserId,
    },
  });
}

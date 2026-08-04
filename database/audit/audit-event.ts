import type { Prisma, PrismaClient } from '../generated/client/client';

export const AuditAction = {
  ORGANIZATION_ARCHIVED: 'organization.archived',
  ORGANIZATION_RESTORED: 'organization.restored',
  ORGANIZATION_MEMBERSHIP_ROLE_CHANGED: 'organization_membership.role_changed',
  ORGANIZATION_MEMBERSHIP_SUSPENDED: 'organization_membership.suspended',
  ORGANIZATION_MEMBERSHIP_RESUMED: 'organization_membership.resumed',
  ORGANIZATION_MEMBERSHIP_REVOKED: 'organization_membership.revoked',
  ORGANIZATION_OWNERSHIP_TRANSFERRED: 'organization.ownership_transferred',
  KNOWLEDGE_DOCUMENT_CREATED: 'knowledge_document.created',
  KNOWLEDGE_DOCUMENT_UPDATED: 'knowledge_document.updated',
  KNOWLEDGE_DOCUMENT_ARCHIVED: 'knowledge_document.archived',
  KNOWLEDGE_DOCUMENT_RESTORED: 'knowledge_document.restored',
  KNOWLEDGE_DOCUMENT_VERSION_RESTORED: 'knowledge_document.version_restored',
  KNOWLEDGE_ATTACHMENT_UPLOADED: 'knowledge_attachment.uploaded',
  KNOWLEDGE_ATTACHMENT_ARCHIVED: 'knowledge_attachment.archived',
  KNOWLEDGE_ATTACHMENT_RESTORED: 'knowledge_attachment.restored',
  KNOWLEDGE_ATTACHMENT_PROCESSING_REQUESTED: 'knowledge_attachment.processing_requested',
  KNOWLEDGE_ATTACHMENT_PROCESSING_STARTED: 'knowledge_attachment.processing_started',
  KNOWLEDGE_ATTACHMENT_PROCESSING_SUCCEEDED: 'knowledge_attachment.processing_succeeded',
  KNOWLEDGE_ATTACHMENT_PROCESSING_FAILED: 'knowledge_attachment.processing_failed',
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_ARCHIVED: 'workspace.archived',
  WORKSPACE_RESTORED: 'workspace.restored',
  WORKSPACE_MEMBERSHIP_ROLE_CHANGED: 'workspace_membership.role_changed',
  WORKSPACE_MEMBERSHIP_SUSPENDED: 'workspace_membership.suspended',
  WORKSPACE_MEMBERSHIP_RESUMED: 'workspace_membership.resumed',
  WORKSPACE_MEMBERSHIP_REVOKED: 'workspace_membership.revoked',
  WORKSPACE_OWNERSHIP_TRANSFERRED: 'workspace.ownership_transferred',
} as const;

export const AuditTargetType = {
  ORGANIZATION: 'organization',
  ORGANIZATION_MEMBERSHIP: 'organization_membership',
  WORKSPACE: 'workspace',
  WORKSPACE_MEMBERSHIP: 'workspace_membership',
  KNOWLEDGE_DOCUMENT: 'knowledge_document',
  KNOWLEDGE_ATTACHMENT: 'knowledge_attachment',
} as const;

type AuditEventWriter = Pick<PrismaClient, 'auditEvent'>;

export interface AppendAuditEventInput {
  actorUserId: string;
  organizationId: string;
  workspaceId?: string;
  action: (typeof AuditAction)[keyof typeof AuditAction];
  targetType: (typeof AuditTargetType)[keyof typeof AuditTargetType];
  targetId: string;
  metadata: Prisma.InputJsonObject;
}

/**
 * Records an immutable audit event. Call this only with the transaction client
 * performing the protected mutation so both writes commit or roll back together.
 */
export async function appendAuditEvent(
  prisma: AuditEventWriter,
  input: AppendAuditEventInput,
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      action: input.action,
      actorUserId: input.actorUserId,
      metadata: input.metadata,
      organizationId: input.organizationId,
      targetId: input.targetId,
      targetType: input.targetType,
      workspaceId: input.workspaceId,
    },
  });
}

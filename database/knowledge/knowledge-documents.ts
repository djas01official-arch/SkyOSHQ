import { randomUUID } from 'node:crypto';

import {
  KnowledgeDocumentStatus,
  MembershipStatus,
  type Prisma,
  type PrismaClient,
  UserStatus,
  WorkspaceStatus,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';

export class KnowledgeDocumentError extends Error {}

export class KnowledgeAuthorizationError extends KnowledgeDocumentError {}

export class KnowledgeConflictError extends KnowledgeDocumentError {}

export class KnowledgeNotFoundError extends KnowledgeDocumentError {}

export class KnowledgeStateError extends KnowledgeDocumentError {}

export class KnowledgeValidationError extends KnowledgeDocumentError {}

type Transaction = Prisma.TransactionClient;

export type KnowledgeDocumentInput = Readonly<{
  content: string;
  title: string;
}>;

export type KnowledgeSearchResult = Readonly<{
  id: string;
  slug: string;
  title: string;
  updatedAt: Date;
  version: number;
}>;

type WorkspaceAccess = Readonly<{
  organizationId: string;
  workspaceId: string;
}>;

function getTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, ' ');

  if (title.length < 1 || title.length > 200) {
    throw new KnowledgeValidationError('Titles must contain between 1 and 200 characters.');
  }

  return title;
}

function getContent(value: string): string {
  if (value.length > 100_000) {
    throw new KnowledgeValidationError('Markdown content must not exceed 100,000 characters.');
  }

  return value;
}

function getInput(input: KnowledgeDocumentInput): KnowledgeDocumentInput {
  return { content: getContent(input.content), title: getTitle(input.title) };
}

function createSlug(title: string): string {
  const base = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);

  return `${base || 'document'}-${randomUUID().slice(0, 8)}`;
}

function getSearchTerms(value: string): string[] {
  return (value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16);
}

async function requireWorkspaceAccess(
  prisma: PrismaClient | Transaction,
  actorUserId: string,
  workspaceId: string,
  write: boolean,
): Promise<WorkspaceAccess> {
  const membership = await prisma.workspaceMembership.findFirst({
    where: {
      status: MembershipStatus.ACTIVE,
      userId: actorUserId,
      workspace: {
        deletedAt: null,
        id: workspaceId,
        organization: {
          deletedAt: null,
          status: WorkspaceStatus.ACTIVE,
        },
        status: WorkspaceStatus.ACTIVE,
      },
    },
    select: {
      role: true,
      workspace: {
        select: {
          organizationId: true,
          organization: {
            select: {
              memberships: {
                select: { id: true },
                where: {
                  status: MembershipStatus.ACTIVE,
                  userId: actorUserId,
                  user: { deletedAt: null, status: UserStatus.ACTIVE },
                },
              },
            },
          },
        },
      },
    },
  });

  if (
    !membership ||
    membership.workspace.organization.memberships.length !== 1 ||
    (write && membership.role === 'VIEWER')
  ) {
    throw new KnowledgeAuthorizationError(
      write
        ? 'knowledge.write requires an effective non-viewer workspace membership.'
        : 'knowledge.read requires an effective workspace membership.',
    );
  }

  return { organizationId: membership.workspace.organizationId, workspaceId };
}

async function findDocument(
  prisma: PrismaClient | Transaction,
  workspaceId: string,
  slug: string,
  includeArchived: boolean,
) {
  const document = await prisma.knowledgeDocument.findFirst({
    where: {
      slug,
      status: includeArchived ? undefined : KnowledgeDocumentStatus.ACTIVE,
      workspaceId,
    },
    include: {
      author: { select: { displayName: true, email: true, id: true } },
    },
  });

  if (!document) {
    throw new KnowledgeNotFoundError('The knowledge document was not found in this workspace.');
  }

  return document;
}

async function getUpdatedDocument(transaction: Transaction, documentId: string) {
  return transaction.knowledgeDocument.findUniqueOrThrow({
    where: { id: documentId },
    include: { author: { select: { displayName: true, email: true, id: true } } },
  });
}

export async function listKnowledgeDocuments(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
) {
  await requireWorkspaceAccess(prisma, actorUserId, workspaceId, false);

  return prisma.knowledgeDocument.findMany({
    where: { status: KnowledgeDocumentStatus.ACTIVE, workspaceId },
    select: {
      author: { select: { displayName: true, email: true, id: true } },
      createdAt: true,
      id: true,
      slug: true,
      title: true,
      updatedAt: true,
      version: true,
    },
    orderBy: [{ updatedAt: 'desc' }, { title: 'asc' }],
  });
}

/** Searches active documents only, using PostgreSQL full-text search within one effective workspace. */
export async function searchKnowledgeDocuments(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  query: string,
): Promise<KnowledgeSearchResult[]> {
  await requireWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  const terms = getSearchTerms(query);

  if (!terms.length) {
    return [];
  }

  return prisma.$queryRaw<KnowledgeSearchResult[]>`
    SELECT
      "id",
      "slug",
      "title",
      "updatedAt",
      "version"
    FROM "knowledge_documents"
    WHERE
      "workspaceId" = ${workspaceId}::uuid
      AND "status" = 'ACTIVE'
      AND "searchVector" @@ plainto_tsquery('simple', ${terms.join(' ')})
    ORDER BY ts_rank_cd("searchVector", plainto_tsquery('simple', ${terms.join(' ')})) DESC,
      "updatedAt" DESC
    LIMIT 50
  `;
}

export async function getKnowledgeDocument(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  slug: string,
  includeArchived = false,
) {
  await requireWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  return findDocument(prisma, workspaceId, slug, includeArchived);
}

export async function createKnowledgeDocument(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  input: KnowledgeDocumentInput,
) {
  const value = getInput(input);

  return prisma.$transaction(async (transaction) => {
    const access = await requireWorkspaceAccess(transaction, actorUserId, workspaceId, true);
    const document = await transaction.knowledgeDocument.create({
      data: {
        authorUserId: actorUserId,
        content: value.content,
        slug: createSlug(value.title),
        title: value.title,
        workspaceId,
      },
      include: { author: { select: { displayName: true, email: true, id: true } } },
    });

    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_DOCUMENT_CREATED,
      actorUserId,
      metadata: { slug: document.slug, title: document.title, version: document.version },
      organizationId: access.organizationId,
      targetId: document.id,
      targetType: AuditTargetType.KNOWLEDGE_DOCUMENT,
      workspaceId,
    });

    return document;
  });
}

export async function updateKnowledgeDocument(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  slug: string,
  expectedVersion: number,
  input: KnowledgeDocumentInput,
) {
  const value = getInput(input);

  return prisma.$transaction(async (transaction) => {
    const access = await requireWorkspaceAccess(transaction, actorUserId, workspaceId, true);
    const document = await findDocument(transaction, workspaceId, slug, false);
    const updated = await transaction.knowledgeDocument.updateMany({
      where: {
        id: document.id,
        status: KnowledgeDocumentStatus.ACTIVE,
        version: expectedVersion,
        workspaceId,
      },
      data: { content: value.content, title: value.title, version: { increment: 1 } },
    });

    if (updated.count !== 1) {
      throw new KnowledgeConflictError(
        'This document changed before your update. Refresh and try again.',
      );
    }

    const persisted = await getUpdatedDocument(transaction, document.id);
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_DOCUMENT_UPDATED,
      actorUserId,
      metadata: {
        afterTitle: persisted.title,
        afterVersion: persisted.version,
        beforeTitle: document.title,
        beforeVersion: document.version,
      },
      organizationId: access.organizationId,
      targetId: document.id,
      targetType: AuditTargetType.KNOWLEDGE_DOCUMENT,
      workspaceId,
    });

    return persisted;
  });
}

async function transitionKnowledgeDocument(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  slug: string,
  expectedVersion: number,
  status: KnowledgeDocumentStatus,
) {
  return prisma.$transaction(async (transaction) => {
    const access = await requireWorkspaceAccess(transaction, actorUserId, workspaceId, true);
    const document = await findDocument(transaction, workspaceId, slug, true);
    const expectedStatus =
      status === KnowledgeDocumentStatus.ARCHIVED
        ? KnowledgeDocumentStatus.ACTIVE
        : KnowledgeDocumentStatus.ARCHIVED;

    if (document.status !== expectedStatus) {
      throw new KnowledgeStateError(
        'The document is not in a state that supports this transition.',
      );
    }

    const updated = await transaction.knowledgeDocument.updateMany({
      where: { id: document.id, status: expectedStatus, version: expectedVersion, workspaceId },
      data: {
        archivedAt: status === KnowledgeDocumentStatus.ARCHIVED ? new Date() : null,
        status,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new KnowledgeConflictError(
        'This document changed before your request. Refresh and try again.',
      );
    }

    const persisted = await getUpdatedDocument(transaction, document.id);
    await appendAuditEvent(transaction, {
      action:
        status === KnowledgeDocumentStatus.ARCHIVED
          ? AuditAction.KNOWLEDGE_DOCUMENT_ARCHIVED
          : AuditAction.KNOWLEDGE_DOCUMENT_RESTORED,
      actorUserId,
      metadata: { afterVersion: persisted.version, beforeVersion: document.version, slug },
      organizationId: access.organizationId,
      targetId: document.id,
      targetType: AuditTargetType.KNOWLEDGE_DOCUMENT,
      workspaceId,
    });

    return persisted;
  });
}

export function archiveKnowledgeDocument(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  slug: string,
  expectedVersion: number,
) {
  return transitionKnowledgeDocument(
    prisma,
    actorUserId,
    workspaceId,
    slug,
    expectedVersion,
    KnowledgeDocumentStatus.ARCHIVED,
  );
}

export function restoreKnowledgeDocument(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  slug: string,
  expectedVersion: number,
) {
  return transitionKnowledgeDocument(
    prisma,
    actorUserId,
    workspaceId,
    slug,
    expectedVersion,
    KnowledgeDocumentStatus.ACTIVE,
  );
}

import { createHash } from 'node:crypto';

import {
  AiGroundedContextSourceType,
  KnowledgeChunkSourceType,
  type Prisma,
  type PrismaClient,
} from '../generated/client/client';
import type { KnowledgeRetrievalCitation, KnowledgeRetrievalResult } from './knowledge-retrieval';

export const GROUNDED_CONTEXT_VERSION = 'skyos-grounded-context-v1';

export type GroundedContextExcerpt = Readonly<{
  citation: KnowledgeRetrievalCitation;
  text: string;
}>;

export type GroundedContext = Readonly<{
  allowedCitationIds: readonly string[];
  context: string;
  contextChecksum: string;
  evidenceChecksum: string;
  excerpts: readonly GroundedContextExcerpt[];
  knowledgeDocumentVersionId: string | null;
  sourceType: AiGroundedContextSourceType;
  version: string;
  workspaceId: string;
}>;

export class AiGroundedContextRoutingDecisionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function evidenceIdentity(excerpts: readonly GroundedContextExcerpt[]): string {
  return JSON.stringify(
    excerpts.map((excerpt) => ({
      citation: excerpt.citation,
      textChecksum: sha256(excerpt.text),
    })),
  );
}

export function createGroundedContext(
  workspaceId: string,
  retrieval: KnowledgeRetrievalResult,
  source: Readonly<{
    knowledgeDocumentVersionId?: string;
    type: AiGroundedContextSourceType;
  }>,
): GroundedContext {
  const excerpts = Object.freeze(
    retrieval.items.map((item) =>
      Object.freeze({ citation: Object.freeze({ ...item.citation }), text: item.text }),
    ),
  );
  if (excerpts.some((excerpt) => excerpt.citation.workspaceId !== workspaceId)) {
    throw new Error('GroundedContext excerpts must belong to one workspace.');
  }
  if (
    (source.type === AiGroundedContextSourceType.KNOWLEDGE_DOCUMENT_VERSION) !==
    Boolean(source.knowledgeDocumentVersionId)
  ) {
    throw new Error('GroundedContext source identity is incomplete.');
  }
  const allowedCitationIds = Object.freeze(excerpts.map((excerpt) => excerpt.citation.id));
  return Object.freeze({
    allowedCitationIds,
    context: retrieval.context,
    contextChecksum: sha256(retrieval.context),
    evidenceChecksum: sha256(evidenceIdentity(excerpts)),
    excerpts,
    knowledgeDocumentVersionId: source.knowledgeDocumentVersionId ?? null,
    sourceType: source.type,
    version: GROUNDED_CONTEXT_VERSION,
    workspaceId,
  });
}

export async function persistGroundedContext(
  prisma: PrismaClient,
  input: Readonly<{
    actorUserId: string;
    context: GroundedContext;
    query: string;
    routingDecisionId?: string;
    runId?: string;
  }>,
) {
  return prisma.$transaction(async (transaction) => {
    const snapshot = await transaction.aiRetrievalSnapshot.create({
      data: {
        characterCount: input.context.excerpts.reduce(
          (total, excerpt) => total + excerpt.text.length,
          0,
        ),
        context: input.context.context,
        contextChecksum: input.context.contextChecksum,
        contextVersion: input.context.version,
        createdByUserId: input.actorUserId,
        evidenceChecksum: input.context.evidenceChecksum,
        knowledgeDocumentVersionId: input.context.knowledgeDocumentVersionId,
        queryChecksum: sha256(input.query),
        resultCount: input.context.excerpts.length,
        routingDecisionId: input.routingDecisionId,
        runId: input.runId,
        sourceType: input.context.sourceType,
        workspaceId: input.context.workspaceId,
      },
    });
    if (input.context.excerpts.length) {
      await transaction.aiRunCitation.createMany({
        data: input.context.excerpts.map((excerpt) => ({
          attachmentId: excerpt.citation.attachmentId,
          characterEnd: excerpt.citation.characterEnd,
          characterStart: excerpt.citation.characterStart,
          chunkOrdinal: excerpt.citation.chunkOrdinal,
          chunkSetId: excerpt.citation.chunkSetId,
          citationId: excerpt.citation.id,
          displayedExcerpt: excerpt.text,
          displayedExcerptChecksum: excerpt.citation.displayedExcerptChecksum,
          documentSlug: excerpt.citation.documentSlug,
          documentVersion: excerpt.citation.documentVersion,
          extractionVersion: excerpt.citation.extractionVersion,
          filename: excerpt.citation.filename,
          snapshotId: snapshot.id,
          sourceId: excerpt.citation.sourceId,
          sourceType:
            excerpt.citation.sourceType === 'document'
              ? KnowledgeChunkSourceType.MARKDOWN_DOCUMENT
              : KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION,
        })),
      });
    }
    return snapshot;
  });
}

function groundedContextFromSnapshot(
  snapshot: Prisma.AiRetrievalSnapshotGetPayload<{
    include: { citations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } };
  }>,
  workspaceId: string,
): GroundedContext {
  const excerpts = Object.freeze(
    snapshot.citations.map((citation) =>
      Object.freeze({
        citation: Object.freeze({
          attachmentId: citation.attachmentId,
          characterEnd: citation.characterEnd,
          characterStart: citation.characterStart,
          chunkOrdinal: citation.chunkOrdinal,
          chunkSetId: citation.chunkSetId,
          displayedExcerptChecksum: citation.displayedExcerptChecksum,
          documentSlug: citation.documentSlug,
          documentVersion: citation.documentVersion,
          extractionVersion: citation.extractionVersion,
          filename: citation.filename,
          id: citation.citationId,
          sourceId: citation.sourceId,
          sourceType:
            citation.sourceType === KnowledgeChunkSourceType.MARKDOWN_DOCUMENT
              ? ('document' as const)
              : ('attachment' as const),
          workspaceId,
        }),
        text: citation.displayedExcerpt,
      }),
    ),
  );
  return Object.freeze({
    allowedCitationIds: Object.freeze(excerpts.map((excerpt) => excerpt.citation.id)),
    context: snapshot.context,
    contextChecksum: snapshot.contextChecksum,
    evidenceChecksum: snapshot.evidenceChecksum,
    excerpts,
    knowledgeDocumentVersionId: snapshot.knowledgeDocumentVersionId,
    sourceType: snapshot.sourceType,
    version: snapshot.contextVersion,
    workspaceId,
  });
}

export async function loadGroundedContext(
  prisma: PrismaClient,
  workspaceId: string,
  groundedContextId: string,
): Promise<GroundedContext | null> {
  const snapshot = await prisma.aiRetrievalSnapshot.findFirst({
    where: { id: groundedContextId, workspaceId },
    include: { citations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  if (!snapshot) return null;
  return groundedContextFromSnapshot(snapshot, workspaceId);
}

/**
 * Resolves the sole immutable Chat GroundedContext explicitly bound to a
 * routing decision. This does not reconstruct retrieval or use any heuristic
 * selection criteria.
 */
export async function getAiRetrievalSnapshotForRoutingDecision(
  prisma: PrismaClient,
  input: Readonly<{ actorUserId: string; routingDecisionId: string; workspaceId: string }>,
): Promise<Readonly<{ groundedContext: GroundedContext; id: string }>> {
  if (
    !UUID_PATTERN.test(input.actorUserId) ||
    !UUID_PATTERN.test(input.routingDecisionId) ||
    !UUID_PATTERN.test(input.workspaceId)
  ) {
    throw new AiGroundedContextRoutingDecisionError(
      'The GroundedContext routing identity is invalid.',
      'grounded_context_routing_invalid',
    );
  }
  const snapshots = await prisma.aiRetrievalSnapshot.findMany({
    where: {
      createdByUserId: input.actorUserId,
      routingDecisionId: input.routingDecisionId,
      workspaceId: input.workspaceId,
      routingDecision: {
        userMessage: {
          authorUserId: input.actorUserId,
          conversation: { ownerUserId: input.actorUserId },
          role: 'USER',
        },
      },
    },
    include: { citations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    take: 2,
  });
  if (snapshots.length !== 1) {
    throw new AiGroundedContextRoutingDecisionError(
      'The route-bound GroundedContext was not found.',
      snapshots.length === 0
        ? 'grounded_context_routing_not_found'
        : 'grounded_context_routing_ambiguous',
    );
  }
  const snapshot = snapshots[0]!;
  return Object.freeze({
    groundedContext: groundedContextFromSnapshot(snapshot, input.workspaceId),
    id: snapshot.id,
  });
}

import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import {
  DocumentProcessingJobStatus,
  KnowledgeAttachmentStatus,
  type Prisma,
  type PrismaClient,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';
import { findKnowledgeDocument, requireKnowledgeWorkspaceAccess } from './knowledge-documents';
import {
  type ObjectStorage,
  StorageObjectNotFoundError,
} from '../../services/storage/object-storage';

export class KnowledgeAttachmentError extends Error {}

export class KnowledgeAttachmentBinaryMissingError extends KnowledgeAttachmentError {}

export class KnowledgeAttachmentConflictError extends KnowledgeAttachmentError {}

export class KnowledgeAttachmentNotFoundError extends KnowledgeAttachmentError {}

export class KnowledgeAttachmentStateError extends KnowledgeAttachmentError {}

export class KnowledgeAttachmentStorageError extends KnowledgeAttachmentError {}

export class KnowledgeAttachmentValidationError extends KnowledgeAttachmentError {}

type Transaction = Prisma.TransactionClient;

export type KnowledgeAttachmentDependencies = Readonly<{
  maxFileSizeBytes: number;
  storage: ObjectStorage;
}>;

export type KnowledgeAttachmentUploadInput = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  originalFilename: string;
}>;

type SupportedFileType = Readonly<{
  extensions: readonly string[];
  hasValidSignature(bytes: Uint8Array): boolean;
}>;

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(value, 'ascii'));
}

const SUPPORTED_FILE_TYPES: Readonly<Record<string, SupportedFileType>> = {
  'application/pdf': {
    extensions: ['.pdf'],
    hasValidSignature: (bytes) => startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extensions: ['.docx'],
    hasValidSignature: (bytes) =>
      startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) &&
      containsAscii(bytes, '[Content_Types].xml') &&
      containsAscii(bytes, 'word/'),
  },
  'image/png': {
    extensions: ['.png'],
    hasValidSignature: (bytes) =>
      startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  'image/jpeg': {
    extensions: ['.jpg', '.jpeg'],
    hasValidSignature: (bytes) => startsWithBytes(bytes, [0xff, 0xd8, 0xff]),
  },
};

function getSafeOriginalFilename(value: string): string {
  const filename = value.normalize('NFC').trim();
  const hasControlCharacter = Array.from(filename).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

  if (
    filename.length < 1 ||
    filename.length > 255 ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    hasControlCharacter
  ) {
    throw new KnowledgeAttachmentValidationError(
      'The original filename contains an unsafe path or control character.',
    );
  }

  return filename;
}

function validateUpload(
  input: KnowledgeAttachmentUploadInput,
  maxFileSizeBytes: number,
): {
  bytes: Uint8Array;
  extension: string;
  mimeType: string;
  originalFilename: string;
  sha256Checksum: string;
} {
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes < 1) {
    throw new KnowledgeAttachmentValidationError('The attachment size limit is invalid.');
  }

  const originalFilename = getSafeOriginalFilename(input.originalFilename);
  const extension = extname(originalFilename).toLowerCase();
  const mimeType = input.mimeType.trim().toLowerCase();
  const specification = SUPPORTED_FILE_TYPES[mimeType];

  if (!specification || !specification.extensions.includes(extension)) {
    throw new KnowledgeAttachmentValidationError(
      'The file extension and MIME type must identify the same supported file type.',
    );
  }

  if (input.bytes.byteLength < 1) {
    throw new KnowledgeAttachmentValidationError('Empty attachments are not supported.');
  }

  if (input.bytes.byteLength > maxFileSizeBytes) {
    throw new KnowledgeAttachmentValidationError(
      `The attachment exceeds the configured ${maxFileSizeBytes}-byte limit.`,
    );
  }

  if (!specification.hasValidSignature(input.bytes)) {
    throw new KnowledgeAttachmentValidationError(
      'The file content does not match its declared MIME type and extension.',
    );
  }

  return {
    bytes: input.bytes,
    extension,
    mimeType,
    originalFilename,
    sha256Checksum: createHash('sha256').update(input.bytes).digest('hex'),
  };
}

async function findAttachment(
  prisma: PrismaClient | Transaction,
  workspaceId: string,
  documentId: string,
  attachmentId: string,
  includeArchived: boolean,
) {
  const attachment = await prisma.knowledgeAttachment.findFirst({
    where: {
      documentId,
      id: attachmentId,
      status: includeArchived ? undefined : KnowledgeAttachmentStatus.ACTIVE,
      workspaceId,
    },
    include: { uploader: { select: { displayName: true, email: true, id: true } } },
  });

  if (!attachment) {
    throw new KnowledgeAttachmentNotFoundError(
      'The attachment was not found in this document and workspace.',
    );
  }

  return attachment;
}

export async function listKnowledgeAttachments(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  includeArchived = false,
) {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, includeArchived);
  const document = await findKnowledgeDocument(prisma, workspaceId, documentSlug, true);

  return prisma.knowledgeAttachment.findMany({
    where: {
      documentId: document.id,
      status: includeArchived ? undefined : KnowledgeAttachmentStatus.ACTIVE,
      workspaceId,
    },
    include: {
      extractions: {
        orderBy: { extractionNumber: 'desc' },
        select: {
          createdAt: true,
          extractionNumber: true,
          parserName: true,
          parserVersion: true,
        },
        take: 1,
      },
      processingJobs: {
        orderBy: { createdAt: 'desc' },
        select: { errorMessage: true, status: true },
        take: 1,
      },
      uploader: { select: { displayName: true, email: true, id: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { originalFilename: 'asc' }],
  });
}

export async function uploadKnowledgeAttachment(
  prisma: PrismaClient,
  dependencies: KnowledgeAttachmentDependencies,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  input: KnowledgeAttachmentUploadInput,
) {
  const value = validateUpload(input, dependencies.maxFileSizeBytes);
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, true);
  const document = await findKnowledgeDocument(prisma, workspaceId, documentSlug, false);
  const attachmentId = randomUUID();
  const storageKey = `${workspaceId}/${document.id}/${attachmentId}${value.extension}`;

  await dependencies.storage.putObject({ data: value.bytes, key: storageKey });

  try {
    return await prisma.$transaction(async (transaction) => {
      const access = await requireKnowledgeWorkspaceAccess(
        transaction,
        actorUserId,
        workspaceId,
        true,
      );
      const currentDocument = await findKnowledgeDocument(
        transaction,
        workspaceId,
        documentSlug,
        false,
      );

      const duplicate = await transaction.knowledgeAttachment.findFirst({
        where: {
          documentId: currentDocument.id,
          sha256Checksum: value.sha256Checksum,
          status: KnowledgeAttachmentStatus.ACTIVE,
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new KnowledgeAttachmentConflictError(
          'An active attachment with the same content already exists on this document.',
        );
      }

      const attachment = await transaction.knowledgeAttachment.create({
        data: {
          id: attachmentId,
          documentId: currentDocument.id,
          mimeType: value.mimeType,
          originalFilename: value.originalFilename,
          sha256Checksum: value.sha256Checksum,
          sizeBytes: BigInt(value.bytes.byteLength),
          storageKey,
          uploaderUserId: actorUserId,
          workspaceId,
        },
        include: { uploader: { select: { displayName: true, email: true, id: true } } },
      });

      await appendAuditEvent(transaction, {
        action: AuditAction.KNOWLEDGE_ATTACHMENT_UPLOADED,
        actorUserId,
        metadata: {
          mimeType: attachment.mimeType,
          sha256Checksum: attachment.sha256Checksum,
          sizeBytes: attachment.sizeBytes.toString(),
          version: attachment.version,
        },
        organizationId: access.organizationId,
        targetId: attachment.id,
        targetType: AuditTargetType.KNOWLEDGE_ATTACHMENT,
        workspaceId,
      });

      return attachment;
    });
  } catch (error) {
    try {
      await dependencies.storage.deleteObject(storageKey);
    } catch (cleanupError) {
      throw new KnowledgeAttachmentStorageError(
        'Attachment metadata failed and the staged binary could not be removed.',
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw error;
  }
}

async function transitionKnowledgeAttachment(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  attachmentId: string,
  expectedVersion: number,
  status: KnowledgeAttachmentStatus,
) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new KnowledgeAttachmentValidationError('Attachment versions must be positive integers.');
  }

  return prisma.$transaction(async (transaction) => {
    const access = await requireKnowledgeWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      true,
    );
    const document = await findKnowledgeDocument(transaction, workspaceId, documentSlug, false);
    const attachment = await findAttachment(
      transaction,
      workspaceId,
      document.id,
      attachmentId,
      true,
    );
    const expectedStatus =
      status === KnowledgeAttachmentStatus.ARCHIVED
        ? KnowledgeAttachmentStatus.ACTIVE
        : KnowledgeAttachmentStatus.ARCHIVED;

    if (attachment.status !== expectedStatus) {
      throw new KnowledgeAttachmentStateError(
        'The attachment is not in a state that supports this transition.',
      );
    }

    if (status === KnowledgeAttachmentStatus.ARCHIVED) {
      const activeProcessingJob = await transaction.documentProcessingJob.findFirst({
        where: {
          attachmentId: attachment.id,
          status: {
            in: [DocumentProcessingJobStatus.QUEUED, DocumentProcessingJobStatus.PROCESSING],
          },
        },
        select: { id: true },
      });
      if (activeProcessingJob) {
        throw new KnowledgeAttachmentStateError(
          'This attachment cannot be archived while processing is pending.',
        );
      }
    }

    if (status === KnowledgeAttachmentStatus.ACTIVE) {
      const duplicate = await transaction.knowledgeAttachment.findFirst({
        where: {
          documentId: document.id,
          id: { not: attachment.id },
          sha256Checksum: attachment.sha256Checksum,
          status: KnowledgeAttachmentStatus.ACTIVE,
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new KnowledgeAttachmentConflictError(
          'This attachment cannot be restored while identical active content exists.',
        );
      }
    }

    const updated = await transaction.knowledgeAttachment.updateMany({
      where: {
        id: attachment.id,
        status: expectedStatus,
        version: expectedVersion,
        workspaceId,
      },
      data: {
        archivedAt: status === KnowledgeAttachmentStatus.ARCHIVED ? new Date() : null,
        status,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new KnowledgeAttachmentConflictError(
        'This attachment changed before your request. Refresh and try again.',
      );
    }

    const persisted = await findAttachment(
      transaction,
      workspaceId,
      document.id,
      attachment.id,
      true,
    );
    await appendAuditEvent(transaction, {
      action:
        status === KnowledgeAttachmentStatus.ARCHIVED
          ? AuditAction.KNOWLEDGE_ATTACHMENT_ARCHIVED
          : AuditAction.KNOWLEDGE_ATTACHMENT_RESTORED,
      actorUserId,
      metadata: {
        afterVersion: persisted.version,
        beforeVersion: attachment.version,
        sha256Checksum: attachment.sha256Checksum,
      },
      organizationId: access.organizationId,
      targetId: attachment.id,
      targetType: AuditTargetType.KNOWLEDGE_ATTACHMENT,
      workspaceId,
    });

    return persisted;
  });
}

export function archiveKnowledgeAttachment(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  attachmentId: string,
  expectedVersion: number,
) {
  return transitionKnowledgeAttachment(
    prisma,
    actorUserId,
    workspaceId,
    documentSlug,
    attachmentId,
    expectedVersion,
    KnowledgeAttachmentStatus.ARCHIVED,
  );
}

export function restoreKnowledgeAttachment(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  attachmentId: string,
  expectedVersion: number,
) {
  return transitionKnowledgeAttachment(
    prisma,
    actorUserId,
    workspaceId,
    documentSlug,
    attachmentId,
    expectedVersion,
    KnowledgeAttachmentStatus.ACTIVE,
  );
}

export async function downloadKnowledgeAttachment(
  prisma: PrismaClient,
  dependencies: Pick<KnowledgeAttachmentDependencies, 'storage'>,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  attachmentId: string,
) {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  const document = await findKnowledgeDocument(prisma, workspaceId, documentSlug, true);
  const attachment = await findAttachment(prisma, workspaceId, document.id, attachmentId, false);

  let bytes: Uint8Array;
  try {
    bytes = await dependencies.storage.getObject(attachment.storageKey);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new KnowledgeAttachmentBinaryMissingError(
        'The attachment metadata exists, but its binary file is missing.',
      );
    }
    throw error;
  }

  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (checksum !== attachment.sha256Checksum || BigInt(bytes.byteLength) !== attachment.sizeBytes) {
    throw new KnowledgeAttachmentStorageError('The stored attachment failed its integrity check.');
  }

  return { attachment, bytes };
}

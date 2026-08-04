import { NextResponse } from 'next/server';

import {
  KnowledgeAttachmentBinaryMissingError,
  KnowledgeAttachmentNotFoundError,
  downloadKnowledgeAttachment,
} from '../../../../../../../../database/knowledge/knowledge-attachments';
import {
  KnowledgeAuthorizationError,
  KnowledgeNotFoundError,
} from '../../../../../../../../database/knowledge/knowledge-documents';

import { getCurrentUser } from '@/lib/auth/current-user';
import { knowledgeAttachmentDependencies } from '@/lib/knowledge-storage';
import { getCurrentOrganizationContext } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type DownloadRouteContext = Readonly<{
  params: Promise<{ attachmentId: string; slug: string }>;
}>;

function encodeFilename(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function getContentDisposition(originalFilename: string): string {
  const fallback = originalFilename.replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeFilename(originalFilename)}`;
}

export async function GET(_request: Request, { params }: DownloadRouteContext) {
  const [route, user, context] = await Promise.all([
    params,
    getCurrentUser(),
    getCurrentOrganizationContext(),
  ]);

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!context?.activeWorkspace) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { attachment, bytes } = await downloadKnowledgeAttachment(
      prisma,
      knowledgeAttachmentDependencies,
      user.id,
      context.activeWorkspace.id,
      route.slug,
      route.attachmentId,
    );

    return new Response(Uint8Array.from(bytes).buffer, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': getContentDisposition(attachment.originalFilename),
        'Content-Length': attachment.sizeBytes.toString(),
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Content-Type': attachment.mimeType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof KnowledgeAuthorizationError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (
      error instanceof KnowledgeAttachmentBinaryMissingError ||
      error instanceof KnowledgeAttachmentNotFoundError ||
      error instanceof KnowledgeNotFoundError
    ) {
      return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
    }
    throw error;
  }
}

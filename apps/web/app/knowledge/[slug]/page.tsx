import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  KnowledgeNotFoundError,
  getKnowledgeDocument,
} from '../../../../../database/knowledge/knowledge-documents';
import { KnowledgeDocumentStatus } from '../../../../../database/generated/client/client';

import {
  archiveKnowledgeDocumentAction,
  restoreKnowledgeDocumentAction,
} from '@/app/knowledge/actions';
import { KnowledgeDocumentLifecycle } from '@/components/knowledge/knowledge-document-lifecycle';
import { MarkdownDocument } from '@/components/knowledge/markdown-document';
import { Card } from '@/components/ui/card';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { hasWorkspaceCapability, requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

type KnowledgeDocumentPageProps = Readonly<{
  params: Promise<{ slug: string }>;
}>;

export default async function KnowledgeDocumentPage({ params }: KnowledgeDocumentPageProps) {
  const [{ slug }, user, context] = await Promise.all([
    params,
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.read'),
  ]);
  const workspace = context.activeWorkspace;

  if (!workspace) {
    notFound();
  }

  let document;
  try {
    document = await getKnowledgeDocument(prisma, user.id, workspace.id, slug, true);
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError) {
      notFound();
    }
    throw error;
  }

  const canWrite = hasWorkspaceCapability(workspace.role, 'knowledge.write');
  const isArchived = document.status === KnowledgeDocumentStatus.ARCHIVED;
  const author = document.author.displayName ?? document.author.email ?? 'Unknown author';

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-col justify-between gap-5 border-b border-border pb-7 sm:flex-row sm:items-start">
        <div>
          <Link className="text-sm font-medium text-accent hover:underline" href="/knowledge">
            Knowledge
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {document.title}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {author} · Version {document.version} · Updated {document.updatedAt.toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            className="inline-flex h-8 items-center rounded-control border border-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-raised"
            href={`/knowledge/${document.slug}/history`}
          >
            Version history
          </Link>
          {canWrite ? (
            <>
              {!isArchived ? (
                <Link
                  className="inline-flex h-8 items-center rounded-control border border-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-raised"
                  href={`/knowledge/${document.slug}/edit`}
                >
                  Edit
                </Link>
              ) : null}
              <KnowledgeDocumentLifecycle
                action={
                  isArchived ? restoreKnowledgeDocumentAction : archiveKnowledgeDocumentAction
                }
                label={isArchived ? 'Restore' : 'Archive'}
                slug={document.slug}
                version={document.version}
              />
            </>
          ) : null}
        </div>
      </div>

      {isArchived ? (
        <p className="mt-6 rounded-control bg-accent-soft px-3 py-2 text-sm text-accent">
          This document is archived and excluded from the normal knowledge list.
        </p>
      ) : null}
      <Card className="mt-6">
        <MarkdownDocument content={document.content} />
      </Card>
    </div>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  KnowledgeNotFoundError,
  getKnowledgeDocumentVersion,
} from '../../../../../../../database/knowledge/knowledge-documents';
import { KnowledgeDocumentStatus } from '../../../../../../../database/generated/client/client';

import { restoreKnowledgeDocumentVersionAction } from '@/app/knowledge/actions';
import { KnowledgeVersionRestore } from '@/components/knowledge/knowledge-version-restore';
import { MarkdownDocument } from '@/components/knowledge/markdown-document';
import { Card } from '@/components/ui/card';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { hasWorkspaceCapability, requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

type KnowledgeVersionPageProps = Readonly<{
  params: Promise<{ slug: string; version: string }>;
}>;

export default async function KnowledgeVersionPage({ params }: KnowledgeVersionPageProps) {
  const [route, user, context] = await Promise.all([
    params,
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.read'),
  ]);
  const workspace = context.activeWorkspace;
  const versionNumber = /^\d+$/.test(route.version) ? Number(route.version) : Number.NaN;

  if (!workspace || !Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    notFound();
  }

  let result;
  try {
    result = await getKnowledgeDocumentVersion(
      prisma,
      user.id,
      workspace.id,
      route.slug,
      versionNumber,
    );
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError) {
      notFound();
    }
    throw error;
  }

  const { document, version } = result;
  const author = version.author.displayName ?? version.author.email ?? 'Unknown author';
  const canRestore =
    document.status === KnowledgeDocumentStatus.ACTIVE &&
    document.version !== version.versionNumber &&
    hasWorkspaceCapability(workspace.role, 'knowledge.write');

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        className="text-sm font-medium text-accent hover:underline"
        href={`/knowledge/${document.slug}/history`}
      >
        Version history
      </Link>
      <div className="mt-3 flex flex-col justify-between gap-5 border-b border-border pb-7 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            Version {version.versionNumber}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
            {version.title}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {author} · Created {version.createdAt.toLocaleString()}
          </p>
        </div>
        {canRestore ? (
          <KnowledgeVersionRestore
            action={restoreKnowledgeDocumentVersionAction}
            currentVersion={document.version}
            slug={document.slug}
            sourceVersion={version.versionNumber}
          />
        ) : null}
      </div>

      <Card className="mt-6">
        <MarkdownDocument content={version.markdownContent} />
      </Card>
    </div>
  );
}

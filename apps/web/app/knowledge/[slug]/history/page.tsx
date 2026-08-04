import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  KnowledgeNotFoundError,
  getKnowledgeDocument,
  listKnowledgeDocumentVersions,
} from '../../../../../../database/knowledge/knowledge-documents';

import { Card } from '@/components/ui/card';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

type KnowledgeHistoryPageProps = Readonly<{
  params: Promise<{ slug: string }>;
}>;

export default async function KnowledgeHistoryPage({ params }: KnowledgeHistoryPageProps) {
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
  let versions;
  try {
    [document, versions] = await Promise.all([
      getKnowledgeDocument(prisma, user.id, workspace.id, slug, true),
      listKnowledgeDocumentVersions(prisma, user.id, workspace.id, slug),
    ]);
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        className="text-sm font-medium text-accent hover:underline"
        href={`/knowledge/${document.slug}`}
      >
        {document.title}
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        Version history
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Immutable snapshots are listed newest first. Restoring a snapshot creates a new version.
      </p>

      <div className="mt-7 space-y-3">
        {versions.map((version) => {
          const author = version.author.displayName ?? version.author.email ?? 'Unknown author';
          const isCurrent = version.versionNumber === document.version;

          return (
            <Card
              className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"
              key={version.id}
            >
              <div>
                <p className="font-medium text-foreground">
                  Version {version.versionNumber}
                  {isCurrent ? ' · Current' : ''}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {version.title} · {author} · {version.createdAt.toLocaleString()}
                </p>
              </div>
              <Link
                className="text-sm font-medium text-accent hover:underline"
                href={`/knowledge/${document.slug}/history/${version.versionNumber}`}
              >
                View version
              </Link>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

import Link from 'next/link';

import {
  listKnowledgeDocuments,
  searchKnowledgeDocuments,
} from '../../../../database/knowledge/knowledge-documents';

import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { hasWorkspaceCapability, requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

function getAuthorName(document: {
  author: { displayName: string | null; email: string | null };
}): string {
  return document.author.displayName ?? document.author.email ?? 'Unknown author';
}

type KnowledgePageProps = Readonly<{
  searchParams: Promise<{ q?: string | string[] }>;
}>;

export default async function KnowledgePage({ searchParams }: KnowledgePageProps) {
  const [user, context, resolvedSearchParams] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.read'),
    searchParams,
  ]);
  const workspace = context.activeWorkspace;

  if (!workspace) {
    return null;
  }

  const query = typeof resolvedSearchParams.q === 'string' ? resolvedSearchParams.q.trim() : '';
  const documents = query
    ? (await searchKnowledgeDocuments(prisma, user.id, workspace.id, query)).map((document) => ({
        ...document,
        byline: 'Search match',
      }))
    : (await listKnowledgeDocuments(prisma, user.id, workspace.id)).map((document) => ({
        ...document,
        byline: getAuthorName(document),
      }));
  const canWrite = hasWorkspaceCapability(workspace.role, 'knowledge.write');

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <PageHeader
          description={`Markdown documents shared within ${workspace.name}.`}
          eyebrow="Workspace knowledge"
          title="Knowledge"
        />
        {canWrite ? (
          <Link
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-control bg-accent px-4 text-sm font-medium text-accent-foreground shadow-sm transition-colors hover:bg-accent-hover"
            href="/knowledge/new"
          >
            <Icon className="size-4" name="plus" />
            New document
          </Link>
        ) : null}
      </div>

      <form action="/knowledge" className="mb-6 flex gap-2" method="get" role="search">
        <label className="sr-only" htmlFor="knowledge-search">
          Search workspace knowledge
        </label>
        <div className="relative flex-1">
          <Icon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            name="search"
          />
          <input
            className="h-11 w-full rounded-control border border-border bg-surface py-2 pl-10 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-2 focus:ring-accent-soft"
            defaultValue={query}
            id="knowledge-search"
            maxLength={200}
            name="q"
            placeholder="Search titles and Markdown content"
            type="search"
          />
        </div>
        <button
          className="h-11 rounded-control border border-border bg-surface px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
          type="submit"
        >
          Search
        </button>
      </form>

      {query ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {documents.length} {documents.length === 1 ? 'result' : 'results'} for “{query}”
        </p>
      ) : null}

      {documents.length ? (
        <div className="grid gap-3">
          {documents.map((document) => (
            <Link href={`/knowledge/${document.slug}`} key={document.id}>
              <Card className="transition-colors hover:border-accent/50 hover:bg-surface-raised">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-foreground">
                      {document.title}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {document.byline} · Updated{' '}
                      {document.updatedAt.toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
                    v{document.version}
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card className="grid min-h-72 place-items-center text-center">
          <div className="max-w-md">
            <span className="mx-auto grid size-12 place-items-center rounded-card bg-accent-soft text-accent">
              <Icon className="size-6" name="book" />
            </span>
            <h2 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
              {query ? 'No matching documents' : 'No documents yet'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {query
                ? 'Try different words from a document title or its Markdown content.'
                : canWrite
                  ? 'Create the first Markdown document for this workspace.'
                  : 'Documents created by workspace contributors will appear here.'}
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

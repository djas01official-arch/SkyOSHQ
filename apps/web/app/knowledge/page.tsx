import Link from 'next/link';

import { listKnowledgeDocuments } from '../../../../database/knowledge/knowledge-documents';
import {
  KNOWLEDGE_SEARCH_QUERY_MAX_CHARACTERS,
  KnowledgeSearchError,
  isKnowledgeSearchMode,
  searchWorkspaceKnowledge,
  type KnowledgeSearchMode,
  type KnowledgeSearchResult,
} from '../../../../database/knowledge/knowledge-search';

import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { StatusIndicator } from '@/components/ui/status-indicator';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { knowledgeSearchDependencies } from '@/lib/knowledge-search';
import { hasWorkspaceCapability, requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

function getAuthorName(document: {
  author: { displayName: string | null; email: string | null };
}): string {
  return document.author.displayName ?? document.author.email ?? 'Unknown author';
}

function resultHref(result: KnowledgeSearchResult): string {
  if (result.sourceType === 'attachment' && result.attachmentId) {
    return `/knowledge/${result.documentSlug}#attachment-${result.attachmentId}`;
  }
  return result.documentVersion
    ? `/knowledge/${result.documentSlug}/history/${result.documentVersion}`
    : `/knowledge/${result.documentSlug}`;
}

function resultSource(result: KnowledgeSearchResult): string {
  if (result.sourceType === 'attachment') {
    return `${result.originalFilename ?? 'Attachment'} · extraction ${result.extractionVersion ?? 'unknown'}`;
  }
  return `Markdown · version ${result.documentVersion ?? 'unknown'}`;
}

function modeLabel(mode: KnowledgeSearchMode): string {
  if (mode === 'keyword') return 'Keyword';
  if (mode === 'semantic') return 'Semantic';
  return 'Hybrid';
}

type KnowledgePageProps = Readonly<{
  searchParams: Promise<{ mode?: string | string[]; q?: string | string[] }>;
}>;

export default async function KnowledgePage({ searchParams }: KnowledgePageProps) {
  const [user, context, resolvedSearchParams] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.read'),
    searchParams,
  ]);
  const workspace = context.activeWorkspace;

  if (!workspace) return null;

  const query = typeof resolvedSearchParams.q === 'string' ? resolvedSearchParams.q.trim() : '';
  const requestedMode = resolvedSearchParams.mode;
  const mode: KnowledgeSearchMode = isKnowledgeSearchMode(requestedMode) ? requestedMode : 'hybrid';
  let results: KnowledgeSearchResult[] = [];
  let searchError: string | null = null;
  if (query) {
    try {
      results = await searchWorkspaceKnowledge(
        prisma,
        knowledgeSearchDependencies,
        user.id,
        workspace.id,
        { mode, query },
      );
    } catch (error) {
      if (!(error instanceof KnowledgeSearchError)) throw error;
      searchError = error.message;
    }
  }
  const documents = query ? [] : await listKnowledgeDocuments(prisma, user.id, workspace.id);
  const canWrite = hasWorkspaceCapability(workspace.role, 'knowledge.write');

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        action={
          canWrite ? (
            <Link className={buttonClassName({ variant: 'primary' })} href="/knowledge/new">
              <Icon className="size-4" name="plus" />
              New document
            </Link>
          ) : null
        }
        description={`Markdown and processed attachment knowledge within ${workspace.name}.`}
        eyebrow="Workspace knowledge"
        title="Knowledge"
      />

      <form
        action="/knowledge"
        className="mb-6 grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
        method="get"
        role="search"
      >
        <label className="sr-only" htmlFor="knowledge-search">
          Search workspace knowledge
        </label>
        <div className="relative">
          <Icon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            name="search"
          />
          <Input
            className="h-11 py-2 pl-10 pr-3"
            defaultValue={query}
            id="knowledge-search"
            maxLength={KNOWLEDGE_SEARCH_QUERY_MAX_CHARACTERS}
            name="q"
            placeholder="Search workspace sources"
            type="search"
          />
        </div>
        <label className="sr-only" htmlFor="knowledge-search-mode">
          Search mode
        </label>
        <Select className="h-11" defaultValue={mode} id="knowledge-search-mode" name="mode">
          <option value="hybrid">Hybrid</option>
          <option value="keyword">Keyword</option>
          <option value="semantic">Semantic</option>
        </Select>
        <Button className="h-11" type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <p className="mb-6 text-xs leading-5 text-muted-foreground">
        Search covers successfully processed chunks from the current document versions and active
        attachments. New or edited content appears after a workspace writer processes its chunks.
      </p>

      {query ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {searchError ? 'Search unavailable' : `${results.length} results`} for “{query}” ·{' '}
          {modeLabel(mode)}
        </p>
      ) : null}

      {searchError ? (
        <Card className="border-red-300 bg-red-50 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          {searchError}
        </Card>
      ) : query && results.length ? (
        <div className="grid gap-3">
          {results.map((result) => (
            <Link href={resultHref(result)} key={result.chunkId}>
              <Card className="transition-colors hover:border-accent/50 hover:bg-surface-raised">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-foreground">
                        {result.documentTitle}
                      </h2>
                      <Badge tone="accent">{result.sourceType}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {resultSource(result)} · chunk {result.chunkOrdinal + 1}
                    </p>
                    <p className="mt-3 text-sm leading-6 text-foreground">{result.excerpt}</p>
                  </div>
                  <div className="shrink-0 text-left text-xs text-muted-foreground sm:text-right">
                    <p>Rank score {result.score.final.toFixed(4)}</p>
                    <p className="mt-1">
                      {result.score.keywordRank ? `K${result.score.keywordRank}` : 'K—'} ·{' '}
                      {result.score.semanticRank ? `S${result.score.semanticRank}` : 'S—'}
                    </p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : query ? (
        <Card className="grid min-h-72 place-items-center">
          <EmptyState
            description={
              mode === 'semantic'
                ? 'No current embedded chunks matched. Process chunks and embeddings, or try keyword search.'
                : 'Try another phrase. Only current chunks from active documents and attachments are searched.'
            }
            icon="search"
            title="No matching processed knowledge"
          />
        </Card>
      ) : documents.length ? (
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
                      {getAuthorName(document)} · Updated{' '}
                      {document.updatedAt.toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <StatusIndicator tone="success">Active</StatusIndicator>
                    <Badge tone="accent">v{document.version}</Badge>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card className="grid min-h-72 place-items-center">
          <EmptyState
            description={
              canWrite
                ? 'Create the first Markdown document for this workspace.'
                : 'Documents created by workspace contributors will appear here.'
            }
            icon="book"
            title="No documents yet"
          />
        </Card>
      )}
    </div>
  );
}

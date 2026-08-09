import Link from 'next/link';

import {
  KnowledgeRetrievalError,
  retrieveKnowledgeContext,
  type RetrievedKnowledgeChunk,
} from '../../../../../database/ai/knowledge-retrieval';
import {
  KNOWLEDGE_SEARCH_QUERY_MAX_CHARACTERS,
  KnowledgeSearchError,
} from '../../../../../database/knowledge/knowledge-search';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { knowledgeRetrievalDependencies } from '@/lib/knowledge-retrieval';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

function sourceHref(item: RetrievedKnowledgeChunk): string {
  const citation = item.citation;
  if (citation.sourceType === 'attachment' && citation.attachmentId) {
    return `/knowledge/${citation.documentSlug}#attachment-${citation.attachmentId}`;
  }
  return citation.documentVersion
    ? `/knowledge/${citation.documentSlug}/history/${citation.documentVersion}`
    : `/knowledge/${citation.documentSlug}`;
}

type RetrievalPageProps = Readonly<{
  searchParams: Promise<{ q?: string | string[] }>;
}>;

export default async function RetrievalPage({ searchParams }: RetrievalPageProps) {
  const [user, context, resolvedSearchParams] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
    searchParams,
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) return null;
  const query = typeof resolvedSearchParams.q === 'string' ? resolvedSearchParams.q.trim() : '';
  let result: Awaited<ReturnType<typeof retrieveKnowledgeContext>> | null = null;
  let errorMessage: string | null = null;
  if (query) {
    try {
      result = await retrieveKnowledgeContext(
        prisma,
        knowledgeRetrievalDependencies,
        user.id,
        workspace.id,
        query,
      );
    } catch (error) {
      if (!(error instanceof KnowledgeRetrievalError || error instanceof KnowledgeSearchError)) {
        throw error;
      }
      errorMessage = error.message;
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link className="text-sm font-medium text-accent hover:underline" href="/ai">
        AI
      </Link>
      <div className="mt-3">
        <PageHeader
          description="Developer-facing inspection of selected chunks, provenance, ranking, and context limits."
          eyebrow="Grounded retrieval"
          title="Retrieval inspector"
        />
      </div>

      <form action="/ai/retrieval" className="my-6 flex gap-2" method="get" role="search">
        <label className="sr-only" htmlFor="retrieval-query">
          Inspect Knowledge retrieval
        </label>
        <div className="relative flex-1">
          <Icon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            name="search"
          />
          <Input
            className="h-11 py-2 pl-10 pr-3"
            defaultValue={query}
            id="retrieval-query"
            maxLength={KNOWLEDGE_SEARCH_QUERY_MAX_CHARACTERS}
            name="q"
            placeholder="Ask a retrieval question"
            type="search"
          />
        </div>
        <Button className="h-11" type="submit" variant="secondary">
          Inspect
        </Button>
      </form>

      {errorMessage ? (
        <Card className="border-red-300 bg-red-50 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          {errorMessage}
        </Card>
      ) : result ? (
        <>
          <Card>
            <h2 className="text-sm font-semibold text-foreground">Applied limits</h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <div>
                <dt className="text-muted-foreground">Candidates</dt>
                <dd className="font-medium text-foreground">{result.limits.candidateCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Context chars</dt>
                <dd className="font-medium text-foreground">{result.limits.characterCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Total budget</dt>
                <dd className="font-medium text-foreground">
                  {result.limits.totalCharacterBudget}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Source budget</dt>
                <dd className="font-medium text-foreground">
                  {result.limits.perSourceCharacterBudget}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Neighbor radius</dt>
                <dd className="font-medium text-foreground">{result.limits.neighborRadius}</dd>
              </div>
            </dl>
          </Card>

          {result.items.length ? (
            <div className="mt-4 grid gap-3">
              {result.items.map((item) => (
                <Card key={item.citation.id}>
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="text-xs text-accent">{item.citation.id}</code>
                        <Badge tone={item.isNeighbor ? 'neutral' : 'accent'}>
                          {item.isNeighbor ? 'neighbor' : 'match'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {item.citation.sourceType} · chunk {item.citation.chunkOrdinal + 1}
                        </span>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">
                        {item.text}
                      </p>
                      <p className="mt-3 break-all text-xs text-muted-foreground">
                        SHA-256 {item.citation.displayedExcerptChecksum}
                      </p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {item.citation.sourceType === 'attachment'
                          ? `${item.citation.filename ?? 'Attachment'} · extraction ${item.citation.extractionVersion ?? 'unknown'}`
                          : `${item.citation.documentSlug} · version ${item.citation.documentVersion ?? 'unknown'}`}{' '}
                        · set {item.citation.chunkSetId}
                      </p>
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground sm:text-right">
                      <p>RRF {item.score.final.toFixed(4)}</p>
                      <p className="mt-1">
                        offset {item.citation.characterStart ?? 'n/a'}–
                        {item.citation.characterEnd ?? 'n/a'}
                      </p>
                      <Link
                        className="mt-2 inline-block font-medium text-accent hover:underline"
                        href={sourceHref(item)}
                      >
                        Open source
                      </Link>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Card className="mt-4 text-center text-sm text-muted-foreground">
              No current grounded context was available for this query.
            </Card>
          )}
        </>
      ) : (
        <Card className="grid min-h-64 place-items-center">
          <EmptyState
            description="Enter a question to inspect the exact active workspace chunks that a future AI run may receive."
            icon="sparkles"
            title="Inspect safe context"
          />
        </Card>
      )}
    </div>
  );
}

import Link from 'next/link';

import {
  KNOWLEDGE_ACTION_DEFINITIONS,
  type listKnowledgeDocumentAiActions,
} from '../../../../database/ai/ai-conversations';
import { AiRunStatus } from '../../../../database/generated/client/client';

import { KnowledgeAiActionControls } from '@/components/knowledge/knowledge-ai-action-controls';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';

type ActionRuns = Awaited<ReturnType<typeof listKnowledgeDocumentAiActions>>;

function statusBadge(status: AiRunStatus) {
  if (status === AiRunStatus.SUCCEEDED) return <Badge tone="success">Succeeded</Badge>;
  if (status === AiRunStatus.FAILED) return <Badge tone="danger">Failed</Badge>;
  return <Badge tone="accent">Processing</Badge>;
}

export function KnowledgeAiActions({
  documentTitle,
  runs,
  slug,
  version,
  view,
}: Readonly<{
  documentTitle: string;
  runs: ActionRuns;
  slug: string;
  version: number;
  view: 'document' | 'version';
}>) {
  return (
    <Card className="mt-6" id="ai-actions">
      <CardHeader
        description={`Grounded only in ${documentTitle}, version ${version}. Results and usage are persisted as normal private AI runs.`}
        title="AI actions"
      />
      <KnowledgeAiActionControls slug={slug} version={version} view={view} />

      {runs.length ? (
        <div className="mt-6 space-y-3 border-t border-border pt-5">
          <h3 className="text-sm font-semibold text-foreground">Recent results</h3>
          {runs.map((run) => {
            const citations = run.retrievalSnapshot?.citations.filter((citation) =>
              run.referencedCitationIds.includes(citation.citationId),
            );
            const definition = run.knowledgeActionType
              ? KNOWLEDGE_ACTION_DEFINITIONS[run.knowledgeActionType]
              : null;
            return (
              <section
                className="rounded-control border border-border bg-surface-raised p-4"
                data-knowledge-ai-run={run.id}
                key={run.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {definition?.label ?? 'Knowledge AI action'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {documentTitle} · Version {version} · {run.createdAt.toLocaleString()}
                    </p>
                  </div>
                  {statusBadge(run.status)}
                </div>
                {run.assistantMessage ? (
                  <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-foreground">
                    {run.assistantMessage.content}
                  </p>
                ) : run.status === AiRunStatus.FAILED ? (
                  <p className="mt-4 text-sm text-danger">
                    {run.failureMessage ?? 'The AI provider could not complete this action.'}
                  </p>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">Generating result…</p>
                )}
                {citations?.length ? (
                  <div className="mt-4 flex flex-wrap gap-2" aria-label="Knowledge sources">
                    {citations.map((citation) => (
                      <Link
                        className="rounded-full bg-surface px-2 py-1 text-xs text-accent hover:underline"
                        href={`/knowledge/${citation.documentSlug}/history/${citation.documentVersion}`}
                        key={citation.id}
                      >
                        {documentTitle} v{citation.documentVersion} · excerpt{' '}
                        {citation.chunkOrdinal + 1}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <p className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">
          No AI actions have been run for this version by you.
        </p>
      )}
    </Card>
  );
}

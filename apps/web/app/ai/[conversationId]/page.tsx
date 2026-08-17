import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  AiConversationNotFoundError,
  getAiConversation,
} from '../../../../../database/ai/ai-conversations';

import { retryRunAction, setConversationArchivedAction } from '@/app/ai/actions';
import { AiBudgetConfirmationCard } from '@/components/ai/ai-budget-confirmation-card';
import { AiMessageComposer } from '@/components/ai/ai-message-composer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

type ConversationPageProps = Readonly<{ params: Promise<{ conversationId: string }> }>;

export default async function ConversationPage({ params }: ConversationPageProps) {
  const [{ conversationId }, user, context] = await Promise.all([
    params,
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) notFound();
  let conversation;
  try {
    conversation = await getAiConversation(
      prisma,
      user.id,
      context.activeWorkspace.id,
      conversationId,
    );
  } catch (error) {
    if (error instanceof AiConversationNotFoundError) notFound();
    throw error;
  }
  const failedRuns = conversation.runs.filter((run) => run.status === 'FAILED');
  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-accent hover:underline" href="/ai">
            AI
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-foreground">{conversation.title}</h1>
        </div>
        <form action={setConversationArchivedAction}>
          <input name="conversationId" type="hidden" value={conversation.id} />
          <input name="archived" type="hidden" value="true" />
          <Button size="small" type="submit" variant="danger">
            Archive
          </Button>
        </form>
      </div>
      <div className="mt-7 space-y-4">
        {conversation.messages.map((message) => {
          const snapshot =
            message.generatedByRun?.groundedContext ?? message.generatedByRun?.retrievalSnapshot;
          const citations = snapshot?.citations.filter((citation) =>
            message.generatedByRun?.referencedCitationIds.includes(citation.citationId),
          );
          const confirmation = message.routingDecision?.budgetConfirmation;
          return (
            <div key={message.id}>
              <Card
                className={
                  message.role === 'USER' ? 'ml-auto max-w-2xl bg-accent-soft' : 'mr-auto max-w-3xl'
                }
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {message.role === 'USER' ? 'You' : 'SkyOS'}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">
                  {message.content}
                </p>
                {citations?.length ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {citations.map((citation) => (
                      <Link
                        className="rounded-full bg-surface px-2 py-1 text-xs text-accent"
                        href={`/knowledge/${citation.documentSlug}${citation.attachmentId ? `#attachment-${citation.attachmentId}` : `/history/${citation.documentVersion}`}`}
                        key={citation.id}
                      >
                        {citation.filename ??
                          `${citation.documentSlug} v${citation.documentVersion}`}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </Card>
              {confirmation ? (
                <AiBudgetConfirmationCard
                  confirmationId={confirmation.id}
                  executionState={confirmation.executionClaim?.status ?? 'NOT_STARTED'}
                  proposedReserveUsd={confirmation.proposedReserveUsd.toFixed(12)}
                  status={confirmation.status}
                />
              ) : null}
            </div>
          );
        })}
        {!conversation.messages.length ? (
          <Card className="text-sm text-muted-foreground">Ask the first grounded question.</Card>
        ) : null}
      </div>
      {failedRuns.length ? (
        <div className="mt-4 space-y-2">
          {failedRuns.map((run) => (
            <Card className="flex items-center justify-between gap-3 border-danger/30" key={run.id}>
              <span className="text-sm text-danger">{run.failureMessage}</span>
              <form action={retryRunAction}>
                <input name="conversationId" type="hidden" value={conversation.id} />
                <input name="runId" type="hidden" value={run.id} />
                <Button size="small" type="submit" variant="secondary">
                  Retry
                </Button>
              </form>
            </Card>
          ))}
        </div>
      ) : null}
      <AiMessageComposer conversationId={conversation.id} />
    </div>
  );
}

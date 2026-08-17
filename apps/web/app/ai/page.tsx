import Link from 'next/link';

import { listAiConversations } from '../../../../database/ai/ai-conversations';

import { createConversationAction, setConversationArchivedAction } from '@/app/ai/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { hasWorkspaceCapability, requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export default async function AiPage() {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) return null;
  const conversations = await listAiConversations(prisma, user.id, workspace.id, true);
  const active = conversations.filter((conversation) => conversation.status === 'ACTIVE');
  const archived = conversations.filter((conversation) => conversation.status === 'ARCHIVED');

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        action={
          <form action={createConversationAction} data-ai-conversation-form="create">
            <Button type="submit" variant="primary">
              <Icon className="size-4" name="plus" />
              New conversation
            </Button>
          </form>
        }
        description={`Grounded AI conversations for ${workspace.name}.`}
        eyebrow="Workspace AI"
        title="AI"
      />
      <div className="mb-5 flex flex-wrap justify-end gap-4">
        <Link className="text-sm font-medium text-accent hover:underline" href="/ai/retrieval">
          Open retrieval inspector
        </Link>
        {hasWorkspaceCapability(workspace.role, 'workspace.members.read') ? (
          <>
            <Link className="text-sm font-medium text-accent hover:underline" href="/ai/usage">
              Open usage and cost
            </Link>
            <Link className="text-sm font-medium text-accent hover:underline" href="/ai/recovery">
              Open execution recovery
            </Link>
          </>
        ) : null}
      </div>
      <div className="grid gap-3">
        {active.map((conversation) => (
          <Link href={`/ai/${conversation.id}`} key={conversation.id}>
            <Card className="hover:border-accent/50 hover:bg-surface-raised">
              <h2 className="font-semibold text-foreground">{conversation.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Updated {conversation.updatedAt.toLocaleString()}
              </p>
            </Card>
          </Link>
        ))}
        {!active.length ? (
          <Card>
            <EmptyState
              description="Start a grounded workspace conversation when you are ready."
              icon="sparkles"
              title="No active conversations"
            />
          </Card>
        ) : null}
      </div>
      {archived.length ? (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-foreground">Archived</h2>
          <div className="mt-3 grid gap-2">
            {archived.map((conversation) => (
              <Card className="flex items-center justify-between gap-3" key={conversation.id}>
                <span className="text-sm text-muted-foreground">{conversation.title}</span>
                <form action={setConversationArchivedAction}>
                  <input name="conversationId" type="hidden" value={conversation.id} />
                  <input name="archived" type="hidden" value="false" />
                  <Button size="small" type="submit" variant="ghost">
                    Restore
                  </Button>
                </form>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

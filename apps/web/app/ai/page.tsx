import Link from 'next/link';

import { listAiConversations } from '../../../../database/ai/ai-conversations';

import { createConversationAction, setConversationArchivedAction } from '@/app/ai/actions';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
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
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <PageHeader
          description={`Grounded AI conversations for ${workspace.name}.`}
          eyebrow="Workspace AI"
          title="AI"
        />
        <form action={createConversationAction}>
          <button
            className="h-10 rounded-control bg-accent px-4 text-sm font-medium text-accent-foreground"
            type="submit"
          >
            New conversation
          </button>
        </form>
      </div>
      <div className="mb-5 flex justify-end">
        <Link className="text-sm font-medium text-accent hover:underline" href="/ai/retrieval">
          Open retrieval inspector
        </Link>
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
          <Card className="text-sm text-muted-foreground">No active conversations.</Card>
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
                  <button className="text-sm font-medium text-accent" type="submit">
                    Restore
                  </button>
                </form>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

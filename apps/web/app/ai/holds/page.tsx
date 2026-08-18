import { listWorkspaceAiBudgetHolds } from '../../../../../database/ai/ai-budget-hold-resolution';

import { AiBudgetHoldsOperations } from '@/components/ai/ai-budget-holds-operations';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export default async function AiBudgetHoldsPage() {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('workspace.members.manage'),
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) return null;
  const candidates = await listWorkspaceAiBudgetHolds(prisma, user.id, workspace.id);

  return <AiBudgetHoldsOperations candidates={candidates} workspaceName={workspace.name} />;
}

import { getAiUsageDashboard } from '../../../../../database/ai/ai-usage';

import { AiUsageDashboardView } from '@/components/ai/ai-usage-dashboard';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export default async function AiUsagePage() {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('workspace.members.read'),
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) return null;
  const dashboard = await getAiUsageDashboard(prisma, user.id, workspace.id);

  return <AiUsageDashboardView dashboard={dashboard} workspaceName={workspace.name} />;
}

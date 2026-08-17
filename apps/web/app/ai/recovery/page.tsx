import { listWorkspaceAiExecutionRecoveryCandidates } from '../../../../../database/ai/ai-budget-execution-recovery';

import { AiExecutionRecoveryOperations } from '@/components/ai/ai-execution-recovery-operations';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export default async function AiExecutionRecoveryPage() {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('workspace.members.read'),
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) return null;
  const candidates = await listWorkspaceAiExecutionRecoveryCandidates(
    prisma,
    user.id,
    workspace.id,
  );

  return <AiExecutionRecoveryOperations candidates={candidates} workspaceName={workspace.name} />;
}

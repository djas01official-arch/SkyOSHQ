'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  recoverWorkspaceAiBudgetExecution,
  type AiBudgetExecutionRecoveryAction,
} from '../../../../../database/ai/ai-budget-execution-recovery-actions';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type AiExecutionRecoveryActionState = Readonly<{
  error: string | null;
  notice: string | null;
}>;

function executionClaimId(formData: FormData): string | null {
  const value = formData.get('executionClaimId');
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function noticeFor(action: AiBudgetExecutionRecoveryAction): string | null {
  switch (action) {
    case 'RECOVERED_RELEASED_ZERO_ATTEMPT':
      return 'Recovery completed. Reserved budget was released.';
    case 'RECOVERED_SETTLED_KNOWN_COST':
      return 'Recovery completed. Persisted provider cost was reconciled.';
    case 'RECOVERED_HELD_KNOWN_COST':
      return 'Execution ownership was closed. Budget remains reserved under the existing budget hold.';
    case 'RECOVERED_HELD_UNKNOWN_COST':
      return 'Execution ownership was closed. Budget remains reserved because provider cost is unresolved.';
    case 'RECOVERED_TERMINAL_FINANCIAL_STATE':
      return 'Recovery completed. Existing financial state was preserved.';
    case 'RECOVERY_ALREADY_TERMINAL':
      return 'This execution was already closed.';
    case 'RECOVERY_NOT_REQUIRED':
      return 'This execution no longer requires recovery.';
    case 'RECOVERY_INDETERMINATE':
      return null;
    case 'RECOVERY_RECONCILIATION_FAILED':
      return null;
    case 'RECOVERY_CLAIM_FINISH_FAILED':
      return null;
  }
}

function errorFor(action: AiBudgetExecutionRecoveryAction): string | null {
  switch (action) {
    case 'RECOVERY_INDETERMINATE':
      return 'Recovery was not performed because persisted evidence is inconclusive.';
    case 'RECOVERY_RECONCILIATION_FAILED':
      return 'Recovery could not complete financial reconciliation. No execution retry was attempted.';
    case 'RECOVERY_CLAIM_FINISH_FAILED':
      return 'Financial recovery completed, but execution ownership could not be closed. Review the execution again.';
    default:
      return null;
  }
}

/**
 * Performs one explicit terminal recovery. The browser supplies only the claim
 * ID; active workspace and operator identity are reconstructed from the
 * authenticated server context, and the recovery service re-inspects evidence.
 */
export async function recoverExecutionAction(
  _previousState: AiExecutionRecoveryActionState,
  formData: FormData,
): Promise<AiExecutionRecoveryActionState> {
  const claimId = executionClaimId(formData);
  if (!claimId) {
    return { error: 'This execution is unavailable. Refresh and try again.', notice: null };
  }

  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('workspace.members.manage'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');

  try {
    const result = await recoverWorkspaceAiBudgetExecution(prisma, {
      executionClaimId: claimId,
      operatorUserId: user.id,
      workspaceId: context.activeWorkspace.id,
    });
    revalidatePath('/ai/recovery');
    return { error: errorFor(result.action), notice: noticeFor(result.action) };
  } catch {
    return {
      error:
        'This execution could not be recovered safely. Refresh and review the current evidence.',
      notice: null,
    };
  }
}

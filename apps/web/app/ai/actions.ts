'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  AiConversationBudgetError,
  AiConversationError,
  AiConversationRateLimitError,
  AiConversationValidationError,
  createAiConversation,
  retryAiRun,
  setAiConversationArchived,
  submitAiChatMessage,
} from '../../../../database/ai/ai-conversations';
import {
  resumeApprovedAiBudgetExecution,
  reserveApprovedAiBudgetConfirmationForExecution,
} from '../../../../database/ai/ai-budget-confirmation-execution';
import {
  AiBudgetConfirmationStateError,
  approveAiBudgetConfirmation,
  rejectAiBudgetConfirmation,
} from '../../../../database/ai/ai-budget-confirmations';
import { AiBudgetConfirmationStatus } from '../../../../database/generated/client/client';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { aiConversationDependencies } from '@/lib/ai-conversations';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type AiMessageActionState = Readonly<{ error: string | null }>;
export type AiBudgetConfirmationActionState = Readonly<{
  error: string | null;
  status: 'APPROVED' | 'REJECTED' | null;
}>;
export type AiBudgetConfirmationContinueActionState = Readonly<{
  error: string | null;
  executionState: 'FINISHED' | 'RECONFIRMATION_REQUIRED' | 'STARTED' | null;
  notice: string | null;
}>;

function value(formData: FormData, name: string): string {
  const input = formData.get(name);
  return typeof input === 'string' ? input : '';
}

export async function createConversationAction(): Promise<void> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');
  const conversation = await createAiConversation(prisma, user.id, context.activeWorkspace.id);
  redirect(`/ai/${conversation.id}`);
}

export async function submitMessageAction(
  _previousState: AiMessageActionState,
  formData: FormData,
): Promise<AiMessageActionState> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');
  const conversationId = value(formData, 'conversationId');
  if (!conversationId) {
    return { error: 'The AI conversation is unavailable. Refresh and try again.' };
  }
  try {
    const result = await submitAiChatMessage(
      prisma,
      aiConversationDependencies,
      user.id,
      context.activeWorkspace.id,
      conversationId,
      value(formData, 'message'),
    );
    if (result.mode !== 'FAST' && !result.responseRun) {
      return { error: 'The AI response could not be generated.' };
    }
  } catch (error) {
    if (
      error instanceof AiConversationBudgetError &&
      error.code === 'budget_confirmation_required' &&
      error.confirmationId
    ) {
      revalidatePath('/ai');
      revalidatePath(`/ai/${conversationId}`);
      redirect(`/ai/${conversationId}`);
    }
    if (
      error instanceof AiConversationValidationError ||
      error instanceof AiConversationRateLimitError
    ) {
      return { error: error.message };
    }
    if (error instanceof AiConversationError) {
      return { error: 'The AI request could not be completed in this workspace.' };
    }
    throw error;
  }
  revalidatePath('/ai');
  revalidatePath(`/ai/${conversationId}`);
  redirect(`/ai/${conversationId}`);
}

async function readTerminalBudgetConfirmationStatus(
  confirmationId: string,
  userId: string,
  workspaceId: string,
): Promise<'APPROVED' | 'REJECTED' | null> {
  const confirmation = await prisma.aiBudgetConfirmation.findFirst({
    where: {
      id: confirmationId,
      requestedByUserId: userId,
      workspaceId,
    },
    select: { status: true },
  });
  if (confirmation?.status === AiBudgetConfirmationStatus.APPROVED) return 'APPROVED';
  if (confirmation?.status === AiBudgetConfirmationStatus.REJECTED) return 'REJECTED';
  return null;
}

async function readBudgetConfirmationExecutionState(
  confirmationId: string,
  userId: string,
  workspaceId: string,
): Promise<'FINISHED' | 'STARTED' | null> {
  const confirmation = await prisma.aiBudgetConfirmation.findFirst({
    where: {
      id: confirmationId,
      requestedByUserId: userId,
      workspaceId,
    },
    select: { executionClaim: { select: { status: true } } },
  });
  if (confirmation?.executionClaim?.status === 'FINISHED') return 'FINISHED';
  if (confirmation?.executionClaim?.status === 'STARTED') return 'STARTED';
  return null;
}

async function decideBudgetConfirmationAction(
  formData: FormData,
  operation: 'approve' | 'reject',
): Promise<AiBudgetConfirmationActionState> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');

  const confirmationId = value(formData, 'confirmationId');
  if (!confirmationId) {
    return {
      error: 'This budget confirmation is unavailable. Refresh and try again.',
      status: null,
    };
  }

  try {
    const confirmation = await (
      operation === 'approve' ? approveAiBudgetConfirmation : rejectAiBudgetConfirmation
    )(prisma, {
      actorUserId: user.id,
      confirmationId,
      workspaceId: context.activeWorkspace.id,
    });
    revalidatePath('/ai', 'layout');
    return {
      error: null,
      status: confirmation.status === AiBudgetConfirmationStatus.APPROVED ? 'APPROVED' : 'REJECTED',
    };
  } catch (error) {
    if (error instanceof AiBudgetConfirmationStateError) {
      const status = await readTerminalBudgetConfirmationStatus(
        confirmationId,
        user.id,
        context.activeWorkspace.id,
      );
      if (status) {
        revalidatePath('/ai', 'layout');
        return { error: null, status };
      }
    }
    return {
      error:
        operation === 'approve'
          ? 'Could not approve this request. Please try again.'
          : 'Could not reject this request. Please try again.',
      status: null,
    };
  }
}

export async function approveBudgetConfirmationAction(
  _previousState: AiBudgetConfirmationActionState,
  formData: FormData,
): Promise<AiBudgetConfirmationActionState> {
  return decideBudgetConfirmationAction(formData, 'approve');
}

export async function rejectBudgetConfirmationAction(
  _previousState: AiBudgetConfirmationActionState,
  formData: FormData,
): Promise<AiBudgetConfirmationActionState> {
  return decideBudgetConfirmationAction(formData, 'reject');
}

const initialContinueState: AiBudgetConfirmationContinueActionState = {
  error: null,
  executionState: null,
  notice: null,
};

function reservationFailureMessage(outcome: string): string {
  switch (outcome) {
    case 'RECONFIRMATION_REQUIRED':
      return 'This approval is no longer valid for the current request. Submit the request again to review the updated budget.';
    case 'BUDGET_REJECTED':
    case 'RESERVATION_FAILED':
      return 'This request cannot continue under the current budget. Review the available budget and submit it again.';
    default:
      return 'This approved request is unavailable. Refresh and try again.';
  }
}

/**
 * Resumes exactly one already-approved request. The submitted form contains
 * only its confirmation ID; identity, pricing, reservation, and execution
 * inputs are reconstructed on the server from the durable request.
 */
export async function continueBudgetConfirmationAction(
  _previousState: AiBudgetConfirmationContinueActionState,
  formData: FormData,
): Promise<AiBudgetConfirmationContinueActionState> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');

  const confirmationId = value(formData, 'confirmationId');
  if (!confirmationId) {
    return {
      ...initialContinueState,
      error: 'This approved request is unavailable. Refresh and try again.',
    };
  }

  const input = {
    actorUserId: user.id,
    confirmationId,
    workspaceId: context.activeWorkspace.id,
  };
  try {
    const existingExecutionState = await readBudgetConfirmationExecutionState(
      confirmationId,
      user.id,
      context.activeWorkspace.id,
    );
    if (existingExecutionState === 'STARTED') {
      revalidatePath('/ai', 'layout');
      return {
        error: null,
        executionState: 'STARTED',
        notice: 'Execution already started.',
      };
    }
    if (existingExecutionState === 'FINISHED') {
      revalidatePath('/ai', 'layout');
      return {
        error: null,
        executionState: 'FINISHED',
        notice: 'Completed.',
      };
    }
    const reservation = await reserveApprovedAiBudgetConfirmationForExecution(
      prisma,
      aiConversationDependencies,
      input,
    );
    if (reservation.outcome !== 'RESERVED') {
      revalidatePath('/ai', 'layout');
      return {
        ...initialContinueState,
        error: reservationFailureMessage(reservation.outcome),
        executionState:
          reservation.outcome === 'RECONFIRMATION_REQUIRED' ? 'RECONFIRMATION_REQUIRED' : null,
      };
    }

    const result = await resumeApprovedAiBudgetExecution(prisma, aiConversationDependencies, input);
    const executionState = await readBudgetConfirmationExecutionState(
      confirmationId,
      user.id,
      context.activeWorkspace.id,
    );
    revalidatePath('/ai', 'layout');

    switch (result.outcome) {
      case 'EXECUTION_ALREADY_STARTED':
        return {
          error: null,
          executionState: 'STARTED',
          notice: 'Execution already started.',
        };
      case 'EXECUTION_ALREADY_FINISHED':
        return {
          error: null,
          executionState: 'FINISHED',
          notice: 'Completed.',
        };
      case 'RECONFIRMATION_REQUIRED':
        return {
          ...initialContinueState,
          error:
            'This approval is no longer valid for the current request. Submit the request again to review the updated budget.',
          executionState: 'RECONFIRMATION_REQUIRED',
        };
      case 'FAILED_BEFORE_PROVIDER':
        return {
          error:
            result.failureCode === 'budget_reconciliation_failed'
              ? 'Execution ended, but budget reconciliation needs attention.'
              : 'The AI request could not be completed. Submit a new request to try again.',
          executionState,
          notice: null,
        };
      case 'EXECUTED':
        return {
          error:
            result.responseRun?.status === 'SUCCEEDED'
              ? null
              : 'The AI request could not be completed. Submit a new request to try again.',
          executionState,
          notice: result.responseRun?.status === 'SUCCEEDED' ? 'Completed.' : null,
        };
    }
  } catch {
    return {
      ...initialContinueState,
      error: 'This approved request could not be continued safely. Refresh and try again.',
    };
  }
}

export async function retryRunAction(formData: FormData): Promise<void> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');
  const conversationId = value(formData, 'conversationId');
  await retryAiRun(
    prisma,
    aiConversationDependencies,
    user.id,
    context.activeWorkspace.id,
    value(formData, 'runId'),
  );
  revalidatePath(`/ai/${conversationId}`);
  redirect(`/ai/${conversationId}`);
}

export async function setConversationArchivedAction(formData: FormData): Promise<void> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');
  await setAiConversationArchived(
    prisma,
    user.id,
    context.activeWorkspace.id,
    value(formData, 'conversationId'),
    value(formData, 'archived') === 'true',
  );
  revalidatePath('/ai');
  redirect('/ai');
}

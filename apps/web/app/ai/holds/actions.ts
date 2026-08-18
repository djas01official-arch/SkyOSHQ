'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  resolveAiBudgetHold,
  type AiBudgetHoldResolutionClassification,
  type ResolveAiBudgetHoldResult,
} from '../../../../../database/ai/ai-budget-hold-resolution';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type AiBudgetHoldResolveActionState = Readonly<{
  error: string | null;
  notice: string | null;
}>;

function reservationId(formData: FormData): string | null {
  const value = formData.get('reservationId');
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resultState(result: ResolveAiBudgetHoldResult): AiBudgetHoldResolveActionState {
  if (result.action === 'RELEASED') {
    return { error: null, notice: 'Hold resolved. Reserved budget was released.' };
  }
  if (result.action === 'SETTLED') {
    return { error: null, notice: 'Hold resolved. Persisted provider cost was reconciled.' };
  }

  const classification: AiBudgetHoldResolutionClassification = result.inspection.classification;
  switch (classification) {
    case 'ALREADY_RESOLVED':
      return { error: null, notice: 'This hold has already been resolved.' };
    case 'BLOCKED_UNKNOWN_COST':
      return {
        error: 'Resolution was not performed because provider cost remains unresolved.',
        notice: null,
      };
    case 'BLOCKED_OVERRUN':
      return {
        error: 'Resolution was not performed because recorded cost exceeds the reservation.',
        notice: null,
      };
    case 'INDETERMINATE':
      return {
        error: 'Resolution was not performed because persisted evidence is inconclusive.',
        notice: null,
      };
    default:
      return {
        error: 'Hold resolution could not be completed. No provider execution was attempted.',
        notice: null,
      };
  }
}

/**
 * Resolves one current hold through its evidence-driven domain service. The
 * browser supplies only a reservation ID; the authenticated operator and
 * active workspace are always derived on the server.
 */
export async function resolveBudgetHoldAction(
  _previousState: AiBudgetHoldResolveActionState,
  formData: FormData,
): Promise<AiBudgetHoldResolveActionState> {
  const submittedReservationId = reservationId(formData);
  if (!submittedReservationId) {
    return { error: 'This budget hold is unavailable. Refresh and try again.', notice: null };
  }

  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('workspace.members.manage'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');

  try {
    const result = await resolveAiBudgetHold(prisma, {
      operatorUserId: user.id,
      reservationId: submittedReservationId,
      workspaceId: context.activeWorkspace.id,
    });
    revalidatePath('/ai/holds');
    return resultState(result);
  } catch {
    revalidatePath('/ai/holds');
    return {
      error: 'Hold resolution could not be completed. No provider execution was attempted.',
      notice: null,
    };
  }
}

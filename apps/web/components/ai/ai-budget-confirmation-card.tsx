'use client';

import { useActionState } from 'react';

import {
  approveBudgetConfirmationAction,
  continueBudgetConfirmationAction,
  rejectBudgetConfirmationAction,
  type AiBudgetConfirmationActionState,
  type AiBudgetConfirmationContinueActionState,
} from '@/app/ai/actions';
import {
  formatAiBudgetConfirmationUsd,
  getAiBudgetConfirmationPresentation,
} from '@/components/ai/ai-budget-confirmation-display';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export type AiBudgetConfirmationCardProps = Readonly<{
  confirmationId: string;
  executionState: 'FINISHED' | 'NOT_STARTED' | 'READY' | 'RECONFIRMATION_REQUIRED' | 'STARTED';
  proposedReserveUsd: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}>;

const initialState: AiBudgetConfirmationActionState = { error: null, status: null };
const initialContinueState: AiBudgetConfirmationContinueActionState = {
  error: null,
  executionState: null,
  notice: null,
};

export function AiBudgetConfirmationCard({
  confirmationId,
  executionState: initialExecutionState,
  proposedReserveUsd,
  status: initialStatus,
}: AiBudgetConfirmationCardProps) {
  const [approvalState, approve, approvalPending] = useActionState(
    approveBudgetConfirmationAction,
    initialState,
  );
  const [rejectionState, reject, rejectionPending] = useActionState(
    rejectBudgetConfirmationAction,
    initialState,
  );
  const [continueState, continueExecution, continuing] = useActionState(
    continueBudgetConfirmationAction,
    initialContinueState,
  );
  const status = approvalState.status ?? rejectionState.status ?? initialStatus;
  const executionState = continueState.executionState ?? initialExecutionState;
  const copy = getAiBudgetConfirmationPresentation(status, executionState);
  const pending = approvalPending || rejectionPending || continuing;
  const amount = formatAiBudgetConfirmationUsd(proposedReserveUsd) ?? 'Unavailable';
  const error = approvalState.error ?? rejectionState.error ?? continueState.error;
  const notice = continueState.notice;

  return (
    <Card
      aria-live="polite"
      className="mt-3 max-w-2xl border-brand-bright/25 bg-surface-raised"
      data-ai-budget-confirmation={confirmationId}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">{copy.title}</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy.description}</p>
      <div className="mt-4 rounded-control border border-border bg-surface px-3 py-2">
        <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
          Estimated maximum
        </p>
        <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
          {amount}
        </p>
      </div>
      {status === 'PENDING' ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <form action={approve} data-ai-budget-confirmation-action="approve">
            <input name="confirmationId" type="hidden" value={confirmationId} />
            <Button
              aria-label="Approve this budget proposal"
              disabled={pending}
              type="submit"
              variant="primary"
            >
              {approvalPending ? 'Approving…' : 'Approve'}
            </Button>
          </form>
          <form action={reject} data-ai-budget-confirmation-action="reject">
            <input name="confirmationId" type="hidden" value={confirmationId} />
            <Button
              aria-label="Reject this budget proposal"
              disabled={pending}
              type="submit"
              variant="secondary"
            >
              {rejectionPending ? 'Rejecting…' : 'Reject'}
            </Button>
          </form>
        </div>
      ) : null}
      {status === 'APPROVED' && copy.showContinue ? (
        <div className="mt-4">
          <form action={continueExecution} data-ai-budget-confirmation-action="continue">
            <input name="confirmationId" type="hidden" value={confirmationId} />
            <Button
              aria-label="Continue this approved AI request"
              disabled={pending}
              type="submit"
              variant="primary"
            >
              {continuing ? 'Continuing…' : 'Continue'}
            </Button>
          </form>
        </div>
      ) : null}
      {notice ? (
        <p
          aria-live="polite"
          className="mt-3 text-sm leading-6 text-muted-foreground"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p aria-live="polite" className="mt-3 text-sm leading-6 text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

import type { WorkspaceAiBudgetHoldCandidate } from '../../../../database/ai/ai-budget-hold-resolution';

import { formatAiBudgetConfirmationUsd } from '@/components/ai/ai-budget-confirmation-display';
import { getAiBudgetHoldPresentation } from '@/components/ai/ai-budget-hold-display';
import { AiBudgetHoldResolveAction } from '@/components/ai/ai-budget-hold-resolve-action';
import { getAiBudgetReservationHoldReasonDisplay } from '@/components/ai/ai-execution-recovery-display';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusIndicator } from '@/components/ui/status-indicator';

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function displayMoney(value: string): string {
  return formatAiBudgetConfirmationUsd(value) ?? 'Unavailable';
}

function displayDate(value: Date | null): string {
  return value === null ? 'Not recorded' : timestampFormatter.format(value);
}

type EvidenceFieldProps = Readonly<{
  label: string;
  value: string;
}>;

function EvidenceField({ label, value }: EvidenceFieldProps) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

type AiBudgetHoldsOperationsProps = Readonly<{
  candidates: readonly WorkspaceAiBudgetHoldCandidate[];
  workspaceName: string;
}>;

/**
 * Read-only on load: a separate explicit, evidence-driven control can resolve
 * only classifications that are safe candidates for fresh server inspection.
 */
export function AiBudgetHoldsOperations({
  candidates,
  workspaceName,
}: AiBudgetHoldsOperationsProps) {
  return (
    <div className="mx-auto max-w-6xl" data-ai-budget-holds-page="read-only">
      <PageHeader
        description={`Read-only, authoritative budget-hold evidence for ${workspaceName}. Loading this page never changes a reservation or accounting record.`}
        eyebrow="AI operations"
        title="Budget holds"
      />

      <Card className="mb-6" variant="muted">
        <CardHeader
          description="These are unresolved financial states. Resolve is available only when current persisted evidence supports a safe terminal accounting action."
          title={`Current budget holds: ${candidates.length}`}
        />
      </Card>

      {candidates.length === 0 ? (
        <Card>
          <EmptyState
            description="SkyOS currently has no unresolved AI budget reservations in this workspace."
            icon="activity"
            title="No budget holds"
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          {candidates.map((candidate) => {
            const presentation = getAiBudgetHoldPresentation(
              candidate.classification,
              candidate.indeterminateReason,
            );
            return (
              <Card
                aria-label={`Budget hold: ${presentation.title}`}
                data-ai-budget-hold={candidate.reservation.id}
                key={candidate.reservation.id}
              >
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <StatusIndicator tone={presentation.tone}>{presentation.title}</StatusIndicator>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {presentation.description}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-border bg-surface-raised px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    HELD · {candidate.resolvedMode ?? 'Unavailable'}
                  </span>
                </div>

                <dl className="mt-5 grid gap-x-6 gap-y-4 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4">
                  <EvidenceField
                    label="Held at"
                    value={displayDate(candidate.reservation.heldAt)}
                  />
                  <EvidenceField
                    label="Hold reason"
                    value={
                      candidate.reservation.holdReason === null
                        ? 'Historical hold reason unavailable'
                        : getAiBudgetReservationHoldReasonDisplay(candidate.reservation.holdReason)
                    }
                  />
                  <EvidenceField
                    label="Reserved amount"
                    value={displayMoney(candidate.reservation.reservedAmountUsd)}
                  />
                  <EvidenceField
                    label="Provider attempts"
                    value={String(candidate.providerAttemptCount)}
                  />
                  <EvidenceField
                    label="Known-cost attempts"
                    value={String(candidate.knownCostAttemptCount)}
                  />
                  <EvidenceField
                    label="Unknown-cost attempts"
                    value={String(candidate.unknownCostAttemptCount)}
                  />
                  {candidate.knownAccountedCostUsd !== null ? (
                    <EvidenceField
                      label="Known accounted cost"
                      value={displayMoney(candidate.knownAccountedCostUsd)}
                    />
                  ) : null}
                  {candidate.knownPartialCostUsd !== null ? (
                    <EvidenceField
                      label="Partial known cost"
                      value={displayMoney(candidate.knownPartialCostUsd)}
                    />
                  ) : null}
                  <EvidenceField label="Reservation ID" value={candidate.reservation.id} />
                </dl>

                <div className="mt-5 rounded-control border border-border bg-surface-raised px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    Original request preview
                  </p>
                  <p className="mt-1.5 break-words text-sm leading-6 text-foreground">
                    {candidate.requestPreview}
                  </p>
                </div>
                <AiBudgetHoldResolveAction
                  classification={candidate.classification}
                  reservationId={candidate.reservation.id}
                />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

import type { WorkspaceAiBudgetExecutionRecoveryCandidate } from '../../../../database/ai/ai-budget-execution-recovery';

import { formatAiBudgetConfirmationUsd } from '@/components/ai/ai-budget-confirmation-display';
import { AiExecutionRecoveryAction } from '@/components/ai/ai-execution-recovery-action';
import {
  getAiBudgetReservationHoldReasonDisplay,
  getAiExecutionRecoveryPresentation,
} from '@/components/ai/ai-execution-recovery-display';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusIndicator } from '@/components/ui/status-indicator';

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function displayMoney(value: string | null): string {
  return value === null ? 'Unavailable' : (formatAiBudgetConfirmationUsd(value) ?? 'Unavailable');
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

type AiExecutionRecoveryOperationsProps = Readonly<{
  candidates: readonly WorkspaceAiBudgetExecutionRecoveryCandidate[];
  workspaceName: string;
}>;

export function AiExecutionRecoveryOperations({
  candidates,
  workspaceName,
}: AiExecutionRecoveryOperationsProps) {
  return (
    <div className="mx-auto max-w-6xl" data-ai-execution-recovery-page="read-only">
      <PageHeader
        description={`Read-only persisted recovery evidence for started AI executions in ${workspaceName}. Classification never uses execution age or current provider pricing.`}
        eyebrow="AI operations"
        title="AI execution recovery"
      />

      <Card className="mb-6" variant="muted">
        <CardHeader
          description="These records are started execution ownership states. They are not automatically considered stale or safe to run again."
          title={`Started executions: ${candidates.length}`}
        />
      </Card>

      {candidates.length === 0 ? (
        <Card>
          <EmptyState
            description="No executions currently require recovery inspection."
            icon="activity"
            title="No started executions"
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          {candidates.map((candidate) => {
            const presentation = getAiExecutionRecoveryPresentation(
              candidate.classification,
              candidate.indeterminateReason,
            );
            return (
              <Card
                aria-label={`Recovery inspection: ${presentation.title}`}
                data-ai-execution-recovery-candidate={candidate.executionClaimId}
                key={candidate.executionClaimId}
              >
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <StatusIndicator tone={presentation.tone}>{presentation.title}</StatusIndicator>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {presentation.description}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-border bg-surface-raised px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {candidate.resolvedMode}
                  </span>
                </div>

                <dl className="mt-5 grid gap-x-6 gap-y-4 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4">
                  <EvidenceField label="Started" value={displayDate(candidate.startedAt)} />
                  <EvidenceField label="Reservation status" value={candidate.reservation.status} />
                  {candidate.reservation.holdReason !== null ? (
                    <EvidenceField
                      label="Budget hold"
                      value={getAiBudgetReservationHoldReasonDisplay(
                        candidate.reservation.holdReason,
                      )}
                    />
                  ) : null}
                  {candidate.reservation.heldAt !== null ? (
                    <EvidenceField
                      label="Held at"
                      value={displayDate(candidate.reservation.heldAt)}
                    />
                  ) : null}
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
                  {candidate.orchestration ? (
                    <EvidenceField label="Orchestration" value={candidate.orchestration.status} />
                  ) : null}
                </dl>

                <div className="mt-5 rounded-control border border-border bg-surface-raised px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    Original request preview
                  </p>
                  <p className="mt-1.5 text-sm leading-6 text-foreground">
                    {candidate.requestPreview}
                  </p>
                </div>
                <AiExecutionRecoveryAction
                  classification={candidate.classification}
                  executionClaimId={candidate.executionClaimId}
                />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

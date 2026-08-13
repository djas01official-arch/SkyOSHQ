import type { AiUsageDashboard } from '../../../../database/ai/ai-usage';
import { AiRunStatus } from '../../../../database/generated/client/client';

import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusIndicator } from '@/components/ui/status-indicator';

const integerFormatter = new Intl.NumberFormat('en-US');
const currencyFormatter = new Intl.NumberFormat('en-US', {
  currency: 'USD',
  maximumFractionDigits: 6,
  minimumFractionDigits: 2,
  style: 'currency',
});
const timestampFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function estimatedCost(value: string | null, successfulRunCount: number): string {
  if (value === null) return successfulRunCount === 0 ? '$0.00' : 'Unavailable';
  return currencyFormatter.format(Number(value));
}

function detailedCost(value: string | null): string {
  return value === null ? 'Unknown' : currencyFormatter.format(Number(value));
}

function tokenCount(value: number | null): string {
  return value === null ? 'Unknown' : integerFormatter.format(value);
}

function RunStatus({ status }: Readonly<{ status: AiRunStatus }>) {
  switch (status) {
    case AiRunStatus.PROCESSING:
      return <StatusIndicator tone="accent">Processing</StatusIndicator>;
    case AiRunStatus.SUCCEEDED:
      return <StatusIndicator tone="success">Succeeded</StatusIndicator>;
    case AiRunStatus.FAILED:
      return <StatusIndicator tone="danger">Failed</StatusIndicator>;
  }
}

type SummaryCardProps = Readonly<{
  detail: string;
  label: string;
  value: string;
}>;

function SummaryCard({ detail, label, value }: SummaryCardProps) {
  return (
    <Card className="min-w-0" variant="muted">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-3 truncate text-2xl font-semibold tracking-[-0.035em] text-foreground">
        {value}
      </p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
    </Card>
  );
}

type AiUsageDashboardViewProps = Readonly<{
  dashboard: AiUsageDashboard;
  workspaceName: string;
}>;

export function AiUsageDashboardView({ dashboard, workspaceName }: AiUsageDashboardViewProps) {
  const { summary } = dashboard;
  const unknownCostDetail = `${integerFormatter.format(summary.unknownCostRunsMonth)} successful run${summary.unknownCostRunsMonth === 1 ? '' : 's'} excluded from estimated cost`;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        description={`Workspace-scoped operational telemetry for ${workspaceName}. All periods and timestamps use UTC.`}
        eyebrow="AI operations"
        title="AI usage and cost"
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          detail={`${summary.unknownCostRunsToday} unknown-cost run${summary.unknownCostRunsToday === 1 ? '' : 's'} excluded`}
          label="Estimated cost today"
          value={estimatedCost(summary.estimatedCostTodayUsd, summary.successfulRunsToday)}
        />
        <SummaryCard
          detail={unknownCostDetail}
          label="Estimated cost this month"
          value={estimatedCost(summary.estimatedCostMonthUsd, summary.successfulRunsMonth)}
        />
        <SummaryCard
          detail="Completed successfully this month"
          label="Successful runs"
          value={integerFormatter.format(summary.successfulRunsMonth)}
        />
        <SummaryCard
          detail="Provider-reported input usage"
          label="Input tokens"
          value={integerFormatter.format(summary.inputTokensMonth)}
        />
        <SummaryCard
          detail="Provider-reported cached reads"
          label="Cached input tokens"
          value={integerFormatter.format(summary.cachedInputTokensMonth)}
        />
        <SummaryCard
          detail="Provider-reported cache writes"
          label="Cache-write input tokens"
          value={integerFormatter.format(summary.cacheWriteInputTokensMonth)}
        />
        <SummaryCard
          detail="Provider-reported generated usage"
          label="Output tokens"
          value={integerFormatter.format(summary.outputTokensMonth)}
        />
        <SummaryCard
          detail="Input plus output for successful runs"
          label="Total tokens"
          value={integerFormatter.format(summary.totalTokensMonth)}
        />
      </div>

      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        Estimates include only configured, non-null run costs. Token totals sum only values reported
        by providers; {integerFormatter.format(summary.incompleteUsageRunsMonth)} successful run
        {summary.incompleteUsageRunsMonth === 1 ? '' : 's'} had incomplete usage metadata this
        month.
      </p>

      <Card className="mt-8 overflow-hidden p-0">
        <div className="p-5">
          <CardHeader
            description="Up to 25 newest workspace runs. Cost is never inferred when pricing or usage is unknown."
            title="Recent runs"
          />
        </div>
        {dashboard.recentRuns.length ? (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[68rem] border-collapse text-left text-sm">
              <thead className="bg-surface-raised text-xs uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-semibold" scope="col">
                    Timestamp
                  </th>
                  <th className="px-4 py-3 font-semibold" scope="col">
                    Provider / model
                  </th>
                  <th className="px-4 py-3 font-semibold" scope="col">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right font-semibold" scope="col">
                    Input
                  </th>
                  <th className="px-4 py-3 text-right font-semibold" scope="col">
                    Cached
                  </th>
                  <th className="px-4 py-3 text-right font-semibold" scope="col">
                    Output
                  </th>
                  <th className="px-4 py-3 text-right font-semibold" scope="col">
                    Estimated cost
                  </th>
                  <th className="px-5 py-3 font-semibold" scope="col">
                    Requested by
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dashboard.recentRuns.map((run) => (
                  <tr className="text-foreground" data-ai-usage-run={run.id} key={run.id}>
                    <td className="whitespace-nowrap px-5 py-4 text-muted-foreground">
                      {timestampFormatter.format(run.createdAt)}
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-medium">{run.providerKey}</p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">{run.modelKey}</p>
                    </td>
                    <td className="px-4 py-4">
                      <RunStatus status={run.status} />
                    </td>
                    <td className="px-4 py-4 text-right tabular-nums">
                      {tokenCount(run.inputTokens)}
                    </td>
                    <td className="px-4 py-4 text-right tabular-nums">
                      {tokenCount(run.cachedInputTokens)}
                    </td>
                    <td className="px-4 py-4 text-right tabular-nums">
                      {tokenCount(run.outputTokens)}
                    </td>
                    <td className="px-4 py-4 text-right tabular-nums">
                      {detailedCost(run.estimatedCostUsd)}
                    </td>
                    <td className="px-5 py-4">{run.requestingUser.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t border-border">
            <EmptyState
              description="Successful and failed AI requests in this workspace will appear here."
              icon="activity"
              title="No AI runs yet"
            />
          </div>
        )}
      </Card>
    </div>
  );
}

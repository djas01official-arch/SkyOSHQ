import { Card, CardHeader } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';

const metrics = [
  { change: '+8.4%', label: 'Active workstreams', value: '12' },
  { change: 'On track', label: 'Priority tasks', value: '28' },
  { change: 'Ready', label: 'Knowledge sources', value: '6' },
];

const activity = [
  'Workspace foundation was initialized',
  'Navigation model is ready for domain modules',
  'Shared design tokens are active',
];

type DashboardContentProps = Readonly<{
  organizationName: string;
  workspaceName: string | null;
}>;

export function DashboardContent({ organizationName, workspaceName }: DashboardContentProps) {
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        description={
          workspaceName
            ? `A focused view of the capabilities that will power ${workspaceName}.`
            : 'Select or create a workspace to establish your working context.'
        }
        eyebrow={organizationName}
        title={workspaceName ? `Welcome to ${workspaceName}.` : 'Choose a workspace.'}
      />

      <section aria-label="Workspace summary" className="grid gap-4 md:grid-cols-3">
        {metrics.map((metric) => (
          <Card className="p-5" key={metric.label}>
            <p className="text-sm font-medium text-muted-foreground">{metric.label}</p>
            <div className="mt-3 flex items-end justify-between gap-4">
              <strong className="text-3xl font-semibold tracking-tight text-foreground">
                {metric.value}
              </strong>
              <span className="rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success">
                {metric.change}
              </span>
            </div>
          </Card>
        ))}
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.8fr)]">
        <Card>
          <CardHeader
            description="This area is intentionally waiting for connected product data."
            title="Workspace activity"
          />
          <div className="mt-6 space-y-5">
            {activity.map((item, index) => (
              <div className="flex gap-3" key={item}>
                <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                  <Icon
                    className="size-3.5"
                    name={index === 0 ? 'activity' : index === 1 ? 'grid' : 'sparkles'}
                  />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">{item}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Placeholder activity for the application shell.
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Start here" />
          <div className="mt-5 space-y-3">
            <div className="rounded-control border border-border bg-surface-raised p-3">
              <p className="text-sm font-medium text-foreground">Explore AI</p>
              <p className="mt-1 text-sm text-muted-foreground">
                A future home for enterprise intelligence.
              </p>
            </div>
            <div className="rounded-control border border-border bg-surface-raised p-3">
              <p className="text-sm font-medium text-foreground">Organize knowledge</p>
              <p className="mt-1 text-sm text-muted-foreground">
                A future home for trusted context.
              </p>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}

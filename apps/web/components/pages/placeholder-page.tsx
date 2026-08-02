import { Card, CardHeader } from '@/components/ui/card';
import { Icon, type IconName } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';

type PlaceholderPageProps = {
  description: string;
  icon: IconName;
  title: string;
};

export function PlaceholderPage({ description, icon, title }: PlaceholderPageProps) {
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader description={description} eyebrow="SkyOS foundation" title={title} />
      <Card className="grid min-h-80 place-items-center overflow-hidden p-6 text-center sm:p-10">
        <div className="max-w-md">
          <span className="mx-auto grid size-12 place-items-center rounded-card bg-accent-soft text-accent">
            <Icon className="size-6" name={icon} />
          </span>
          <h2 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
            Ready for the next layer
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            This route is wired into the shared application shell and is intentionally waiting for
            its domain capabilities.
          </p>
        </div>
      </Card>
      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader
            description="Layout, accessibility, and responsive behavior are established."
            title="Foundation complete"
          />
        </Card>
        <Card>
          <CardHeader
            description="Data, workflows, and permissions can be connected without redesigning the shell."
            title="Integration ready"
          />
        </Card>
      </section>
    </div>
  );
}

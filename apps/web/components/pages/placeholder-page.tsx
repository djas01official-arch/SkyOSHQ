import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import type { IconName } from '@/components/ui/icon';
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
      <Card className="grid min-h-80 place-items-center overflow-hidden p-6 sm:p-10">
        <EmptyState
          description="This route is wired into the shared application shell and is intentionally waiting for its domain capabilities."
          icon={icon}
          title="Ready for the next layer"
        />
      </Card>
      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader
            description="Branded layout, accessible controls, and responsive behavior are established."
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

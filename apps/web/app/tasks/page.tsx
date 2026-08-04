import { PlaceholderPage } from '@/components/pages/placeholder-page';
import { requireWorkspaceCapability } from '@/lib/organization-context';

export default async function TasksPage() {
  await requireWorkspaceCapability('tasks.read');

  return (
    <PlaceholderPage
      description="A clear future home for planning, ownership, and execution."
      icon="checkSquare"
      title="Tasks"
    />
  );
}

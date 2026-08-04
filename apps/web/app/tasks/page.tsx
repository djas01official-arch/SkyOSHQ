import { PlaceholderPage } from '@/components/pages/placeholder-page';
import { requireCurrentUser } from '@/lib/auth/current-user';

export default async function TasksPage() {
  await requireCurrentUser();

  return (
    <PlaceholderPage
      description="A clear future home for planning, ownership, and execution."
      icon="checkSquare"
      title="Tasks"
    />
  );
}

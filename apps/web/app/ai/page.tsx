import { PlaceholderPage } from '@/components/pages/placeholder-page';
import { requireCurrentUser } from '@/lib/auth/current-user';

export default async function AiPage() {
  await requireCurrentUser();

  return (
    <PlaceholderPage
      description="A focused workspace for future AI-assisted operations."
      icon="sparkles"
      title="AI"
    />
  );
}

import { PlaceholderPage } from '@/components/pages/placeholder-page';
import { requireWorkspaceCapability } from '@/lib/organization-context';

export default async function AiPage() {
  await requireWorkspaceCapability('ai.use');

  return (
    <PlaceholderPage
      description="A focused workspace for future AI-assisted operations."
      icon="sparkles"
      title="AI"
    />
  );
}

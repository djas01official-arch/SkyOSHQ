import { PlaceholderPage } from '@/components/pages/placeholder-page';
import { requireWorkspaceCapability } from '@/lib/organization-context';

export default async function KnowledgePage() {
  await requireWorkspaceCapability('knowledge.read');

  return (
    <PlaceholderPage
      description="A trusted home for future organizational context and documents."
      icon="book"
      title="Knowledge"
    />
  );
}

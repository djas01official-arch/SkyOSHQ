import { PlaceholderPage } from '@/components/pages/placeholder-page';
import { requireCurrentUser } from '@/lib/auth/current-user';

export default async function KnowledgePage() {
  await requireCurrentUser();

  return (
    <PlaceholderPage
      description="A trusted home for future organizational context and documents."
      icon="book"
      title="Knowledge"
    />
  );
}

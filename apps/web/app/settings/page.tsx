import { PlaceholderPage } from '@/components/pages/placeholder-page';
import { requireCurrentUser } from '@/lib/auth/current-user';

export default async function SettingsPage() {
  await requireCurrentUser();

  return (
    <PlaceholderPage
      description="A future control surface for workspace and platform configuration."
      icon="settings"
      title="Settings"
    />
  );
}

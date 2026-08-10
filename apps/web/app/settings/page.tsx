import { OrganizationWorkspaceSettings } from '@/components/settings/organization-workspace-settings';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { getCurrentOrganizationContext } from '@/lib/organization-context';

export default async function SettingsPage() {
  await requireCurrentUser();
  const context = await getCurrentOrganizationContext();

  return <OrganizationWorkspaceSettings context={context} />;
}

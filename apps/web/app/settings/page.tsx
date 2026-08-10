import { OrganizationWorkspaceSettings } from '@/components/settings/organization-workspace-settings';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { getCurrentOrganizationContext } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

import { getTenantManagementContext } from '../../../../database/context/tenant-management';

export default async function SettingsPage() {
  const user = await requireCurrentUser();
  const context = await getCurrentOrganizationContext();
  const management = await getTenantManagementContext(prisma, user.id, {
    activeOrganizationId: context?.activeOrganization?.id,
    activeWorkspaceId: context?.activeWorkspace?.id,
  });

  return <OrganizationWorkspaceSettings context={context} management={management} />;
}

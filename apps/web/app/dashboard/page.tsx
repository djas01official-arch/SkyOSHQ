import { DashboardContent } from '@/components/pages/dashboard-content';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { getCurrentOrganizationContext } from '@/lib/organization-context';

export default async function DashboardPage() {
  await requireCurrentUser();
  const context = await getCurrentOrganizationContext();

  return (
    <DashboardContent
      organizationName={context?.activeOrganization?.name ?? 'SkyOS'}
      workspaceName={context?.activeWorkspace?.name ?? null}
    />
  );
}

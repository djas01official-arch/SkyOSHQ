import { DashboardContent } from '@/components/pages/dashboard-content';
import { requireCurrentUser } from '@/lib/auth/current-user';

export default async function DashboardPage() {
  await requireCurrentUser();

  return <DashboardContent />;
}

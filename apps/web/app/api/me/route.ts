import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth/current-user';
import { getCurrentOrganizationContext } from '@/lib/organization-context';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const context = await getCurrentOrganizationContext();

  return NextResponse.json({
    context: context
      ? {
          activeOrganization: context.activeOrganization,
          activeWorkspace: context.activeWorkspace,
        }
      : null,
    user,
  });
}

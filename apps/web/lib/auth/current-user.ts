import { redirect } from 'next/navigation';
import { cache } from 'react';

import {
  findActiveSessionUser,
  type ActiveSessionUser,
} from '../../../../database/auth/session-user';
import { createSkyOsLogger } from '../../../../services/observability/logger';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

export type CurrentUser = ActiveSessionUser;

const observabilityLogger = createSkyOsLogger('web');

/**
 * Request-scoped session resolution for React Server Components.
 * React invalidates this cache across server requests.
 */
export const getCurrentSession = cache(async () => auth());

/**
 * Returns only an active, non-deleted user.
 *
 * The lookup is request-scoped so pages that compose authentication and
 * organization/workspace context do not repeat the same active-user query
 * during a single server render.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await getCurrentSession();
  const userId = session?.user?.id;

  if (!userId) {
    return null;
  }

  const activeUserStartedAt = Date.now();
  const user = await findActiveSessionUser(prisma, userId);
  const activeUserDurationMs = Date.now() - activeUserStartedAt;

  if (activeUserDurationMs >= 50) {
    observabilityLogger.info({
      operation: 'task9.current_user_lookup_slow',
      status: 'SLOW',
      duration_ms: activeUserDurationMs,
    });
  }

  return user;
});

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  return user;
}

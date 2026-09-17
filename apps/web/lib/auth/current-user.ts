import { redirect } from 'next/navigation';
import { cache } from 'react';

import type { ActiveSessionUser } from '../../../../database/auth/session-user';
import { task9Timed } from '../../../../database/operations/task9-runtime-diagnostics';

import { auth } from '@/auth';

export type CurrentUser = ActiveSessionUser;

/**
 * Request-scoped session resolution for React Server Components.
 * React invalidates this cache across server requests.
 */
export const getCurrentSession = cache(async () =>
  task9Timed('task9.auth_resolution', () => auth()),
);

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

  if (!session || !userId) {
    return null;
  }

  return {
    displayName: session.activeUserDisplayName,
    email: session.activeUserEmail,
    id: userId,
    image: session.activeUserImage,
  };
});

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  return user;
}

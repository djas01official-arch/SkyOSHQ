import { redirect } from 'next/navigation';

import {
  findActiveSessionUser,
  type ActiveSessionUser,
} from '../../../../database/auth/session-user';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

export type CurrentUser = ActiveSessionUser;

/** Returns only an active, non-deleted user. A valid session alone is not sufficient. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return null;
  }

  return findActiveSessionUser(prisma, userId);
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  return user;
}

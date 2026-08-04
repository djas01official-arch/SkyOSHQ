import { redirect } from 'next/navigation';

import { UserStatus } from '../../../../database/generated/client/client';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

export type CurrentUser = {
  displayName: string | null;
  email: string;
  id: string;
  image: string | null;
};

/** Returns only an active, non-deleted user. A valid session alone is not sufficient. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return null;
  }

  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      id: userId,
      status: UserStatus.ACTIVE,
    },
    select: {
      displayName: true,
      email: true,
      id: true,
      image: true,
      name: true,
    },
  });

  if (!user?.email) {
    return null;
  }

  return {
    displayName: user.displayName ?? user.name,
    email: user.email,
    id: user.id,
    image: user.image,
  };
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  return user;
}

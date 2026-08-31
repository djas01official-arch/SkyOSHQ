import { UserStatus, type PrismaClient } from '../generated/client/client';

export type ActiveSessionUser = {
  displayName: string | null;
  email: string | null;
  id: string;
  image: string | null;
};

/** Resolves a signed session subject to a currently active SkyOS user. */
export async function findActiveSessionUser(
  prisma: PrismaClient,
  userId: string,
): Promise<ActiveSessionUser | null> {
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

  if (!user) {
    return null;
  }

  return {
    displayName: user.displayName ?? user.name,
    email: user.email,
    id: user.id,
    image: user.image,
  };
}

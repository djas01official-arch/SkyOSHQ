import { PrismaAdapter } from '@auth/prisma-adapter';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

import { authenticateCredentials } from '../../database/auth/credentials';
import { getOrganizationContext } from '../../database/context/organization-context';

import { prisma } from '@/lib/prisma';

function getSessionSelection(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export const { auth, handlers, signIn, signOut, unstable_update } = NextAuth({
  adapter: PrismaAdapter(prisma),
  callbacks: {
    authorized({ auth: session }) {
      return Boolean(session?.user);
    },
    async jwt({ session, token, trigger, user }) {
      const userId = user?.id ?? token.sub;

      if (!userId || (trigger !== 'signIn' && trigger !== 'update')) {
        return token;
      }

      const context = await getOrganizationContext(prisma, userId, {
        activeOrganizationId:
          trigger === 'update' ? getSessionSelection(session?.activeOrganizationId) : null,
        activeWorkspaceId:
          trigger === 'update' ? getSessionSelection(session?.activeWorkspaceId) : null,
      });

      token.activeOrganizationId = context.activeOrganization?.id ?? null;
      token.activeWorkspaceId = context.activeWorkspace?.id ?? null;

      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }

      session.activeOrganizationId = getSessionSelection(token.activeOrganizationId);
      session.activeWorkspaceId = getSessionSelection(token.activeWorkspaceId);

      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      name: 'Development credentials',
      async authorize(credentials) {
        return authenticateCredentials(prisma, credentials);
      },
    }),
  ],
  session: {
    strategy: 'jwt',
  },
});

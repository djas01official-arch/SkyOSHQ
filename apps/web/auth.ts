import { PrismaAdapter } from '@auth/prisma-adapter';
import NextAuth from 'next-auth';

import { authenticateCredentials } from '../../database/auth/credentials';
import {
  admitPreProvisionedGoogleIdentity,
  recordGoogleIdentitySignInSuccess,
} from '../../database/auth/google-identity';
import { findActiveSessionUser } from '../../database/auth/session-user';
import { getOrganizationContext } from '../../database/context/organization-context';

import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  getSessionCookie,
  hasAuthenticatedUser,
  requireAuthSecret,
} from '@/lib/auth/security';
import { createSkyosAuthProviders } from '@/lib/auth/auth-providers';
import { isDevelopmentCredentialsEnabled } from '@/lib/auth/development-credentials';
import { getGoogleOidcConfiguration } from '@/lib/auth/google-oidc';
import { prisma } from '@/lib/prisma';
import { createSkyOsLogger } from '../../services/observability/logger';

const observabilityLogger = createSkyOsLogger('web');

function getSessionSelection(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

type AuthResult = ReturnType<typeof NextAuth>;

let authResult: AuthResult | undefined;

function getAuthResult(): AuthResult {
  if (authResult) return authResult;

  authResult = NextAuth({
    trustHost: true,
    adapter: PrismaAdapter(prisma),
    callbacks: {
      authorized({ auth: session }) {
        const authorized = hasAuthenticatedUser(session);
        if (!authorized) {
          observabilityLogger.warning({
            operation: 'security.authorization_failure',
            status: 'DENIED',
            error_category: 'authorization',
            error_code: 'protected_route_denied',
          });
        }
        return authorized;
      },
      async signIn({ account, profile }) {
        if (account?.provider === 'google') {
          const allowed = (await admitPreProvisionedGoogleIdentity(prisma, { account, profile }))
            .allowed;
          if (!allowed) {
            observabilityLogger.warning({
              operation: 'security.authentication_failure',
              provider: 'google',
              status: 'DENIED',
              error_category: 'authentication',
              error_code: 'identity_not_admitted',
            });
          }
          return allowed;
        }

        const allowed =
          account?.provider === 'credentials' &&
          isDevelopmentCredentialsEnabled(process.env.NODE_ENV);
        if (!allowed) {
          observabilityLogger.warning({
            operation: 'security.authentication_failure',
            provider: account?.provider ?? 'unknown',
            status: 'DENIED',
            error_category: 'authentication',
            error_code: 'provider_not_allowed',
          });
        }
        return allowed;
      },
      async jwt({ session, token, trigger, user }) {
        const userId = user?.id ?? token.sub;

        if (!userId || !(await findActiveSessionUser(prisma, userId))) {
          return null;
        }

        if (trigger !== 'signIn' && trigger !== 'update') {
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
    events: {
      async signIn({ account, profile, user }) {
        if (account?.provider === 'google' && user.id) {
          await recordGoogleIdentitySignInSuccess(prisma, { account, profile, userId: user.id });
        }
      },
    },
    pages: {
      signIn: '/login',
    },
    cookies: {
      sessionToken: getSessionCookie(process.env.NODE_ENV === 'production'),
    },
    providers: createSkyosAuthProviders(
      (credentials) => authenticateCredentials(prisma, credentials),
      {
        googleOidcConfiguration: getGoogleOidcConfiguration(),
        runtime: process.env.NODE_ENV,
      },
    ),
    session: {
      maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
      strategy: 'jwt',
    },
    secret: requireAuthSecret(process.env.AUTH_SECRET),
  });

  return authResult;
}

export const auth = ((...args: unknown[]) =>
  (getAuthResult().auth as (...parameters: unknown[]) => unknown)(...args)) as AuthResult['auth'];

export const handlers = {
  GET: (...args: Parameters<AuthResult['handlers']['GET']>) =>
    getAuthResult().handlers.GET(...args),
  POST: (...args: Parameters<AuthResult['handlers']['POST']>) =>
    getAuthResult().handlers.POST(...args),
};

export const signIn = ((...args: unknown[]) =>
  (getAuthResult().signIn as (...parameters: unknown[]) => unknown)(
    ...args,
  )) as AuthResult['signIn'];

export const signOut = ((...args: unknown[]) =>
  (getAuthResult().signOut as (...parameters: unknown[]) => unknown)(
    ...args,
  )) as AuthResult['signOut'];

export const unstable_update = ((...args: unknown[]) =>
  (getAuthResult().unstable_update as (...parameters: unknown[]) => unknown)(
    ...args,
  )) as AuthResult['unstable_update'];

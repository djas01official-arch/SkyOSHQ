import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import type { User } from 'next-auth';

import { isDevelopmentCredentialsEnabled } from './development-credentials';
import { type GoogleOidcConfiguration } from './google-oidc';

export type DevelopmentCredentialsAuthorizer = (
  credentials: Readonly<{ email?: unknown; password?: unknown }>,
) => Promise<User | null>;

export type AuthProviderRegistrationOptions = Readonly<{
  googleOidcConfiguration?: GoogleOidcConfiguration | null;
  runtime?: unknown;
}>;

function canRegisterGoogleProvider(runtime: unknown): boolean {
  return runtime === 'development' || runtime === 'test' || runtime === 'production';
}

/**
 * Produces the exact Auth.js provider list for the selected runtime. Keeping
 * this factory separate makes the provider-registration boundary testable;
 * production and unknown runtimes receive no Credentials callback endpoint.
 */
export function createSkyosAuthProviders(
  authorizeCredentials: DevelopmentCredentialsAuthorizer,
  options: AuthProviderRegistrationOptions = {},
) {
  const runtime = options.runtime ?? process.env.NODE_ENV;
  const providers = [];

  if (isDevelopmentCredentialsEnabled(runtime)) {
    providers.push(
      Credentials({
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Password', type: 'password' },
        },
        name: 'Development credentials',
        async authorize(credentials) {
          return authorizeCredentials(credentials);
        },
      }),
    );
  }

  if (canRegisterGoogleProvider(runtime) && options.googleOidcConfiguration) {
    providers.push(
      Google({
        allowDangerousEmailAccountLinking: false,
        authorization: { params: { scope: 'openid profile email' } },
        clientId: options.googleOidcConfiguration.clientId,
        clientSecret: options.googleOidcConfiguration.clientSecret,
      }),
    );
  }

  return providers;
}

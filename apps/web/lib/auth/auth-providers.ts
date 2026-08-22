import Credentials from 'next-auth/providers/credentials';
import type { User } from 'next-auth';

import { isDevelopmentCredentialsEnabled } from './development-credentials';

export type DevelopmentCredentialsAuthorizer = (
  credentials: Readonly<{ email?: unknown; password?: unknown }>,
) => Promise<User | null>;

/**
 * Produces the exact Auth.js provider list for the selected runtime. Keeping
 * this factory separate makes the provider-registration boundary testable;
 * production and unknown runtimes receive no Credentials callback endpoint.
 */
export function createSkyosAuthProviders(
  authorizeCredentials: DevelopmentCredentialsAuthorizer,
  runtime: unknown = process.env.NODE_ENV,
) {
  if (!isDevelopmentCredentialsEnabled(runtime)) return [];

  return [
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
  ];
}

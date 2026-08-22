import { AuthError } from 'next-auth';

import { normalizeCredentials } from '../../../../database/auth/credentials';

import { getSafeSignInRedirect } from './security';
import { isDevelopmentCredentialsEnabled } from './development-credentials';

export const CREDENTIALS_SIGN_IN_NOT_CONFIGURED = 'Sign-in is not configured for this environment.';

export type LoginState = {
  error: string | null;
};

type CredentialsSignIn = (
  provider: 'credentials',
  options: Readonly<{ email: string; password: string; redirect: false }>,
) => Promise<unknown>;

export type CredentialLoginResult =
  | Readonly<{ error: string; status: 'error' }>
  | Readonly<{ redirectTo: string; status: 'success' }>;

type CredentialLoginDependencies = Readonly<{
  runtime?: unknown;
  signIn: CredentialsSignIn;
}>;

/**
 * Validates a local credential submission before the server action performs a
 * framework redirect. The runtime gate comes first so production never parses
 * credentials, reaches Auth.js, or reaches the database authentication path.
 */
export async function attemptDevelopmentCredentialsLogin(
  formData: FormData,
  dependencies: CredentialLoginDependencies,
): Promise<CredentialLoginResult> {
  if (!isDevelopmentCredentialsEnabled(dependencies.runtime)) {
    return { error: CREDENTIALS_SIGN_IN_NOT_CONFIGURED, status: 'error' };
  }

  const credentials = normalizeCredentials({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!credentials) {
    return { error: 'Enter an email address and password.', status: 'error' };
  }

  try {
    await dependencies.signIn('credentials', { ...credentials, redirect: false });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'The email address or password is incorrect.', status: 'error' };
    }

    throw error;
  }

  return { redirectTo: getSafeSignInRedirect(formData.get('redirectTo')), status: 'success' };
}

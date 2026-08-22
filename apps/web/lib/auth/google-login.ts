import { AuthError } from 'next-auth';

import { getSafeSignInRedirect } from './security';
import { isGoogleOidcProviderEnabled, type GoogleOidcConfiguration } from './google-oidc';

export const GOOGLE_SIGN_IN_NOT_CONFIGURED = 'Sign-in is not configured for this environment.';

export type GoogleLoginPreparation =
  Readonly<{ error: string; status: 'error' }> | Readonly<{ redirectTo: string; status: 'ready' }>;

type GoogleSignIn = (
  provider: 'google',
  options: Readonly<{ redirectTo: string }>,
) => Promise<unknown>;

/**
 * Validates Google sign-in availability and a same-origin application return
 * destination before the server action gives control to Auth.js.
 */
export function prepareGoogleOidcSignIn(
  formData: FormData,
  input: Readonly<{ configuration: GoogleOidcConfiguration | null; runtime?: unknown }>,
): GoogleLoginPreparation {
  if (!isGoogleOidcProviderEnabled(input.runtime, input.configuration)) {
    return { error: GOOGLE_SIGN_IN_NOT_CONFIGURED, status: 'error' };
  }

  return { redirectTo: getSafeSignInRedirect(formData.get('redirectTo')), status: 'ready' };
}

/** Starts only a configured Google flow and turns expected Auth.js errors into a generic state. */
export async function attemptGoogleOidcSignIn(
  formData: FormData,
  input: Readonly<{
    configuration: GoogleOidcConfiguration | null;
    runtime?: unknown;
    signIn: GoogleSignIn;
  }>,
): Promise<Readonly<{ error: string | null }>> {
  const result = prepareGoogleOidcSignIn(formData, input);

  if (result.status === 'error') return { error: result.error };

  try {
    await input.signIn('google', { redirectTo: result.redirectTo });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'Sign-in could not be started.' };
    }

    throw error;
  }

  return { error: 'Sign-in could not be started.' };
}

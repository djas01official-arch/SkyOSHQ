'use server';

import { redirect } from 'next/navigation';

import { signIn } from '@/auth';
import { attemptDevelopmentCredentialsLogin, type LoginState } from '@/lib/auth/credential-login';
import { attemptGoogleOidcSignIn } from '@/lib/auth/google-login';
import { getGoogleOidcConfiguration } from '@/lib/auth/google-oidc';

export type { LoginState } from '@/lib/auth/credential-login';

export async function login(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  const result = await attemptDevelopmentCredentialsLogin(formData, {
    runtime: process.env.NODE_ENV,
    signIn,
  });

  if (result.status === 'error') return { error: result.error };

  redirect(result.redirectTo);
}

/** Starts the configured Google OIDC flow without forwarding an arbitrary callback URL. */
export async function startGoogleLogin(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  return attemptGoogleOidcSignIn(formData, {
    configuration: getGoogleOidcConfiguration(),
    runtime: process.env.NODE_ENV,
    signIn,
  });
}

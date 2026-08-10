'use server';

import { AuthError } from 'next-auth';

import { normalizeCredentials } from '../../../../database/auth/credentials';

import { signIn } from '@/auth';
import { getSafeSignInRedirect } from '@/lib/auth/security';

export type LoginState = {
  error: string | null;
};

export async function login(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  const email = formData.get('email');
  const password = formData.get('password');
  const redirectTo = getSafeSignInRedirect(formData.get('redirectTo'));
  const credentials = normalizeCredentials({ email, password });

  if (!credentials) {
    return { error: 'Enter an email address and password.' };
  }

  try {
    await signIn('credentials', { ...credentials, redirectTo });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'The email address or password is incorrect.' };
    }

    throw error;
  }

  return { error: 'Unable to sign in. Please try again.' };
}

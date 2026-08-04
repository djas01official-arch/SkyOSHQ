'use server';

import { AuthError } from 'next-auth';

import { signIn } from '@/auth';

export type LoginState = {
  error: string | null;
};

export async function login(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  const email = formData.get('email');
  const password = formData.get('password');

  if (typeof email !== 'string' || typeof password !== 'string') {
    return { error: 'Enter an email address and password.' };
  }

  try {
    await signIn('credentials', { email, password, redirectTo: '/dashboard' });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'The email address or password is incorrect.' };
    }

    throw error;
  }

  return { error: 'Unable to sign in. Please try again.' };
}

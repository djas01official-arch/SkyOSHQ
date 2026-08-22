'use server';

import { redirect } from 'next/navigation';

import { signIn } from '@/auth';
import { attemptDevelopmentCredentialsLogin, type LoginState } from '@/lib/auth/credential-login';

export type { LoginState } from '@/lib/auth/credential-login';

export async function login(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  const result = await attemptDevelopmentCredentialsLogin(formData, {
    runtime: process.env.NODE_ENV,
    signIn,
  });

  if (result.status === 'error') return { error: result.error };

  redirect(result.redirectTo);
}

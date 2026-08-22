'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';

import { startGoogleLogin, type LoginState } from '@/app/login/actions';

const initialState: LoginState = { error: null };

type GoogleLoginFormProps = {
  redirectTo: string;
};

export function GoogleLoginForm({ redirectTo }: GoogleLoginFormProps) {
  const [state, formAction, isPending] = useActionState(startGoogleLogin, initialState);
  const errorId = state.error ? 'google-login-error' : undefined;

  return (
    <form action={formAction} className="space-y-3" data-login-form="google">
      <input name="redirectTo" type="hidden" value={redirectTo} />
      {state.error ? (
        <p
          className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger"
          id={errorId}
          role="alert"
        >
          {state.error}
        </p>
      ) : null}
      <Button className="w-full" disabled={isPending} type="submit" variant="secondary">
        {isPending ? 'Connecting to Google…' : 'Continue with Google'}
      </Button>
    </form>
  );
}

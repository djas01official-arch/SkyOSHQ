'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { login, type LoginState } from '@/app/login/actions';

const initialState: LoginState = { error: null };

type LoginFormProps = {
  redirectTo: string;
};

export function LoginForm({ redirectTo }: LoginFormProps) {
  const [state, formAction, isPending] = useActionState(login, initialState);
  const errorId = state.error ? 'login-error' : undefined;

  return (
    <form action={formAction} className="space-y-5" data-login-form="login">
      <input name="redirectTo" type="hidden" value={redirectTo} />
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="email">
          Email address
        </label>
        <Input
          autoComplete="email"
          className="mt-2"
          id="email"
          aria-describedby={errorId}
          aria-invalid={Boolean(state.error)}
          maxLength={320}
          name="email"
          required
          type="email"
        />
      </div>
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="password">
          Password
        </label>
        <Input
          autoComplete="current-password"
          className="mt-2"
          id="password"
          aria-describedby={errorId}
          aria-invalid={Boolean(state.error)}
          maxLength={1024}
          name="password"
          required
          type="password"
        />
      </div>
      {state.error ? (
        <p
          className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger"
          id="login-error"
          role="alert"
        >
          {state.error}
        </p>
      ) : null}
      <Button className="w-full" disabled={isPending} type="submit" variant="primary">
        {isPending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

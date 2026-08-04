'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';

import { login, type LoginState } from '@/app/login/actions';

const initialState: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="email">
          Email address
        </label>
        <input
          autoComplete="email"
          className="mt-2 h-10 w-full rounded-control border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent focus:ring-2 focus:ring-accent/20"
          id="email"
          name="email"
          required
          type="email"
        />
      </div>
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="password">
          Password
        </label>
        <input
          autoComplete="current-password"
          className="mt-2 h-10 w-full rounded-control border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent focus:ring-2 focus:ring-accent/20"
          id="password"
          name="password"
          required
          type="password"
        />
      </div>
      {state.error ? (
        <p
          aria-live="polite"
          className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger"
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

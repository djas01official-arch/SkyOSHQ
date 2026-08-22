import React, { type ReactNode } from 'react';

import { Wordmark } from '../brand/wordmark';

type LoginPageContentProps = {
  credentialsEnabled: boolean;
  credentialsForm?: ReactNode;
  googleEnabled: boolean;
  googleSignInForm?: ReactNode;
};

export function LoginPageContent({
  credentialsEnabled,
  credentialsForm,
  googleEnabled,
  googleSignInForm,
}: LoginPageContentProps) {
  const supportingText = googleEnabled
    ? 'Continue only with a pre-provisioned SkyOS account.'
    : credentialsEnabled
      ? 'Use the configured development credentials to access the foundation environment.'
      : 'Sign-in is not configured for this environment.';

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background p-4">
      <div aria-hidden="true" className="shell-grid pointer-events-none absolute inset-0" />
      <section className="surface-elevated relative w-full max-w-md rounded-panel p-6 sm:p-8">
        <div className="border-b border-border pb-6">
          <Wordmark showTagline />
        </div>
        <p className="mt-7 text-xs font-semibold uppercase tracking-[0.16em] text-brand-highlight">
          Secure access
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">Sign in</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{supportingText}</p>
        {googleEnabled ? <div className="mt-7">{googleSignInForm}</div> : null}
        {credentialsEnabled ? <div className="mt-5">{credentialsForm}</div> : null}
      </section>
    </main>
  );
}

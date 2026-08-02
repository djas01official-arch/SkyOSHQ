'use client';

import { Button } from '@/components/ui/button';

type ErrorPageProps = {
  reset: () => void;
};

export default function ErrorPage({ reset }: ErrorPageProps) {
  return (
    <div className="mx-auto grid min-h-96 max-w-xl place-items-center text-center">
      <div>
        <p className="text-sm font-medium text-accent">Something went wrong</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
          We could not load this view.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Please retry the page. If the issue persists, the workspace may need attention.
        </p>
        <Button className="mt-6" onClick={reset} variant="primary">
          Try again
        </Button>
      </div>
    </div>
  );
}

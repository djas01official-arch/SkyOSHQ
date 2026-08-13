'use client';

import { Button } from '@/components/ui/button';

type AiUsageErrorProps = Readonly<{ reset: () => void }>;

export default function AiUsageError({ reset }: AiUsageErrorProps) {
  return (
    <div className="mx-auto grid min-h-96 max-w-xl place-items-center text-center">
      <div>
        <p className="text-sm font-medium text-accent">AI telemetry unavailable</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
          We could not load usage and cost.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Retry this view. No AI run or provider configuration is changed by loading this page.
        </p>
        <Button className="mt-6" onClick={reset} variant="primary">
          Try again
        </Button>
      </div>
    </div>
  );
}

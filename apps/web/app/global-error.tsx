'use client';

import { Wordmark } from '@/components/brand/wordmark';
import { Button } from '@/components/ui/button';

type GlobalErrorProps = {
  reset: () => void;
};

export default function GlobalError({ reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <main className="max-w-md text-center">
          <Wordmark className="items-center" showTagline />
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            The application shell could not start.
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Try loading the application again.
          </p>
          <Button className="mt-6" onClick={reset} variant="primary">
            Retry
          </Button>
        </main>
      </body>
    </html>
  );
}

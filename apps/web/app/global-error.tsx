'use client';

type GlobalErrorProps = {
  reset: () => void;
};

export default function GlobalError({ reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <main className="max-w-md text-center">
          <p className="text-sm font-medium text-accent">SkyOS</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            The application shell could not start.
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Try loading the application again.
          </p>
          <button
            className="mt-6 rounded-control bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground"
            onClick={reset}
            type="button"
          >
            Retry
          </button>
        </main>
      </body>
    </html>
  );
}

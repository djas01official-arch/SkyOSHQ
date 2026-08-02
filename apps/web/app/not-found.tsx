import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto grid min-h-96 max-w-xl place-items-center text-center">
      <div>
        <p className="text-sm font-medium text-accent">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
          This view does not exist.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Return to the SkyOS workspace foundation to continue.
        </p>
        <Link
          className="mt-6 inline-flex rounded-control bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground"
          href="/dashboard"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}

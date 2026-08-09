import { cn } from '@/lib/cn';

type LoadingStateProps = Readonly<{
  className?: string;
  label?: string;
  rows?: number;
}>;

export function LoadingState({
  className,
  label = 'Loading content',
  rows = 3,
}: LoadingStateProps) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={cn('animate-pulse', className)}
      role="status"
    >
      <span className="sr-only">{label}</span>
      <div className="h-3 w-24 rounded-full bg-surface-raised" />
      <div className="mt-4 h-9 w-64 max-w-full rounded-control bg-surface-raised" />
      <div className="mt-4 h-4 w-full max-w-xl rounded-full bg-surface-raised" />
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {Array.from({ length: rows }, (_, index) => (
          <div className="h-36 rounded-card border border-border bg-surface" key={index} />
        ))}
      </div>
    </div>
  );
}

import { cn } from '@/lib/cn';

type WordmarkProps = Readonly<{
  className?: string;
  showTagline?: boolean;
}>;

export function Wordmark({ className, showTagline = false }: WordmarkProps) {
  return (
    <span className={cn('inline-flex flex-col', className)}>
      <span className="text-[1.05rem] font-semibold tracking-[-0.045em] text-foreground">
        Sky<span className="text-brand-highlight">OS</span>
      </span>
      {showTagline ? (
        <span className="mt-1 text-[0.5rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
          Your system. <span className="text-brand-highlight">Your sky.</span>
        </span>
      ) : null}
    </span>
  );
}

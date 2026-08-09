import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'focus-ring h-10 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground shadow-sm outline-none transition-[background-color,border-color,box-shadow] hover:border-brand-bright/50 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

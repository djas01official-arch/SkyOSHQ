import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'focus-ring min-h-28 w-full resize-y rounded-control border border-border-strong bg-surface px-3 py-2.5 text-sm leading-6 text-foreground shadow-sm outline-none transition-[background-color,border-color,box-shadow] placeholder:text-muted-foreground/80 hover:border-brand-bright/50 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

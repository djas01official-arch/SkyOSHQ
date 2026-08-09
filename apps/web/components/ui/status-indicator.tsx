import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const dots: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  accent: 'bg-brand-cyan shadow-[0_0_10px_rgb(0_212_255_/_0.45)]',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

type StatusIndicatorProps = ComponentProps<'span'> & {
  tone?: StatusTone;
};

export function StatusIndicator({
  children,
  className,
  tone = 'neutral',
  ...props
}: StatusIndicatorProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 text-xs font-medium text-muted-foreground',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', dots[tone])} />
      {children}
    </span>
  );
}

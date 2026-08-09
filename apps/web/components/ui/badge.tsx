import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

type BadgeTone = 'neutral' | 'accent' | 'purple' | 'success' | 'warning' | 'danger';

const tones: Record<BadgeTone, string> = {
  neutral: 'border-border bg-surface-raised text-muted-foreground',
  accent: 'border-brand-bright/25 bg-accent-soft text-brand-highlight',
  purple: 'border-brand-purple/25 bg-brand-purple/10 text-brand-purple dark:text-purple-300',
  success: 'border-success/25 bg-success-soft text-success',
  warning: 'border-warning/25 bg-warning-soft text-warning',
  danger: 'border-danger/25 bg-danger-soft text-danger',
};

type BadgeProps = ComponentProps<'span'> & {
  tone?: BadgeTone;
};

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[0.6875rem] font-semibold leading-none tracking-[0.02em]',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

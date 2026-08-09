import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/cn';

type CardProps = ComponentProps<'section'> & {
  variant?: 'default' | 'elevated' | 'muted';
};

const variants = {
  default: 'border-border bg-surface shadow-card',
  elevated: 'border-border-strong bg-surface-overlay shadow-elevated',
  muted: 'border-border bg-surface-raised shadow-none',
};

export function Card({ className, variant = 'default', ...props }: CardProps) {
  return (
    <section className={cn('rounded-card border p-5', variants[variant], className)} {...props} />
  );
}

type CardHeaderProps = {
  action?: ReactNode;
  description?: string;
  title: string;
};

export function CardHeader({ action, description, title }: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-base font-semibold tracking-[-0.015em] text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

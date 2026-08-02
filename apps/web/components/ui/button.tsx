import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'default' | 'icon' | 'small';
};

const variants = {
  primary:
    'bg-accent text-accent-foreground shadow-sm hover:bg-accent-hover focus-visible:ring-accent',
  secondary:
    'border border-border bg-surface text-foreground shadow-sm hover:bg-surface-raised focus-visible:ring-accent',
  ghost:
    'text-muted-foreground hover:bg-surface-raised hover:text-foreground focus-visible:ring-accent',
};

const sizes = {
  default: 'h-10 gap-2 px-4 text-sm',
  icon: 'size-10 justify-center',
  small: 'h-8 gap-1.5 px-3 text-xs',
};

export function Button({
  className,
  size = 'default',
  variant = 'secondary',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-control font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      type="button"
      {...props}
    />
  );
}

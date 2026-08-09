import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'default' | 'icon' | 'small';

type ButtonStyleOptions = {
  className?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

const variants: Record<ButtonVariant, string> = {
  primary:
    'border border-transparent bg-accent text-accent-foreground shadow-sm hover:bg-accent-hover hover:shadow-elevated',
  secondary:
    'border border-border-strong bg-surface text-foreground shadow-sm hover:border-brand-bright/50 hover:bg-surface-raised',
  ghost:
    'border border-transparent text-muted-foreground hover:bg-surface-raised hover:text-foreground',
  danger:
    'border border-danger/30 bg-danger-soft text-danger hover:border-danger/60 hover:bg-danger/10',
};

const sizes: Record<ButtonSize, string> = {
  default: 'h-10 gap-2 px-4 text-sm',
  icon: 'size-10 justify-center',
  small: 'h-8 gap-1.5 px-3 text-xs',
};

export function buttonClassName({
  className,
  size = 'default',
  variant = 'secondary',
}: ButtonStyleOptions = {}) {
  return cn(
    'focus-ring inline-flex shrink-0 items-center justify-center rounded-control font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  );
}

type ButtonProps = ComponentProps<'button'> & ButtonStyleOptions;

export function Button({
  className,
  size = 'default',
  variant = 'secondary',
  ...props
}: ButtonProps) {
  return (
    <button className={buttonClassName({ className, size, variant })} type="button" {...props} />
  );
}

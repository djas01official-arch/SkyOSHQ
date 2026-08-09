import type { ReactNode } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';
import { cn } from '@/lib/cn';

type EmptyStateProps = Readonly<{
  action?: ReactNode;
  className?: string;
  description: string;
  icon: IconName;
  title: string;
}>;

export function EmptyState({ action, className, description, icon, title }: EmptyStateProps) {
  return (
    <div className={cn('mx-auto max-w-md px-4 py-10 text-center', className)}>
      <span className="brand-glow mx-auto grid size-12 place-items-center rounded-card border border-brand-bright/25 bg-accent-soft text-brand-highlight">
        <Icon className="size-5" name={icon} />
      </span>
      <h2 className="mt-5 text-lg font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}

import type { ReactNode } from 'react';

type PageHeaderProps = {
  action?: ReactNode;
  description: string;
  eyebrow?: string;
  title: string;
};

export function PageHeader({ action, description, eyebrow, title }: PageHeaderProps) {
  return (
    <header className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
      <div>
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-highlight">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
          {description}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

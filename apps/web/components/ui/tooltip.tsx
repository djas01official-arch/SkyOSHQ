import type { ReactElement } from 'react';
import { cloneElement, useId } from 'react';

type TooltipProps = Readonly<{
  children: ReactElement<{ 'aria-describedby'?: string }>;
  content: string;
}>;

export function Tooltip({ children, content }: TooltipProps) {
  const id = useId();
  const existingDescription = children.props['aria-describedby'];
  const trigger = cloneElement(children, {
    'aria-describedby': existingDescription ? `${existingDescription} ${id}` : id,
  });

  return (
    <span className="group/tooltip relative inline-flex">
      {trigger}
      <span
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-overlay px-2 py-1 text-xs font-medium text-foreground shadow-elevated group-focus-within/tooltip:block group-hover/tooltip:block"
        id={id}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
}

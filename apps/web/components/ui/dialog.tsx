'use client';

import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/cn';

type DialogProps = Readonly<{
  children: ReactNode;
  description?: string;
  footer?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  placement?: 'center' | 'right';
  title: string;
}>;

export function Dialog({
  children,
  description,
  footer,
  onOpenChange,
  open,
  placement = 'center',
  title,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      className={cn(
        'surface-elevated p-0 text-foreground backdrop:bg-overlay',
        placement === 'right'
          ? 'fixed bottom-0 left-auto right-0 top-[4.5rem] m-0 h-[calc(100vh-4.5rem)] max-h-none w-full max-w-sm rounded-none border-y-0 border-r-0 sm:w-96'
          : 'm-auto w-[calc(100%-2rem)] max-w-lg rounded-panel',
      )}
      onCancel={() => onOpenChange(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
      onClose={() => onOpenChange(false)}
      ref={dialogRef}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-sm leading-6 text-muted-foreground" id={descriptionId}>
              {description}
            </p>
          ) : null}
        </div>
        <Button
          aria-label="Close dialog"
          onClick={() => onOpenChange(false)}
          size="icon"
          variant="ghost"
        >
          <Icon className="size-4" name="close" />
        </Button>
      </div>
      <div className="px-5 py-5">{children}</div>
      {footer ? <div className="border-t border-border px-5 py-4">{footer}</div> : null}
    </dialog>
  );
}

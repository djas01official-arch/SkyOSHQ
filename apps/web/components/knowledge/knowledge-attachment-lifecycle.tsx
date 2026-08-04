'use client';

import { useActionState } from 'react';

import type { KnowledgeAttachmentActionState } from '@/app/knowledge/attachment-actions';
import { Button } from '@/components/ui/button';

type KnowledgeAttachmentLifecycleProps = Readonly<{
  action: (
    previousState: KnowledgeAttachmentActionState,
    formData: FormData,
  ) => Promise<KnowledgeAttachmentActionState>;
  attachmentId: string;
  label: string;
  slug: string;
  version: number;
}>;

const initialState: KnowledgeAttachmentActionState = { error: null };

export function KnowledgeAttachmentLifecycle({
  action,
  attachmentId,
  label,
  slug,
  version,
}: KnowledgeAttachmentLifecycleProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input name="attachmentId" type="hidden" value={attachmentId} />
      <input name="slug" type="hidden" value={slug} />
      <input name="version" type="hidden" value={version} />
      {state.error ? (
        <span aria-live="polite" className="max-w-52 text-xs text-red-700 dark:text-red-200">
          {state.error}
        </span>
      ) : null}
      <Button disabled={isPending} size="small" type="submit" variant="ghost">
        {isPending ? 'Working…' : label}
      </Button>
    </form>
  );
}

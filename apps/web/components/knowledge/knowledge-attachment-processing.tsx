'use client';

import { useActionState } from 'react';

import type { KnowledgeAttachmentActionState } from '@/app/knowledge/attachment-actions';
import { Button } from '@/components/ui/button';

type KnowledgeAttachmentProcessingProps = Readonly<{
  action: (
    previousState: KnowledgeAttachmentActionState,
    formData: FormData,
  ) => Promise<KnowledgeAttachmentActionState>;
  attachmentId: string;
  label: string;
  slug: string;
}>;

const initialState: KnowledgeAttachmentActionState = { error: null };

export function KnowledgeAttachmentProcessing({
  action,
  attachmentId,
  label,
  slug,
}: KnowledgeAttachmentProcessingProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input name="attachmentId" type="hidden" value={attachmentId} />
      <input name="slug" type="hidden" value={slug} />
      {state.error ? (
        <span aria-live="polite" className="max-w-52 text-xs text-red-700 dark:text-red-200">
          {state.error}
        </span>
      ) : null}
      <Button disabled={isPending} size="small" type="submit" variant="ghost">
        {isPending ? 'Processing…' : label}
      </Button>
    </form>
  );
}

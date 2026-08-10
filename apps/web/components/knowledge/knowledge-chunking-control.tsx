'use client';

import { useActionState } from 'react';

import type { KnowledgeChunkingActionState } from '@/app/knowledge/chunking-actions';
import { Button } from '@/components/ui/button';

type KnowledgeChunkingControlProps = Readonly<{
  action: (
    state: KnowledgeChunkingActionState,
    formData: FormData,
  ) => Promise<KnowledgeChunkingActionState>;
  attachmentId?: string;
  label: string;
  slug: string;
}>;

const initialState: KnowledgeChunkingActionState = { error: null };

export function KnowledgeChunkingControl({
  action,
  attachmentId,
  label,
  slug,
}: KnowledgeChunkingControlProps) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form
      action={formAction}
      className="flex items-center gap-2"
      data-knowledge-chunking-form={attachmentId ? 'attachment' : 'document'}
    >
      <input name="slug" type="hidden" value={slug} />
      {attachmentId ? <input name="attachmentId" type="hidden" value={attachmentId} /> : null}
      {state.error ? (
        <span aria-live="polite" className="max-w-52 text-xs text-red-700 dark:text-red-200">
          {state.error}
        </span>
      ) : null}
      <Button disabled={pending} size="small" type="submit" variant="ghost">
        {pending ? 'Processing…' : label}
      </Button>
    </form>
  );
}

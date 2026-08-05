'use client';

import { useActionState } from 'react';

import type { KnowledgeEmbeddingActionState } from '@/app/knowledge/embedding-actions';
import { Button } from '@/components/ui/button';

type KnowledgeEmbeddingControlProps = Readonly<{
  action: (
    state: KnowledgeEmbeddingActionState,
    formData: FormData,
  ) => Promise<KnowledgeEmbeddingActionState>;
  chunkSetId: string;
  label: string;
  slug: string;
}>;

const initialState: KnowledgeEmbeddingActionState = { error: null };

export function KnowledgeEmbeddingControl({
  action,
  chunkSetId,
  label,
  slug,
}: KnowledgeEmbeddingControlProps) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input name="chunkSetId" type="hidden" value={chunkSetId} />
      <input name="slug" type="hidden" value={slug} />
      {state.error ? (
        <span aria-live="polite" className="max-w-52 text-xs text-red-700 dark:text-red-200">
          {state.error}
        </span>
      ) : null}
      <Button disabled={pending} size="small" type="submit" variant="ghost">
        {pending ? 'Embedding…' : label}
      </Button>
    </form>
  );
}

'use client';

import { useActionState } from 'react';

import type { KnowledgeDocumentActionState } from '@/app/knowledge/actions';
import { Button } from '@/components/ui/button';

type KnowledgeDocumentLifecycleProps = Readonly<{
  action: (
    previousState: KnowledgeDocumentActionState,
    formData: FormData,
  ) => Promise<KnowledgeDocumentActionState>;
  label: string;
  slug: string;
  version: number;
}>;

const initialState: KnowledgeDocumentActionState = { error: null };

export function KnowledgeDocumentLifecycle({
  action,
  label,
  slug,
  version,
}: KnowledgeDocumentLifecycleProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input name="slug" type="hidden" value={slug} />
      <input name="version" type="hidden" value={version} />
      {state.error ? (
        <span aria-live="polite" className="max-w-52 text-xs text-red-700 dark:text-red-200">
          {state.error}
        </span>
      ) : null}
      <Button disabled={isPending} size="small" type="submit" variant="secondary">
        {isPending ? 'Working…' : label}
      </Button>
    </form>
  );
}

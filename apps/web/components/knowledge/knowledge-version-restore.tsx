'use client';

import { useActionState } from 'react';

import type { KnowledgeDocumentActionState } from '@/app/knowledge/actions';
import { Button } from '@/components/ui/button';

type KnowledgeVersionRestoreProps = Readonly<{
  action: (
    previousState: KnowledgeDocumentActionState,
    formData: FormData,
  ) => Promise<KnowledgeDocumentActionState>;
  currentVersion: number;
  slug: string;
  sourceVersion: number;
}>;

const initialState: KnowledgeDocumentActionState = { error: null };

export function KnowledgeVersionRestore({
  action,
  currentVersion,
  slug,
  sourceVersion,
}: KnowledgeVersionRestoreProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input name="slug" type="hidden" value={slug} />
      <input name="sourceVersion" type="hidden" value={sourceVersion} />
      <input name="version" type="hidden" value={currentVersion} />
      <Button disabled={isPending} size="small" type="submit" variant="secondary">
        {isPending ? 'Restoring…' : `Restore version ${sourceVersion}`}
      </Button>
      {state.error ? (
        <span aria-live="polite" className="max-w-sm text-xs text-red-700 dark:text-red-200">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

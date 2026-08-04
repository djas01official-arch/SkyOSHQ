'use client';

import { useActionState } from 'react';

import type { KnowledgeDocumentActionState } from '@/app/knowledge/actions';
import { Button } from '@/components/ui/button';

type KnowledgeDocumentFormProps = Readonly<{
  action: (
    previousState: KnowledgeDocumentActionState,
    formData: FormData,
  ) => Promise<KnowledgeDocumentActionState>;
  content?: string;
  slug?: string;
  submitLabel: string;
  title?: string;
  version?: number;
}>;

const initialState: KnowledgeDocumentActionState = { error: null };

export function KnowledgeDocumentForm({
  action,
  content = '',
  slug,
  submitLabel,
  title = '',
  version,
}: KnowledgeDocumentFormProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-5">
      {slug ? <input name="slug" type="hidden" value={slug} /> : null}
      {version ? <input name="version" type="hidden" value={version} /> : null}
      <label className="block">
        <span className="text-sm font-medium text-foreground">Title</span>
        <input
          className="mt-2 h-11 w-full rounded-control border border-border bg-surface px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-2 focus:ring-accent-soft"
          defaultValue={title}
          maxLength={200}
          name="title"
          placeholder="Document title"
          required
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-foreground">Markdown</span>
        <textarea
          className="mt-2 min-h-80 w-full resize-y rounded-control border border-border bg-surface px-3 py-3 font-mono text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-2 focus:ring-accent-soft"
          defaultValue={content}
          maxLength={100000}
          name="content"
          placeholder="# Start writing\n\nUse Markdown for structured workspace knowledge."
          required
        />
      </label>
      {state.error ? (
        <p
          aria-live="polite"
          className="rounded-control bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200"
        >
          {state.error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={isPending} type="submit" variant="primary">
          {isPending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

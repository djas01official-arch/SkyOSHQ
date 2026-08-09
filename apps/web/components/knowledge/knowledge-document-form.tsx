'use client';

import { useActionState } from 'react';

import type { KnowledgeDocumentActionState } from '@/app/knowledge/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

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
        <Input
          className="mt-2 h-11"
          defaultValue={title}
          maxLength={200}
          name="title"
          placeholder="Document title"
          required
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-foreground">Markdown</span>
        <Textarea
          className="mt-2 min-h-80 px-3 py-3 font-mono"
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
          className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger"
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

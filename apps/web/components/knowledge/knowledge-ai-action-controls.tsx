'use client';

import { useActionState } from 'react';

import { runKnowledgeAiAction, type KnowledgeAiActionState } from '@/app/knowledge/ai-actions';
import { Button } from '@/components/ui/button';

const actions = [
  { label: 'Summarize', value: 'SUMMARIZE' },
  { label: 'Extract action items', value: 'EXTRACT_ACTION_ITEMS' },
  { label: 'Identify risks', value: 'IDENTIFY_RISKS' },
  { label: 'Extract key decisions', value: 'EXTRACT_KEY_DECISIONS' },
] as const;

const initialState: KnowledgeAiActionState = { error: null };

function ActionControl({
  action,
  slug,
  version,
  view,
}: Readonly<{
  action: (typeof actions)[number];
  slug: string;
  version: number;
  view: 'document' | 'version';
}>) {
  const [state, formAction, pending] = useActionState(runKnowledgeAiAction, initialState);
  return (
    <form action={formAction} data-knowledge-ai-action={action.value}>
      <input name="actionType" type="hidden" value={action.value} />
      <input name="slug" type="hidden" value={slug} />
      <input name="version" type="hidden" value={version} />
      <input name="view" type="hidden" value={view} />
      <Button disabled={pending} size="small" type="submit" variant="secondary">
        {pending ? 'Working…' : action.label}
      </Button>
      {state.error ? (
        <p aria-live="polite" className="mt-2 max-w-64 text-xs leading-5 text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function KnowledgeAiActionControls({
  slug,
  version,
  view,
}: Readonly<{ slug: string; version: number; view: 'document' | 'version' }>) {
  return (
    <div className="mt-4 flex flex-wrap items-start gap-2">
      {actions.map((action) => (
        <ActionControl
          action={action}
          key={action.value}
          slug={slug}
          version={version}
          view={view}
        />
      ))}
    </div>
  );
}

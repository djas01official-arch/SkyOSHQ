'use client';

import { useActionState } from 'react';

import { submitMessageAction, type AiMessageActionState } from '@/app/ai/actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const initialState: AiMessageActionState = { error: null };

export function AiMessageComposer({ conversationId }: Readonly<{ conversationId: string }>) {
  const [state, formAction, pending] = useActionState(submitMessageAction, initialState);

  return (
    <form action={formAction} className="mt-6" data-ai-message-form="message">
      <input name="conversationId" type="hidden" value={conversationId} />
      <label className="sr-only" htmlFor="ai-message">
        Message
      </label>
      <Textarea
        aria-describedby={state.error ? 'ai-message-error' : undefined}
        id="ai-message"
        maxLength={4000}
        name="message"
        placeholder="Ask about workspace Knowledge"
        required
      />
      {state.error ? (
        <p
          aria-live="polite"
          className="mt-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger"
          id="ai-message-error"
          role="alert"
        >
          {state.error}
        </p>
      ) : null}
      <Button className="mt-2" disabled={pending} type="submit" variant="primary">
        {pending ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}

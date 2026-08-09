'use client';

import { useActionState } from 'react';

import type { KnowledgeAttachmentActionState } from '@/app/knowledge/attachment-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type KnowledgeAttachmentUploadProps = Readonly<{
  action: (
    previousState: KnowledgeAttachmentActionState,
    formData: FormData,
  ) => Promise<KnowledgeAttachmentActionState>;
  maxFileSizeBytes: number;
  slug: string;
}>;

const initialState: KnowledgeAttachmentActionState = { error: null };

export function KnowledgeAttachmentUpload({
  action,
  maxFileSizeBytes,
  slug,
}: KnowledgeAttachmentUploadProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="mt-5 space-y-3">
      <input name="slug" type="hidden" value={slug} />
      <label className="block">
        <span className="text-sm font-medium text-foreground">Upload attachment</span>
        <Input
          accept=".pdf,.docx,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg"
          className="mt-2 h-auto py-2 file:mr-3 file:rounded-control file:border-0 file:bg-surface-raised file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-foreground"
          name="file"
          required
          type="file"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        PDF, DOCX, PNG, or JPEG. Maximum {Math.ceil(maxFileSizeBytes / 1024 / 1024)} MB.
      </p>
      {state.error ? (
        <p aria-live="polite" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <Button disabled={isPending} size="small" type="submit" variant="secondary">
        {isPending ? 'Uploading…' : 'Upload'}
      </Button>
    </form>
  );
}

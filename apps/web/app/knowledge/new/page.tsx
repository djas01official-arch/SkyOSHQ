import Link from 'next/link';

import { createKnowledgeDocumentAction } from '@/app/knowledge/actions';
import { KnowledgeDocumentForm } from '@/components/knowledge/knowledge-document-form';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireWorkspaceCapability } from '@/lib/organization-context';

export default async function NewKnowledgeDocumentPage() {
  await requireWorkspaceCapability('knowledge.write');

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        description="Create a Markdown document for the currently selected workspace."
        eyebrow="Knowledge"
        title="New document"
      />
      <Card>
        <KnowledgeDocumentForm
          action={createKnowledgeDocumentAction}
          submitLabel="Create document"
        />
      </Card>
      <Link
        className="mt-5 inline-block text-sm font-medium text-accent hover:underline"
        href="/knowledge"
      >
        Back to knowledge
      </Link>
    </div>
  );
}

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import {
  KnowledgeNotFoundError,
  getKnowledgeDocument,
} from '../../../../../../database/knowledge/knowledge-documents';
import { KnowledgeDocumentStatus } from '../../../../../../database/generated/client/client';

import { updateKnowledgeDocumentAction } from '@/app/knowledge/actions';
import { KnowledgeDocumentForm } from '@/components/knowledge/knowledge-document-form';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

type EditKnowledgeDocumentPageProps = Readonly<{
  params: Promise<{ slug: string }>;
}>;

export default async function EditKnowledgeDocumentPage({
  params,
}: EditKnowledgeDocumentPageProps) {
  const [{ slug }, user, context] = await Promise.all([
    params,
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.write'),
  ]);
  const workspace = context.activeWorkspace;

  if (!workspace) {
    notFound();
  }

  let document;
  try {
    document = await getKnowledgeDocument(prisma, user.id, workspace.id, slug, true);
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError) {
      notFound();
    }
    throw error;
  }

  if (document.status === KnowledgeDocumentStatus.ARCHIVED) {
    redirect(`/knowledge/${document.slug}`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        description="Changes are versioned to prevent stale edits from replacing newer work."
        eyebrow="Knowledge"
        title="Edit document"
      />
      <Card>
        <KnowledgeDocumentForm
          action={updateKnowledgeDocumentAction}
          content={document.content}
          kind="edit"
          slug={document.slug}
          submitLabel="Save changes"
          title={document.title}
          version={document.version}
        />
      </Card>
      <Link
        className="mt-5 inline-block text-sm font-medium text-accent hover:underline"
        href={`/knowledge/${document.slug}`}
      >
        Cancel
      </Link>
    </div>
  );
}

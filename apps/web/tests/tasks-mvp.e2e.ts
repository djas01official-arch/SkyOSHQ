import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

import { AuditAction } from '../../../database/audit/audit-event';
import { createWorkspaceForOrganization } from '../../../database/context/workspace-creation';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  type PrismaClient,
  TaskPriority,
  TaskStatus,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../../../database/generated/client/client';
import { listTasks } from '../../../database/tasks/tasks';
import {
  assertStreamedRedirectTo,
  findServerActionForm,
  submitServerActionForm,
  type ServerActionCookieJar,
} from './server-action-form';

type TestIdentity = Readonly<{
  email: string;
  id: string;
  password: string;
}>;

export type TasksE2eHarness = Readonly<{
  assertRedirectsTo(response: Response, pathname: string): URL;
  baseUrl: string;
  createIdentity(label: string): Promise<TestIdentity>;
  createJar(): ServerActionCookieJar;
  getRedirectUrl(response: Response): URL;
  login(jar: ServerActionCookieJar, identity: TestIdentity): Promise<Response>;
  prisma: PrismaClient;
}>;

async function createWorkspaceFixture(
  prisma: PrismaClient,
  ownerUserId: string,
): Promise<{ forgedWorkspaceId: string; organizationId: string; workspaceId: string }> {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: ownerUserId,
      name: `Tasks E2E ${suffix}`,
      slug: `tasks-e2e-${suffix}`,
      status: OrganizationStatus.ACTIVE,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerUserId,
    },
  });
  const workspace = await createWorkspaceForOrganization(
    prisma,
    ownerUserId,
    organization.id,
    `Tasks Workspace ${suffix}`,
    `tasks-workspace-${suffix}`,
  );
  const forgedWorkspace = await createWorkspaceForOrganization(
    prisma,
    ownerUserId,
    organization.id,
    `Unselected Tasks Workspace ${suffix}`,
    `unselected-tasks-workspace-${suffix}`,
  );

  return {
    forgedWorkspaceId: forgedWorkspace.id,
    organizationId: organization.id,
    workspaceId: workspace.id,
  };
}

async function addViewer(
  prisma: PrismaClient,
  identity: TestIdentity,
  organizationId: string,
  workspaceId: string,
): Promise<void> {
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId: identity.id,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.VIEWER,
      status: MembershipStatus.ACTIVE,
      userId: identity.id,
      workspaceId,
    },
  });
}

async function loadHtml(jar: ServerActionCookieJar, path: string): Promise<string> {
  const { response } = await jar.request(path);
  assert.equal(response.status, 200, `${path} must render successfully.`);
  return response.text();
}

export async function runTasksMvpE2eScenario(
  context: TestContext,
  harness: TasksE2eHarness,
): Promise<void> {
  await context.test(
    'Tasks owner lifecycle is workspace-scoped and viewers remain read-only',
    async () => {
      const owner = await harness.createIdentity('tasks-owner');
      const { forgedWorkspaceId, organizationId, workspaceId } = await createWorkspaceFixture(
        harness.prisma,
        owner.id,
      );
      const ownerJar = harness.createJar();
      harness.assertRedirectsTo(await harness.login(ownerJar, owner), '/tasks');

      const initialList = await loadHtml(ownerJar, '/tasks');
      assert.ok(initialList.includes('No active Tasks'));
      assert.ok(initialList.includes('New Task'));

      const suffix = randomUUID().slice(0, 8);
      const originalTitle = `HTTP Task ${suffix}`;
      const newPage = await loadHtml(ownerJar, '/tasks/new');
      const createResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        '/tasks/new',
        newPage,
        { markerName: 'data-task-form', markerValue: 'create' },
        {
          assigneeUserId: owner.id,
          description: 'Created through the real Tasks form.',
          dueAt: '2026-09-20',
          priority: TaskPriority.MEDIUM,
          status: TaskStatus.TODO,
          title: originalTitle,
          workspaceId: forgedWorkspaceId,
        },
      );
      const taskUrl = harness.getRedirectUrl(createResponse);
      assert.match(taskUrl.pathname, /^\/tasks\/[0-9a-f-]+$/u);
      const taskId = taskUrl.pathname.split('/').at(-1);
      assert.ok(taskId);

      const task = await harness.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
      assert.equal(task.workspaceId, workspaceId);
      assert.equal(task.assigneeUserId, owner.id);
      assert.equal(task.dueAt?.toISOString().slice(0, 10), '2026-09-20');
      assert.equal(
        await harness.prisma.task.count({ where: { workspaceId: forgedWorkspaceId } }),
        0,
      );
      assert.equal(
        await harness.prisma.auditEvent.count({
          where: { action: AuditAction.TASK_CREATED, targetId: task.id },
        }),
        1,
      );

      const createdList = await loadHtml(ownerJar, '/tasks');
      assert.ok(createdList.includes(originalTitle));
      const detailPath = `/tasks/${task.id}`;
      const createdDetail = await loadHtml(ownerJar, detailPath);
      assert.ok(createdDetail.includes(originalTitle));
      assert.ok(createdDetail.includes('Created through the real Tasks form.'));

      const editPath = `${detailPath}/edit`;
      const editPage = await loadHtml(ownerJar, editPath);
      const editFields = findServerActionForm(editPage, {
        markerName: 'data-task-form',
        markerValue: 'edit',
        requiredFields: { taskId: task.id },
      });
      assert.ok(
        editFields.some(
          ([name, value]) => name === 'expectedUpdatedAt' && value === task.updatedAt.toISOString(),
        ),
        'The rendered edit form must carry the canonical Task concurrency token.',
      );
      const updatedTitle = `Updated HTTP Task ${suffix}`;
      const updateResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        editPath,
        editPage,
        {
          markerName: 'data-task-form',
          markerValue: 'edit',
          requiredFields: { taskId: task.id },
        },
        {
          assigneeUserId: owner.id,
          description: 'Updated through the real Tasks form.',
          dueAt: '',
          priority: TaskPriority.HIGH,
          status: TaskStatus.IN_PROGRESS,
          taskId: task.id,
          title: updatedTitle,
          workspaceId: forgedWorkspaceId,
        },
      );
      harness.assertRedirectsTo(updateResponse, detailPath);
      const updated = await harness.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      assert.equal(updated.title, updatedTitle);
      assert.equal(updated.status, TaskStatus.IN_PROGRESS);
      assert.equal(updated.priority, TaskPriority.HIGH);
      assert.equal(updated.dueAt, null);
      assert.equal(
        await harness.prisma.auditEvent.count({
          where: { action: AuditAction.TASK_UPDATED, targetId: task.id },
        }),
        1,
      );

      const staleResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        editPath,
        editPage,
        {
          markerName: 'data-task-form',
          markerValue: 'edit',
          requiredFields: { taskId: task.id },
        },
        {
          assigneeUserId: owner.id,
          description: 'This stale edit must not persist.',
          dueAt: '2026-12-31',
          priority: TaskPriority.LOW,
          status: TaskStatus.DONE,
          taskId: task.id,
          title: `Stale HTTP Task ${suffix}`,
        },
      );
      assert.equal(staleResponse.status, 200);
      const staleBody = await staleResponse.text();
      assert.ok(
        staleBody.includes(
          'This task changed since you opened it. Reload the latest version and try again.',
        ),
        'The stale server-action response must expose the accessible conflict message.',
      );
      assert.ok(staleBody.includes(`Stale HTTP Task ${suffix}`));
      assert.ok(staleBody.includes('This stale edit must not persist.'));
      const afterStale = await harness.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      assert.equal(afterStale.title, updatedTitle);
      assert.equal(afterStale.description, 'Updated through the real Tasks form.');
      assert.equal(afterStale.status, TaskStatus.IN_PROGRESS);
      assert.equal(afterStale.priority, TaskPriority.HIGH);
      assert.equal(afterStale.updatedAt.toISOString(), updated.updatedAt.toISOString());
      assert.equal(
        await harness.prisma.auditEvent.count({
          where: { action: AuditAction.TASK_UPDATED, targetId: task.id },
        }),
        1,
      );
      const currentDetail = await loadHtml(ownerJar, detailPath);
      assert.ok(currentDetail.includes(updatedTitle));
      assert.equal(currentDetail.includes(`Stale HTTP Task ${suffix}`), false);

      const paginationTitles: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const title = `Pagination Task ${suffix} ${index.toString().padStart(2, '0')}`;
        paginationTitles.push(title);
        const paginationCreateResponse = await submitServerActionForm(
          ownerJar,
          harness.baseUrl,
          '/tasks/new',
          newPage,
          { markerName: 'data-task-form', markerValue: 'create' },
          {
            assigneeUserId: '',
            description: `Cursor boundary fixture ${index}`,
            dueAt: '2026-09-15',
            priority: TaskPriority.MEDIUM,
            status: TaskStatus.TODO,
            title,
          },
        );
        assert.match(
          harness.getRedirectUrl(paginationCreateResponse).pathname,
          /^\/tasks\/[0-9a-f-]+$/u,
        );
      }

      const firstTaskPage = await listTasks(harness.prisma, owner.id, workspaceId);
      assert.equal(firstTaskPage.items.length, 25);
      assert.equal(firstTaskPage.hasNextPage, true);
      assert.ok(firstTaskPage.nextCursor);
      const firstPageHtml = await loadHtml(ownerJar, '/tasks');
      assert.ok(firstPageHtml.includes('data-task-pagination="next"'));
      assert.ok(firstPageHtml.includes(firstTaskPage.nextCursor));
      for (const title of paginationTitles) assert.ok(firstPageHtml.includes(title));
      assert.equal(firstPageHtml.includes(updatedTitle), false);

      const secondTaskPage = await listTasks(harness.prisma, owner.id, workspaceId, {
        cursor: firstTaskPage.nextCursor,
      });
      assert.deepEqual(
        secondTaskPage.items.map(({ id }) => id),
        [task.id],
      );
      assert.equal(secondTaskPage.hasNextPage, false);
      assert.equal(secondTaskPage.nextCursor, null);
      const secondPagePath = `/tasks?cursor=${encodeURIComponent(firstTaskPage.nextCursor)}`;
      const secondPageHtml = await loadHtml(ownerJar, secondPagePath);
      assert.ok(secondPageHtml.includes(updatedTitle));
      assert.equal(secondPageHtml.includes('data-task-pagination="next"'), false);
      for (const title of paginationTitles) assert.equal(secondPageHtml.includes(title), false);

      const malformedCursorHtml = await loadHtml(ownerJar, '/tasks?cursor=malformed!');
      assert.ok(malformedCursorHtml.includes('Tasks page unavailable'));
      assert.ok(malformedCursorHtml.includes('data-task-pagination="reset"'));

      const viewer = await harness.createIdentity('tasks-viewer');
      await addViewer(harness.prisma, viewer, organizationId, workspaceId);
      const viewerJar = harness.createJar();
      harness.assertRedirectsTo(await harness.login(viewerJar, viewer), '/tasks');
      const viewerList = await loadHtml(viewerJar, '/tasks');
      assert.ok(viewerList.includes('data-task-pagination="next"'));
      assert.equal(viewerList.includes(updatedTitle), false);
      const viewerSecondPage = await loadHtml(viewerJar, secondPagePath);
      assert.ok(viewerSecondPage.includes(updatedTitle));
      assert.equal(viewerSecondPage.includes('data-task-pagination="next"'), false);
      assert.equal(viewerList.includes('New Task'), false);
      const viewerDetail = await loadHtml(viewerJar, detailPath);
      assert.equal(viewerDetail.includes(`href="${editPath}"`), false);
      assert.equal(viewerDetail.includes('data-task-operation="archive"'), false);
      await assertStreamedRedirectTo(
        (await viewerJar.request('/tasks/new')).response,
        '/tasks/new',
        '/dashboard',
        'data-task-form="create"',
      );

      const beforeDeniedUpdate = await harness.prisma.task.findUniqueOrThrow({
        where: { id: task.id },
      });
      const deniedUpdate = await submitServerActionForm(
        viewerJar,
        harness.baseUrl,
        editPath,
        editPage,
        {
          markerName: 'data-task-form',
          markerValue: 'edit',
          requiredFields: { taskId: task.id },
        },
        {
          assigneeUserId: viewer.id,
          description: 'Viewer must not persist this.',
          dueAt: '2026-12-31',
          priority: TaskPriority.LOW,
          status: TaskStatus.DONE,
          taskId: task.id,
          title: 'Viewer denied update',
          workspaceId: forgedWorkspaceId,
        },
      );
      harness.assertRedirectsTo(deniedUpdate, '/dashboard');
      assert.deepEqual(
        await harness.prisma.task.findUniqueOrThrow({ where: { id: task.id } }),
        beforeDeniedUpdate,
      );
      assert.equal(
        await harness.prisma.auditEvent.count({
          where: { action: AuditAction.TASK_UPDATED, actorUserId: viewer.id },
        }),
        0,
      );

      const crossWorkspaceViewer = await harness.createIdentity('tasks-cross-workspace-viewer');
      const crossWorkspaceFixture = await harness.prisma.workspace.findUniqueOrThrow({
        where: { id: forgedWorkspaceId },
      });
      assert.equal(crossWorkspaceFixture.status, WorkspaceStatus.ACTIVE);
      assert.equal(crossWorkspaceFixture.archivedAt, null);
      assert.equal(
        await harness.prisma.workspaceMembership.count({
          where: {
            role: WorkspaceRole.OWNER,
            status: MembershipStatus.ACTIVE,
            user: {
              deletedAt: null,
              organizationMemberships: {
                some: { organizationId, status: MembershipStatus.ACTIVE },
              },
              status: UserStatus.ACTIVE,
            },
            workspaceId: forgedWorkspaceId,
          },
        }),
        1,
        'The active cross-workspace fixture must have an effective owner before adding a viewer.',
      );
      await addViewer(harness.prisma, crossWorkspaceViewer, organizationId, forgedWorkspaceId);
      const crossWorkspaceViewerJar = harness.createJar();
      harness.assertRedirectsTo(
        await harness.login(crossWorkspaceViewerJar, crossWorkspaceViewer),
        '/tasks',
      );
      const crossWorkspaceList = await loadHtml(crossWorkspaceViewerJar, '/tasks');
      assert.ok(crossWorkspaceList.includes('No active Tasks'));
      const crossWorkspaceCursorPage = await loadHtml(crossWorkspaceViewerJar, secondPagePath);
      assert.ok(crossWorkspaceCursorPage.includes('Tasks page unavailable'));
      assert.ok(crossWorkspaceCursorPage.includes('data-task-pagination="reset"'));
      assert.equal(crossWorkspaceCursorPage.includes(updatedTitle), false);
      for (const title of paginationTitles) {
        assert.equal(crossWorkspaceCursorPage.includes(title), false);
      }

      const organizationAdmin = await harness.createIdentity('tasks-organization-admin');
      await harness.prisma.organizationMembership.create({
        data: {
          activatedAt: new Date(),
          organizationId,
          role: OrganizationRole.ADMIN,
          status: MembershipStatus.ACTIVE,
          userId: organizationAdmin.id,
        },
      });
      const organizationAdminJar = harness.createJar();
      harness.assertRedirectsTo(
        await harness.login(organizationAdminJar, organizationAdmin),
        '/tasks',
      );
      const taskCountBeforeDeniedPagination = await harness.prisma.task.count({
        where: { workspaceId },
      });
      await assertStreamedRedirectTo(
        (await organizationAdminJar.request(secondPagePath)).response,
        secondPagePath,
        '/dashboard',
      );
      assert.equal(
        await harness.prisma.task.count({ where: { workspaceId } }),
        taskCountBeforeDeniedPagination,
      );
      await assertStreamedRedirectTo(
        (await organizationAdminJar.request(detailPath)).response,
        detailPath,
        '/dashboard',
      );

      const updatedDetail = await loadHtml(ownerJar, detailPath);
      assert.ok(
        findServerActionForm(updatedDetail, {
          markerName: 'data-task-operation',
          markerValue: 'archive',
          requiredFields: { taskId: task.id },
        }).some(
          ([name, value]) =>
            name === 'expectedUpdatedAt' && value === updated.updatedAt.toISOString(),
        ),
        'The rendered archive form must carry the current Task concurrency token.',
      );
      const archiveResponse = await submitServerActionForm(
        ownerJar,
        harness.baseUrl,
        detailPath,
        updatedDetail,
        {
          markerName: 'data-task-operation',
          markerValue: 'archive',
          requiredFields: { taskId: task.id },
        },
      );
      harness.assertRedirectsTo(archiveResponse, '/tasks');
      const archived = await harness.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      assert.ok(archived.archivedAt);
      assert.equal(
        await harness.prisma.auditEvent.count({
          where: { action: AuditAction.TASK_ARCHIVED, targetId: task.id },
        }),
        1,
      );
      const refreshedAfterArchive = await listTasks(harness.prisma, owner.id, workspaceId);
      assert.equal(
        refreshedAfterArchive.items.some(({ id }) => id === task.id),
        false,
      );
      assert.equal(refreshedAfterArchive.hasNextPage, false);
      assert.equal(refreshedAfterArchive.nextCursor, null);
      const postArchiveList = await loadHtml(ownerJar, '/tasks');
      assert.equal(postArchiveList.includes(updatedTitle), false);
      assert.equal(postArchiveList.includes('data-task-pagination="next"'), false);
    },
  );
}

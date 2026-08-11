import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { AuditAction } from '../audit/audit-event';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  TaskPriority,
  TaskStatus,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import {
  TaskAuthorizationError,
  TaskConflictError,
  TaskNotFoundError,
  TaskValidationError,
  TASK_DEFAULT_PAGE_SIZE,
  TASK_MAX_PAGE_SIZE,
  archiveTask,
  createTask,
  getTask,
  isTaskAssigneeEffective,
  listTaskAssignees,
  listTasks,
  serializeTaskConcurrencyToken,
  updateTask,
} from '../tasks/tasks';

function getTestDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_TEST_URL;

  if (!databaseUrl || new URL(databaseUrl).pathname !== '/skyos_test') {
    throw new Error('DATABASE_TEST_URL must target the dedicated skyos_test database.');
  }
  if (databaseUrl === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must not match DATABASE_URL.');
  }

  return databaseUrl;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: getTestDatabaseUrl() }),
});

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { identitySubject: `task-test:${randomUUID()}`, status: UserStatus.ACTIVE },
  });
  return user.id;
}

async function createOrganization(ownerId: string): Promise<string> {
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: ownerId,
      name: `Task organization ${randomUUID()}`,
      slug: `task-organization-${randomUUID()}`,
      status: OrganizationStatus.ACTIVE,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerId,
    },
  });
  return organization.id;
}

async function createWorkspace(organizationId: string, ownerId: string): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: ownerId,
      name: `Task workspace ${randomUUID()}`,
      organizationId,
      slug: `task-workspace-${randomUUID()}`,
      status: WorkspaceStatus.ACTIVE,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerId,
      workspaceId: workspace.id,
    },
  });
  return workspace.id;
}

async function addWorkspaceUser(
  organizationId: string,
  workspaceId: string,
  userId: string,
  workspaceRole: WorkspaceRole,
  organizationRole = OrganizationRole.MEMBER,
): Promise<void> {
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: organizationRole,
      status: MembershipStatus.ACTIVE,
      userId,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: workspaceRole,
      status: MembershipStatus.ACTIVE,
      userId,
      workspaceId,
    },
  });
}

function taskInput(title: string) {
  return {
    assigneeUserId: null,
    description: `${title} description`,
    dueAt: '2026-09-15',
    priority: TaskPriority.MEDIUM,
    status: TaskStatus.TODO,
    title,
  };
}

function taskToken(task: { updatedAt: Date }): string {
  return serializeTaskConcurrencyToken(task.updatedAt);
}

async function createTaskListFixture(
  workspaceId: string,
  createdByUserId: string,
  input: Readonly<{
    archived?: boolean;
    dueAt: string | null;
    id?: string;
    status: TaskStatus;
    title: string;
    updatedAt: Date;
  }>,
) {
  return prisma.task.create({
    data: {
      archivedAt: input.archived ? input.updatedAt : null,
      createdByUserId,
      description: null,
      dueAt: input.dueAt ? new Date(`${input.dueAt}T00:00:00.000Z`) : null,
      id: input.id,
      priority: TaskPriority.MEDIUM,
      status: input.status,
      title: input.title,
      updatedAt: input.updatedAt,
      workspaceId,
    },
  });
}

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_events", "tasks", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

beforeEach(resetTestDatabase);

after(async () => {
  try {
    await resetTestDatabase();
  } finally {
    await prisma.$disconnect();
  }
});

test('workspace owner, admin, and member can create, read, update, and archive Tasks', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const actors: Array<[string, WorkspaceRole]> = [[ownerId, WorkspaceRole.OWNER]];

  for (const role of [WorkspaceRole.ADMIN, WorkspaceRole.MEMBER]) {
    const actorId = await createUser();
    await addWorkspaceUser(organizationId, workspaceId, actorId, role);
    actors.push([actorId, role]);
  }

  for (const [actorId, role] of actors) {
    const task = await createTask(prisma, actorId, workspaceId, taskInput(`${role} task`));
    assert.equal(task.workspaceId, workspaceId);
    assert.equal(task.createdByUserId, actorId);
    assert.equal((await getTask(prisma, actorId, workspaceId, task.id)).id, task.id);
    assert.ok(
      (await listTasks(prisma, actorId, workspaceId)).items.some(({ id }) => id === task.id),
    );

    const updated = await updateTask(prisma, actorId, workspaceId, task.id, taskToken(task), {
      ...taskInput(`${role} task updated`),
      dueAt: null,
      priority: TaskPriority.HIGH,
      status: TaskStatus.DONE,
    });
    assert.equal(updated.status, TaskStatus.DONE);
    assert.equal(updated.priority, TaskPriority.HIGH);
    assert.equal(updated.dueAt, null);

    const archived = await archiveTask(prisma, actorId, workspaceId, task.id, taskToken(updated));
    assert.ok(archived.archivedAt);
    assert.equal(
      (await listTasks(prisma, actorId, workspaceId)).items.some(({ id }) => id === task.id),
      false,
    );
    await assert.rejects(getTask(prisma, actorId, workspaceId, task.id), TaskNotFoundError);

    assert.deepEqual(
      (
        await prisma.auditEvent.findMany({
          orderBy: { createdAt: 'asc' },
          select: { action: true },
          where: { targetId: task.id },
        })
      ).map(({ action }) => action),
      [AuditAction.TASK_CREATED, AuditAction.TASK_UPDATED, AuditAction.TASK_ARCHIVED],
    );
  }
});

test('viewer remains read-only and failed writes emit no success event', async () => {
  const ownerId = await createUser();
  const viewerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  await addWorkspaceUser(organizationId, workspaceId, viewerId, WorkspaceRole.VIEWER);
  const task = await createTask(prisma, ownerId, workspaceId, taskInput('Viewer-readable task'));

  assert.equal((await listTasks(prisma, viewerId, workspaceId)).items.length, 1);
  assert.equal((await getTask(prisma, viewerId, workspaceId, task.id)).id, task.id);
  await assert.rejects(
    createTask(prisma, viewerId, workspaceId, taskInput('Denied create')),
    TaskAuthorizationError,
  );
  await assert.rejects(
    updateTask(prisma, viewerId, workspaceId, task.id, taskToken(task), taskInput('Denied update')),
    TaskAuthorizationError,
  );
  await assert.rejects(
    archiveTask(prisma, viewerId, workspaceId, task.id, taskToken(task)),
    TaskAuthorizationError,
  );
  assert.equal(
    await prisma.auditEvent.count({
      where: { actorUserId: viewerId, action: { startsWith: 'task.' } },
    }),
    0,
  );
});

test('Task updates compare and swap updatedAt without stale overwrites or audit events', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const task = await createTask(prisma, ownerId, workspaceId, taskInput('Original Task'));
  const originalToken = taskToken(task);

  const current = await updateTask(prisma, ownerId, workspaceId, task.id, originalToken, {
    ...taskInput('Current Task'),
    priority: TaskPriority.HIGH,
    status: TaskStatus.IN_PROGRESS,
  });
  assert.ok(current.updatedAt.getTime() > task.updatedAt.getTime());
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.TASK_UPDATED, targetId: task.id },
    }),
    1,
  );

  await assert.rejects(
    updateTask(prisma, ownerId, workspaceId, task.id, originalToken, taskInput('Stale Task')),
    TaskConflictError,
  );

  const persisted = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(persisted.title, 'Current Task');
  assert.equal(persisted.status, TaskStatus.IN_PROGRESS);
  assert.equal(persisted.priority, TaskPriority.HIGH);
  assert.equal(taskToken(persisted), taskToken(current));
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.TASK_UPDATED, targetId: task.id },
    }),
    1,
  );
});

test('Task concurrency tokens are canonical, resource-specific compare values', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const siblingWorkspaceId = await createWorkspace(organizationId, ownerId);
  const target = await createTask(prisma, ownerId, workspaceId, taskInput('Token target'));
  const other = await createTask(prisma, ownerId, workspaceId, taskInput('Other Task'));
  const sibling = await createTask(prisma, ownerId, siblingWorkspaceId, taskInput('Sibling Task'));
  const newerOther = await updateTask(
    prisma,
    ownerId,
    workspaceId,
    other.id,
    taskToken(other),
    taskInput('Newer other Task'),
  );
  const newerSibling = await updateTask(
    prisma,
    ownerId,
    siblingWorkspaceId,
    sibling.id,
    taskToken(sibling),
    taskInput('Newer sibling Task'),
  );

  for (const token of ['not-a-date', new Date().toUTCString()]) {
    await assert.rejects(
      updateTask(
        prisma,
        ownerId,
        workspaceId,
        target.id,
        token,
        taskInput('Malformed token update'),
      ),
      TaskValidationError,
    );
  }
  for (const token of [taskToken(newerOther), taskToken(newerSibling)]) {
    await assert.rejects(
      updateTask(prisma, ownerId, workspaceId, target.id, token, taskInput('Foreign token update')),
      TaskConflictError,
    );
  }

  const persisted = await prisma.task.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(persisted.title, 'Token target');
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.TASK_UPDATED, targetId: target.id },
    }),
    0,
  );
});

test('organization administration and client-selected workspace ids grant no Task authority', async () => {
  const ownerId = await createUser();
  const organizationAdminId = await createUser();
  const otherOwnerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const otherOrganizationId = await createOrganization(otherOwnerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const siblingWorkspaceId = await createWorkspace(organizationId, ownerId);
  const otherWorkspaceId = await createWorkspace(otherOrganizationId, otherOwnerId);
  const task = await createTask(prisma, ownerId, workspaceId, taskInput('Scoped task'));
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: OrganizationRole.ADMIN,
      status: MembershipStatus.ACTIVE,
      userId: organizationAdminId,
    },
  });

  await assert.rejects(listTasks(prisma, organizationAdminId, workspaceId), TaskAuthorizationError);
  await assert.rejects(
    updateTask(
      prisma,
      organizationAdminId,
      workspaceId,
      task.id,
      taskToken(task),
      taskInput('Organization admin denied update'),
    ),
    TaskAuthorizationError,
  );
  await assert.rejects(getTask(prisma, ownerId, siblingWorkspaceId, task.id), TaskNotFoundError);
  await assert.rejects(
    updateTask(
      prisma,
      ownerId,
      siblingWorkspaceId,
      task.id,
      taskToken(task),
      taskInput('Cross-workspace update'),
    ),
    TaskNotFoundError,
  );
  await assert.rejects(getTask(prisma, otherOwnerId, workspaceId, task.id), TaskAuthorizationError);
  await assert.rejects(
    updateTask(
      prisma,
      otherOwnerId,
      otherWorkspaceId,
      task.id,
      taskToken(task),
      taskInput('Forged update'),
    ),
    TaskNotFoundError,
  );
  assert.equal((await getTask(prisma, ownerId, workspaceId, task.id)).title, 'Scoped task');
});

test('ineffective memberships and archived workspaces deny Task access', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const task = await createTask(prisma, ownerId, workspaceId, taskInput('Membership task'));

  for (const [scope, status] of [
    ['organization', MembershipStatus.SUSPENDED],
    ['organization', MembershipStatus.REVOKED],
    ['workspace', MembershipStatus.SUSPENDED],
    ['workspace', MembershipStatus.REVOKED],
  ] as const) {
    const actorId = await createUser();
    await addWorkspaceUser(organizationId, workspaceId, actorId, WorkspaceRole.MEMBER);
    const revokedAt = status === MembershipStatus.REVOKED ? new Date() : null;
    if (scope === 'organization') {
      await prisma.organizationMembership.update({
        data: { revokedAt, status },
        where: { organizationId_userId: { organizationId, userId: actorId } },
      });
    } else {
      await prisma.workspaceMembership.update({
        data: { revokedAt, status },
        where: { workspaceId_userId: { userId: actorId, workspaceId } },
      });
    }

    await assert.rejects(listTasks(prisma, actorId, workspaceId), TaskAuthorizationError);
    await assert.rejects(getTask(prisma, actorId, workspaceId, task.id), TaskAuthorizationError);
    await assert.rejects(
      createTask(prisma, actorId, workspaceId, taskInput('Denied membership task')),
      TaskAuthorizationError,
    );
    await assert.rejects(
      updateTask(
        prisma,
        actorId,
        workspaceId,
        task.id,
        taskToken(task),
        taskInput('Denied membership update'),
      ),
      TaskAuthorizationError,
    );
  }

  await prisma.workspace.update({
    data: { archivedAt: new Date(), status: WorkspaceStatus.ARCHIVED },
    where: { id: workspaceId },
  });
  await assert.rejects(listTasks(prisma, ownerId, workspaceId), TaskAuthorizationError);
  await assert.rejects(getTask(prisma, ownerId, workspaceId, task.id), TaskAuthorizationError);
  await assert.rejects(
    updateTask(
      prisma,
      ownerId,
      workspaceId,
      task.id,
      taskToken(task),
      taskInput('Denied archive update'),
    ),
    TaskAuthorizationError,
  );
});

test('Task inputs reject invalid or oversized text, enum values, and dates', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);

  for (const input of [
    { ...taskInput('Invalid'), title: '   ' },
    { ...taskInput('Invalid'), title: 'x'.repeat(201) },
    { ...taskInput('Invalid'), description: 'x'.repeat(10_001) },
    { ...taskInput('Invalid'), status: 'BLOCKED' },
    { ...taskInput('Invalid'), priority: 'URGENT' },
    { ...taskInput('Invalid'), dueAt: '2026-02-30' },
  ]) {
    await assert.rejects(createTask(prisma, ownerId, workspaceId, input), TaskValidationError);
  }
  assert.equal(await prisma.task.count({ where: { workspaceId } }), 0);
  assert.equal(
    await prisma.auditEvent.count({ where: { action: AuditAction.TASK_CREATED, workspaceId } }),
    0,
  );
});

test('assignees must remain effective members of the same workspace for every assignment', async () => {
  const ownerId = await createUser();
  const assigneeId = await createUser();
  const siblingMemberId = await createUser();
  const outsideUserId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const outsideOrganizationId = await createOrganization(outsideUserId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const siblingWorkspaceId = await createWorkspace(organizationId, ownerId);
  await createWorkspace(outsideOrganizationId, outsideUserId);
  await addWorkspaceUser(organizationId, workspaceId, assigneeId, WorkspaceRole.MEMBER);
  await addWorkspaceUser(organizationId, siblingWorkspaceId, siblingMemberId, WorkspaceRole.MEMBER);

  const task = await createTask(prisma, ownerId, workspaceId, {
    ...taskInput('Assigned task'),
    assigneeUserId: assigneeId,
  });
  assert.equal(task.assigneeUserId, assigneeId);
  assert.equal(isTaskAssigneeEffective(task), true);
  assert.deepEqual(
    (await listTaskAssignees(prisma, ownerId, workspaceId)).map(({ id }) => id).sort(),
    [assigneeId, ownerId].sort(),
  );

  for (const invalidAssignee of [siblingMemberId, outsideUserId, randomUUID()]) {
    await assert.rejects(
      updateTask(prisma, ownerId, workspaceId, task.id, taskToken(task), {
        ...taskInput('Invalid reassignment'),
        assigneeUserId: invalidAssignee,
      }),
      TaskValidationError,
    );
  }

  const current = await updateTask(prisma, ownerId, workspaceId, task.id, taskToken(task), {
    ...taskInput('Assigned task current'),
    assigneeUserId: assigneeId,
  });

  await prisma.workspaceMembership.update({
    data: { status: MembershipStatus.SUSPENDED },
    where: { workspaceId_userId: { userId: assigneeId, workspaceId } },
  });
  const retained = await getTask(prisma, ownerId, workspaceId, task.id);
  assert.equal(retained.assigneeUserId, assigneeId);
  assert.equal(isTaskAssigneeEffective(retained), false);
  await assert.rejects(
    updateTask(prisma, ownerId, workspaceId, task.id, taskToken(task), {
      ...taskInput('Suspended reassignment'),
      assigneeUserId: assigneeId,
    }),
    TaskValidationError,
  );
  const unassigned = await updateTask(prisma, ownerId, workspaceId, task.id, taskToken(current), {
    ...taskInput('Unassigned task'),
    assigneeUserId: null,
  });
  assert.equal(unassigned.assigneeUserId, null);
});

test('suspended or revoked parent and workspace memberships make an assignee invalid', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);

  for (const [scope, status] of [
    ['organization', MembershipStatus.SUSPENDED],
    ['organization', MembershipStatus.REVOKED],
    ['workspace', MembershipStatus.SUSPENDED],
    ['workspace', MembershipStatus.REVOKED],
  ] as const) {
    const assigneeId = await createUser();
    await addWorkspaceUser(organizationId, workspaceId, assigneeId, WorkspaceRole.MEMBER);
    const revokedAt = status === MembershipStatus.REVOKED ? new Date() : null;
    if (scope === 'organization') {
      await prisma.organizationMembership.update({
        data: { revokedAt, status },
        where: { organizationId_userId: { organizationId, userId: assigneeId } },
      });
    } else {
      await prisma.workspaceMembership.update({
        data: { revokedAt, status },
        where: { workspaceId_userId: { userId: assigneeId, workspaceId } },
      });
    }
    await assert.rejects(
      createTask(prisma, ownerId, workspaceId, {
        ...taskInput(`${status} ${scope} assignee`),
        assigneeUserId: assigneeId,
      }),
      TaskValidationError,
    );
  }
});

test('Task id, workspace, and creator identity cannot be reassigned', async () => {
  const ownerId = await createUser();
  const otherUserId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const otherWorkspaceId = await createWorkspace(organizationId, ownerId);
  const task = await createTask(prisma, ownerId, workspaceId, taskInput('Immutable Task'));

  await assert.rejects(prisma.task.update({ data: { id: randomUUID() }, where: { id: task.id } }));
  await assert.rejects(
    prisma.task.update({ data: { workspaceId: otherWorkspaceId }, where: { id: task.id } }),
  );
  await assert.rejects(
    prisma.task.update({ data: { createdByUserId: otherUserId }, where: { id: task.id } }),
  );
  const persisted = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(persisted.id, task.id);
  assert.equal(persisted.workspaceId, workspaceId);
  assert.equal(persisted.createdByUserId, ownerId);
});

test('Task cursor pagination preserves the complete order without duplicates or gaps', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const siblingWorkspaceId = await createWorkspace(organizationId, ownerId);
  const tieUpdatedAt = new Date('2026-08-11T13:00:00.000Z');
  const definitions = [
    ['Todo newer', TaskStatus.TODO, '2026-08-10', new Date('2026-08-11T14:00:00.000Z')],
    [
      'Todo tie A',
      TaskStatus.TODO,
      '2026-08-10',
      tieUpdatedAt,
      '00000000-0000-4000-8000-000000000001',
    ],
    [
      'Todo tie B',
      TaskStatus.TODO,
      '2026-08-10',
      tieUpdatedAt,
      '00000000-0000-4000-8000-000000000002',
    ],
    ['Todo older', TaskStatus.TODO, '2026-08-10', new Date('2026-08-11T12:00:00.000Z')],
    ['Todo later', TaskStatus.TODO, '2026-09-10', tieUpdatedAt],
    ['Todo null newer', TaskStatus.TODO, null, new Date('2026-08-11T15:00:00.000Z')],
    ['Todo null older', TaskStatus.TODO, null, new Date('2026-08-11T11:00:00.000Z')],
    ['Progress dated', TaskStatus.IN_PROGRESS, '2026-08-01', tieUpdatedAt],
    ['Done dated', TaskStatus.DONE, '2026-07-01', tieUpdatedAt],
  ] as const;

  for (const [title, status, dueAt, updatedAt, id] of definitions) {
    await createTaskListFixture(workspaceId, ownerId, {
      dueAt,
      id,
      status,
      title,
      updatedAt,
    });
  }
  const archived = await createTaskListFixture(workspaceId, ownerId, {
    archived: true,
    dueAt: '2026-08-10',
    status: TaskStatus.TODO,
    title: 'Archived ordering',
    updatedAt: tieUpdatedAt,
  });
  await createTaskListFixture(siblingWorkspaceId, ownerId, {
    dueAt: '2026-08-10',
    status: TaskStatus.TODO,
    title: 'Sibling workspace ordering',
    updatedAt: tieUpdatedAt,
  });

  const pages: Array<Awaited<ReturnType<typeof listTasks>>> = [];
  let cursor: string | undefined;
  do {
    const page = await listTasks(prisma, ownerId, workspaceId, { cursor, pageSize: 2 });
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const firstPage = pages[0];
  const secondPage = pages[1];
  const finalPage = pages.at(-1);
  assert.ok(firstPage);
  assert.ok(secondPage);
  assert.ok(finalPage);
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.hasNextPage, true);
  assert.ok(firstPage.nextCursor);
  assert.equal(secondPage.items.length, 2);
  assert.equal(secondPage.hasNextPage, true);
  assert.ok(secondPage.nextCursor);
  assert.equal(finalPage.items.length, 1);
  assert.equal(finalPage.hasNextPage, false);
  assert.equal(finalPage.nextCursor, null);

  const traversed = pages.flatMap(({ items }) => items);
  assert.deepEqual(
    traversed.map(({ title }) => title),
    definitions.map(([title]) => title),
  );
  assert.equal(new Set(traversed.map(({ id }) => id)).size, traversed.length);
  assert.equal(
    traversed.some(({ id }) => id === archived.id),
    false,
  );
});

test('Task pagination applies bounded page sizes and rejects malformed or noncanonical cursors', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const emptyWorkspaceId = await createWorkspace(organizationId, ownerId);
  const smallWorkspaceId = await createWorkspace(organizationId, ownerId);
  const updatedAt = new Date('2026-08-11T16:00:00.000Z');

  for (let index = 0; index < TASK_DEFAULT_PAGE_SIZE + 1; index += 1) {
    await createTaskListFixture(workspaceId, ownerId, {
      dueAt: '2026-09-15',
      status: TaskStatus.TODO,
      title: `Default page ${index.toString().padStart(2, '0')}`,
      updatedAt,
    });
  }
  for (let index = 0; index < 2; index += 1) {
    await createTaskListFixture(smallWorkspaceId, ownerId, {
      dueAt: null,
      status: TaskStatus.DONE,
      title: `Small page ${index}`,
      updatedAt,
    });
  }

  const defaultPage = await listTasks(prisma, ownerId, workspaceId);
  assert.equal(defaultPage.items.length, TASK_DEFAULT_PAGE_SIZE);
  assert.equal(defaultPage.hasNextPage, true);
  assert.ok(defaultPage.nextCursor);
  const maximumPage = await listTasks(prisma, ownerId, workspaceId, {
    pageSize: TASK_MAX_PAGE_SIZE,
  });
  assert.equal(maximumPage.items.length, TASK_DEFAULT_PAGE_SIZE + 1);
  assert.equal(maximumPage.hasNextPage, false);
  assert.equal(maximumPage.nextCursor, null);
  assert.deepEqual(await listTasks(prisma, ownerId, emptyWorkspaceId), {
    hasNextPage: false,
    items: [],
    nextCursor: null,
  });
  assert.equal(
    (await listTasks(prisma, ownerId, smallWorkspaceId, { pageSize: 5 })).items.length,
    2,
  );

  for (const pageSize of [0, -1, 1.5, TASK_MAX_PAGE_SIZE + 1, Number.NaN, Infinity]) {
    await assert.rejects(
      listTasks(prisma, ownerId, workspaceId, { pageSize }),
      TaskValidationError,
    );
  }
  for (const cursor of ['', 'not-a-base64url-cursor!', Buffer.from('{}').toString('base64url')]) {
    await assert.rejects(listTasks(prisma, ownerId, workspaceId, { cursor }), TaskValidationError);
  }

  const decodedCursor = JSON.parse(
    Buffer.from(defaultPage.nextCursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  const noncanonicalCursor = Buffer.from(
    JSON.stringify({
      workspaceId: decodedCursor.workspaceId,
      version: decodedCursor.version,
      updatedAt: decodedCursor.updatedAt,
      status: decodedCursor.status,
      id: decodedCursor.id,
      dueAt: decodedCursor.dueAt,
    }),
    'utf8',
  ).toString('base64url');
  await assert.rejects(
    listTasks(prisma, ownerId, workspaceId, { cursor: noncanonicalCursor }),
    TaskValidationError,
  );
});

test('Task cursors remain workspace-scoped navigation state after authorization', async () => {
  const ownerId = await createUser();
  const viewerId = await createUser();
  const organizationAdminId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const siblingWorkspaceId = await createWorkspace(organizationId, ownerId);
  await addWorkspaceUser(organizationId, workspaceId, viewerId, WorkspaceRole.VIEWER);
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: OrganizationRole.ADMIN,
      status: MembershipStatus.ACTIVE,
      userId: organizationAdminId,
    },
  });
  const updatedAt = new Date('2026-08-11T17:00:00.000Z');
  for (const title of ['First cursor Task', 'Second cursor Task']) {
    await createTaskListFixture(workspaceId, ownerId, {
      dueAt: null,
      status: TaskStatus.TODO,
      title,
      updatedAt,
    });
  }
  const firstPage = await listTasks(prisma, ownerId, workspaceId, { pageSize: 1 });
  assert.ok(firstPage.nextCursor);

  const viewerPage = await listTasks(prisma, viewerId, workspaceId, {
    cursor: firstPage.nextCursor,
    pageSize: 1,
  });
  assert.equal(viewerPage.items.length, 1);
  await assert.rejects(
    listTasks(prisma, ownerId, siblingWorkspaceId, {
      cursor: firstPage.nextCursor,
      pageSize: 1,
    }),
    TaskValidationError,
  );
  await assert.rejects(
    listTasks(prisma, organizationAdminId, workspaceId, {
      cursor: 'malformed-cursor!',
      pageSize: 1,
    }),
    TaskAuthorizationError,
  );
});

test('Task archive uses the same concurrency token and leaves stale requests active', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const task = await createTask(prisma, ownerId, workspaceId, taskInput('Archive concurrency'));
  const staleToken = taskToken(task);
  const current = await updateTask(
    prisma,
    ownerId,
    workspaceId,
    task.id,
    staleToken,
    taskInput('Current before archive'),
  );

  await assert.rejects(
    archiveTask(prisma, ownerId, workspaceId, task.id, staleToken),
    TaskConflictError,
  );
  const stillActive = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(stillActive.archivedAt, null);
  assert.equal(stillActive.title, 'Current before archive');
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.TASK_ARCHIVED, targetId: task.id },
    }),
    0,
  );

  const archived = await archiveTask(prisma, ownerId, workspaceId, task.id, taskToken(current));
  assert.ok(archived.archivedAt);
  assert.ok(archived.updatedAt.getTime() > current.updatedAt.getTime());
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.TASK_ARCHIVED, targetId: task.id },
    }),
    1,
  );
  await assert.rejects(
    updateTask(
      prisma,
      ownerId,
      workspaceId,
      task.id,
      taskToken(archived),
      taskInput('Archived update denied'),
    ),
    TaskNotFoundError,
  );
});

test('an audit insertion failure rolls back the Task mutation', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspaceId = await createWorkspace(organizationId, ownerId);
  const task = await createTask(prisma, ownerId, workspaceId, taskInput('Atomic Task'));

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_task_audit_insert_for_test() RETURNS trigger AS $$
    BEGIN
      IF NEW."action" = 'task.updated' THEN
        RAISE EXCEPTION 'forced Task audit insert failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_task_audit_insert_for_test
    BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_task_audit_insert_for_test();
  `);

  try {
    await assert.rejects(
      updateTask(prisma, ownerId, workspaceId, task.id, taskToken(task), {
        ...taskInput('Must roll back'),
        status: TaskStatus.DONE,
      }),
    );
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_task_audit_insert_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_task_audit_insert_for_test();');
  }

  const persisted = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(persisted.title, 'Atomic Task');
  assert.equal(persisted.status, TaskStatus.TODO);
  assert.equal(taskToken(persisted), taskToken(task));
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.TASK_UPDATED, targetId: task.id },
    }),
    0,
  );
});

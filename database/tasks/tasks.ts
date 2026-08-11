import {
  MembershipStatus,
  OrganizationStatus,
  type Prisma,
  type PrismaClient,
  TaskPriority,
  TaskStatus,
  UserStatus,
  WorkspaceStatus,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';
import { workspaceRoleGrantsPermission } from '../policy/authorization-policy';

export class TaskError extends Error {}

export class TaskAuthorizationError extends TaskError {}

export class TaskNotFoundError extends TaskError {}

export class TaskValidationError extends TaskError {}

export const TASK_LIST_LIMIT = 100;
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 10_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type Transaction = Prisma.TransactionClient;
type TaskDatabase = PrismaClient | Transaction;
type TaskPermission = 'tasks.read' | 'tasks.write';

export type TaskInput = Readonly<{
  assigneeUserId?: string | null;
  description?: string | null;
  dueAt?: string | null;
  priority: string;
  status: string;
  title: string;
}>;

type TaskValue = Readonly<{
  assigneeUserId: string | null;
  description: string | null;
  dueAt: Date | null;
  priority: TaskPriority;
  status: TaskStatus;
  title: string;
}>;

type TaskWorkspaceAccess = Readonly<{
  organizationId: string;
  workspaceId: string;
}>;

function getTitle(value: string): string {
  const title = value.trim().replace(/\s+/gu, ' ');

  if (title.length < 1 || title.length > TASK_TITLE_MAX_LENGTH) {
    throw new TaskValidationError(
      `Task titles must contain between 1 and ${TASK_TITLE_MAX_LENGTH} characters.`,
    );
  }

  return title;
}

function getDescription(value: string | null | undefined): string | null {
  const description = value?.trim() ?? '';

  if (!description) return null;
  if (description.length > TASK_DESCRIPTION_MAX_LENGTH) {
    throw new TaskValidationError(
      `Task descriptions must not exceed ${TASK_DESCRIPTION_MAX_LENGTH.toLocaleString('en-US')} characters.`,
    );
  }

  return description;
}

function getStatus(value: string): TaskStatus {
  if (value === TaskStatus.TODO) return TaskStatus.TODO;
  if (value === TaskStatus.IN_PROGRESS) return TaskStatus.IN_PROGRESS;
  if (value === TaskStatus.DONE) return TaskStatus.DONE;
  throw new TaskValidationError('Select a valid Task status.');
}

function getPriority(value: string): TaskPriority {
  if (value === TaskPriority.LOW) return TaskPriority.LOW;
  if (value === TaskPriority.MEDIUM) return TaskPriority.MEDIUM;
  if (value === TaskPriority.HIGH) return TaskPriority.HIGH;
  throw new TaskValidationError('Select a valid Task priority.');
}

function getAssigneeUserId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!UUID_PATTERN.test(value)) {
    throw new TaskValidationError('Select a valid workspace assignee.');
  }
  return value;
}

function getDueAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TaskValidationError('Enter a valid due date.');
  }

  const dueAt = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(dueAt.valueOf()) || dueAt.toISOString().slice(0, 10) !== value) {
    throw new TaskValidationError('Enter a valid due date.');
  }
  return dueAt;
}

function getTaskValue(input: TaskInput): TaskValue {
  return {
    assigneeUserId: getAssigneeUserId(input.assigneeUserId),
    description: getDescription(input.description),
    dueAt: getDueAt(input.dueAt),
    priority: getPriority(input.priority),
    status: getStatus(input.status),
    title: getTitle(input.title),
  };
}

function dueDateValue(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

export async function requireTaskWorkspaceAccess(
  prisma: TaskDatabase,
  actorUserId: string,
  workspaceId: string,
  permission: TaskPermission,
): Promise<TaskWorkspaceAccess> {
  const membership = await prisma.workspaceMembership.findFirst({
    where: {
      status: MembershipStatus.ACTIVE,
      userId: actorUserId,
      workspace: {
        deletedAt: null,
        id: workspaceId,
        organization: {
          deletedAt: null,
          status: OrganizationStatus.ACTIVE,
        },
        status: WorkspaceStatus.ACTIVE,
      },
    },
    select: {
      role: true,
      workspace: {
        select: {
          organizationId: true,
          organization: {
            select: {
              memberships: {
                select: { id: true },
                where: {
                  status: MembershipStatus.ACTIVE,
                  userId: actorUserId,
                  user: { deletedAt: null, status: UserStatus.ACTIVE },
                },
              },
            },
          },
        },
      },
    },
  });

  if (
    !membership ||
    membership.workspace.organization.memberships.length !== 1 ||
    !workspaceRoleGrantsPermission(membership.role, permission)
  ) {
    throw new TaskAuthorizationError(`${permission} requires effective workspace membership.`);
  }

  return {
    organizationId: membership.workspace.organizationId,
    workspaceId,
  };
}

async function requireEffectiveAssignee(
  prisma: TaskDatabase,
  workspaceId: string,
  organizationId: string,
  assigneeUserId: string | null,
): Promise<void> {
  if (!assigneeUserId) return;

  const membership = await prisma.workspaceMembership.findFirst({
    where: {
      status: MembershipStatus.ACTIVE,
      userId: assigneeUserId,
      workspaceId,
      user: {
        deletedAt: null,
        organizationMemberships: {
          some: {
            organizationId,
            status: MembershipStatus.ACTIVE,
          },
        },
        status: UserStatus.ACTIVE,
      },
    },
    select: { id: true },
  });

  if (!membership) {
    throw new TaskValidationError('Select an active member of this workspace as the assignee.');
  }
}

function taskInclude(organizationId: string, workspaceId: string) {
  return {
    assignee: {
      select: {
        deletedAt: true,
        displayName: true,
        email: true,
        id: true,
        organizationMemberships: {
          select: { id: true },
          where: { organizationId, status: MembershipStatus.ACTIVE },
        },
        status: true,
        workspaceMemberships: {
          select: { id: true },
          where: { status: MembershipStatus.ACTIVE, workspaceId },
        },
      },
    },
    createdBy: { select: { displayName: true, email: true, id: true } },
  } as const;
}

export function isTaskAssigneeEffective(task: {
  assignee: null | {
    deletedAt: Date | null;
    organizationMemberships: readonly unknown[];
    status: UserStatus;
    workspaceMemberships: readonly unknown[];
  };
}): boolean {
  return Boolean(
    task.assignee &&
    !task.assignee.deletedAt &&
    task.assignee.status === UserStatus.ACTIVE &&
    task.assignee.organizationMemberships.length === 1 &&
    task.assignee.workspaceMemberships.length === 1,
  );
}

export async function listTaskAssignees(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
) {
  const access = await requireTaskWorkspaceAccess(prisma, actorUserId, workspaceId, 'tasks.write');
  const memberships = await prisma.workspaceMembership.findMany({
    where: {
      status: MembershipStatus.ACTIVE,
      workspaceId,
      user: {
        deletedAt: null,
        organizationMemberships: {
          some: {
            organizationId: access.organizationId,
            status: MembershipStatus.ACTIVE,
          },
        },
        status: UserStatus.ACTIVE,
      },
    },
    select: {
      user: { select: { displayName: true, email: true, id: true } },
    },
    orderBy: [{ user: { displayName: 'asc' } }, { user: { email: 'asc' } }, { userId: 'asc' }],
  });

  return memberships.map(({ user }) => user);
}

export async function listTasks(prisma: PrismaClient, actorUserId: string, workspaceId: string) {
  const access = await requireTaskWorkspaceAccess(prisma, actorUserId, workspaceId, 'tasks.read');

  return prisma.task.findMany({
    where: { archivedAt: null, workspaceId },
    include: taskInclude(access.organizationId, workspaceId),
    orderBy: [
      { status: 'asc' },
      { dueAt: { nulls: 'last', sort: 'asc' } },
      { updatedAt: 'desc' },
      { id: 'asc' },
    ],
    take: TASK_LIST_LIMIT,
  });
}

async function findTask(
  prisma: TaskDatabase,
  organizationId: string,
  workspaceId: string,
  taskId: string,
) {
  if (!UUID_PATTERN.test(taskId)) {
    throw new TaskNotFoundError('The Task was not found in this workspace.');
  }

  const task = await prisma.task.findFirst({
    where: { archivedAt: null, id: taskId, workspaceId },
    include: taskInclude(organizationId, workspaceId),
  });
  if (!task) {
    throw new TaskNotFoundError('The Task was not found in this workspace.');
  }
  return task;
}

export async function getTask(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  taskId: string,
) {
  const access = await requireTaskWorkspaceAccess(prisma, actorUserId, workspaceId, 'tasks.read');
  return findTask(prisma, access.organizationId, workspaceId, taskId);
}

export async function createTask(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  input: TaskInput,
) {
  return prisma.$transaction(async (transaction) => {
    const access = await requireTaskWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      'tasks.write',
    );
    const value = getTaskValue(input);
    await requireEffectiveAssignee(
      transaction,
      workspaceId,
      access.organizationId,
      value.assigneeUserId,
    );
    const task = await transaction.task.create({
      data: {
        ...value,
        createdByUserId: actorUserId,
        workspaceId,
      },
      include: taskInclude(access.organizationId, workspaceId),
    });

    await appendAuditEvent(transaction, {
      action: AuditAction.TASK_CREATED,
      actorUserId,
      metadata: {
        assigneeUserId: task.assigneeUserId,
        dueAt: dueDateValue(task.dueAt),
        priority: task.priority,
        status: task.status,
      },
      organizationId: access.organizationId,
      targetId: task.id,
      targetType: AuditTargetType.TASK,
      workspaceId,
    });

    return task;
  });
}

export async function updateTask(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  taskId: string,
  input: TaskInput,
) {
  return prisma.$transaction(async (transaction) => {
    const access = await requireTaskWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      'tasks.write',
    );
    const current = await findTask(transaction, access.organizationId, workspaceId, taskId);
    const value = getTaskValue(input);
    await requireEffectiveAssignee(
      transaction,
      workspaceId,
      access.organizationId,
      value.assigneeUserId,
    );
    const task = await transaction.task.update({
      data: value,
      include: taskInclude(access.organizationId, workspaceId),
      where: { id: current.id },
    });

    await appendAuditEvent(transaction, {
      action: AuditAction.TASK_UPDATED,
      actorUserId,
      metadata: {
        afterAssigneeUserId: task.assigneeUserId,
        afterDueAt: dueDateValue(task.dueAt),
        afterPriority: task.priority,
        afterStatus: task.status,
        beforeAssigneeUserId: current.assigneeUserId,
        beforeDueAt: dueDateValue(current.dueAt),
        beforePriority: current.priority,
        beforeStatus: current.status,
        descriptionChanged: current.description !== task.description,
        titleChanged: current.title !== task.title,
      },
      organizationId: access.organizationId,
      targetId: task.id,
      targetType: AuditTargetType.TASK,
      workspaceId,
    });

    return task;
  });
}

export async function archiveTask(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  taskId: string,
) {
  return prisma.$transaction(async (transaction) => {
    const access = await requireTaskWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      'tasks.write',
    );
    const current = await findTask(transaction, access.organizationId, workspaceId, taskId);
    const task = await transaction.task.update({
      data: { archivedAt: new Date() },
      where: { id: current.id },
    });

    await appendAuditEvent(transaction, {
      action: AuditAction.TASK_ARCHIVED,
      actorUserId,
      metadata: { priority: task.priority, status: task.status },
      organizationId: access.organizationId,
      targetId: task.id,
      targetType: AuditTargetType.TASK,
      workspaceId,
    });

    return task;
  });
}

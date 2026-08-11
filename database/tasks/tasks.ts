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

export class TaskConflictError extends TaskError {}

export const TASK_DEFAULT_PAGE_SIZE = 25;
export const TASK_MAX_PAGE_SIZE = 100;
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 10_000;

const TASK_CURSOR_VERSION = 1;
const TASK_CURSOR_MAX_LENGTH = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONCURRENCY_TOKEN_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

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

export type TaskListOptions = Readonly<{
  cursor?: string;
  pageSize?: number;
}>;

type TaskCursor = Readonly<{
  dueAt: string | null;
  id: string;
  status: TaskStatus;
  updatedAt: string;
  version: typeof TASK_CURSOR_VERSION;
  workspaceId: string;
}>;

type TaskCursorValue = Readonly<{
  dueAt: Date | null;
  id: string;
  status: TaskStatus;
  updatedAt: Date;
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
  if (!DUE_DATE_PATTERN.test(value)) {
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

function getTaskPageSize(value: number | undefined): number {
  const pageSize = value ?? TASK_DEFAULT_PAGE_SIZE;

  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > TASK_MAX_PAGE_SIZE) {
    throw new TaskValidationError(`Task page size must be between 1 and ${TASK_MAX_PAGE_SIZE}.`);
  }

  return pageSize;
}

function encodeTaskCursor(
  workspaceId: string,
  task: { dueAt: Date | null; id: string; status: TaskStatus; updatedAt: Date },
): string {
  const cursor: TaskCursor = {
    dueAt: dueDateValue(task.dueAt),
    id: task.id,
    status: task.status,
    updatedAt: task.updatedAt.toISOString(),
    version: TASK_CURSOR_VERSION,
    workspaceId,
  };

  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === TaskStatus.TODO || value === TaskStatus.IN_PROGRESS || value === TaskStatus.DONE;
}

function decodeTaskCursor(
  encodedCursor: string | undefined,
  workspaceId: string,
): TaskCursorValue | null {
  if (encodedCursor === undefined) return null;

  try {
    if (
      encodedCursor.length < 1 ||
      encodedCursor.length > TASK_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(encodedCursor)
    ) {
      throw new Error('Invalid cursor encoding.');
    }

    const decodedBytes = Buffer.from(encodedCursor, 'base64url');
    if (decodedBytes.toString('base64url') !== encodedCursor) {
      throw new Error('Non-canonical cursor encoding.');
    }

    const value: unknown = JSON.parse(decodedBytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid cursor payload.');
    }

    const cursor = value as Partial<TaskCursor>;
    const dueAt =
      cursor.dueAt === null
        ? null
        : typeof cursor.dueAt === 'string' && DUE_DATE_PATTERN.test(cursor.dueAt)
          ? new Date(`${cursor.dueAt}T00:00:00.000Z`)
          : new Date(Number.NaN);
    const updatedAt =
      typeof cursor.updatedAt === 'string' ? new Date(cursor.updatedAt) : new Date(Number.NaN);
    if (
      cursor.version !== TASK_CURSOR_VERSION ||
      cursor.workspaceId !== workspaceId ||
      typeof cursor.workspaceId !== 'string' ||
      !UUID_PATTERN.test(cursor.workspaceId) ||
      cursor.workspaceId !== cursor.workspaceId.toLowerCase() ||
      typeof cursor.id !== 'string' ||
      !UUID_PATTERN.test(cursor.id) ||
      cursor.id !== cursor.id.toLowerCase() ||
      !isTaskStatus(cursor.status) ||
      Number.isNaN(dueAt?.valueOf()) ||
      (dueAt && dueDateValue(dueAt) !== cursor.dueAt) ||
      Number.isNaN(updatedAt.valueOf()) ||
      updatedAt.toISOString() !== cursor.updatedAt
    ) {
      throw new Error('Invalid cursor values.');
    }

    const canonicalCursor: TaskCursor = {
      dueAt: dueDateValue(dueAt),
      id: cursor.id,
      status: cursor.status,
      updatedAt: cursor.updatedAt,
      version: TASK_CURSOR_VERSION,
      workspaceId: cursor.workspaceId,
    };
    if (
      Buffer.from(JSON.stringify(canonicalCursor), 'utf8').toString('base64url') !== encodedCursor
    ) {
      throw new Error('Non-canonical cursor payload.');
    }

    return { dueAt, id: cursor.id, status: cursor.status, updatedAt };
  } catch {
    throw new TaskValidationError('The Task cursor is invalid.');
  }
}

function statusesAfter(status: TaskStatus): TaskStatus[] {
  if (status === TaskStatus.TODO) return [TaskStatus.IN_PROGRESS, TaskStatus.DONE];
  if (status === TaskStatus.IN_PROGRESS) return [TaskStatus.DONE];
  return [];
}

function getTaskCursorContinuation(cursor: TaskCursorValue): Prisma.TaskWhereInput {
  const laterStatuses = statusesAfter(cursor.status);
  const afterSamePosition: Prisma.TaskWhereInput = {
    dueAt: cursor.dueAt,
    status: cursor.status,
    OR: [
      { updatedAt: { lt: cursor.updatedAt } },
      { id: { gt: cursor.id }, updatedAt: cursor.updatedAt },
    ],
  };
  const continuation: Prisma.TaskWhereInput[] = [afterSamePosition];

  if (cursor.dueAt) {
    continuation.unshift(
      { dueAt: { gt: cursor.dueAt }, status: cursor.status },
      { dueAt: null, status: cursor.status },
    );
  }
  if (laterStatuses.length > 0) {
    continuation.push({ status: { in: laterStatuses } });
  }

  return { OR: continuation };
}

export function serializeTaskConcurrencyToken(updatedAt: Date): string {
  return updatedAt.toISOString();
}

function getExpectedUpdatedAt(value: string): Date {
  if (!CONCURRENCY_TOKEN_PATTERN.test(value)) {
    throw new TaskValidationError('The Task version is unavailable. Reload and try again.');
  }

  const expectedUpdatedAt = new Date(value);
  if (
    Number.isNaN(expectedUpdatedAt.valueOf()) ||
    serializeTaskConcurrencyToken(expectedUpdatedAt) !== value
  ) {
    throw new TaskValidationError('The Task version is unavailable. Reload and try again.');
  }
  return expectedUpdatedAt;
}

function getNextUpdatedAt(expectedUpdatedAt: Date): Date {
  return new Date(Math.max(Date.now(), expectedUpdatedAt.getTime() + 1));
}

function requireTaskId(taskId: string): void {
  if (!UUID_PATTERN.test(taskId)) {
    throw new TaskNotFoundError('The Task was not found in this workspace.');
  }
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

export async function listTasks(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  options: TaskListOptions = {},
) {
  const access = await requireTaskWorkspaceAccess(prisma, actorUserId, workspaceId, 'tasks.read');
  const pageSize = getTaskPageSize(options.pageSize);
  const cursor = decodeTaskCursor(options.cursor, workspaceId);

  const tasks = await prisma.task.findMany({
    where: {
      archivedAt: null,
      workspaceId,
      ...(cursor ? getTaskCursorContinuation(cursor) : {}),
    },
    include: taskInclude(access.organizationId, workspaceId),
    orderBy: [
      { status: 'asc' },
      { dueAt: { nulls: 'last', sort: 'asc' } },
      { updatedAt: 'desc' },
      { id: 'asc' },
    ],
    take: pageSize + 1,
  });

  const hasNextPage = tasks.length > pageSize;
  const items = hasNextPage ? tasks.slice(0, pageSize) : tasks;
  const lastTask = items.at(-1);

  return {
    hasNextPage,
    items,
    nextCursor: hasNextPage && lastTask ? encodeTaskCursor(workspaceId, lastTask) : null,
  };
}

async function findTask(
  prisma: TaskDatabase,
  organizationId: string,
  workspaceId: string,
  taskId: string,
) {
  requireTaskId(taskId);

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
  expectedUpdatedAt: string,
  input: TaskInput,
) {
  return prisma.$transaction(async (transaction) => {
    const access = await requireTaskWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      'tasks.write',
    );
    requireTaskId(taskId);
    const expectedUpdatedAtValue = getExpectedUpdatedAt(expectedUpdatedAt);
    const value = getTaskValue(input);
    await requireEffectiveAssignee(
      transaction,
      workspaceId,
      access.organizationId,
      value.assigneeUserId,
    );
    const current = await findTask(transaction, access.organizationId, workspaceId, taskId);
    const updated = await transaction.task.updateMany({
      data: { ...value, updatedAt: getNextUpdatedAt(expectedUpdatedAtValue) },
      where: {
        archivedAt: null,
        id: current.id,
        updatedAt: expectedUpdatedAtValue,
        workspaceId,
      },
    });
    if (updated.count !== 1) {
      throw new TaskConflictError(
        'This task changed since you opened it. Reload the latest version and try again.',
      );
    }
    const task = await findTask(transaction, access.organizationId, workspaceId, taskId);

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
        beforeUpdatedAt: serializeTaskConcurrencyToken(current.updatedAt),
        descriptionChanged: current.description !== task.description,
        titleChanged: current.title !== task.title,
        updatedAt: serializeTaskConcurrencyToken(task.updatedAt),
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
  expectedUpdatedAt: string,
) {
  return prisma.$transaction(async (transaction) => {
    const access = await requireTaskWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      'tasks.write',
    );
    requireTaskId(taskId);
    const expectedUpdatedAtValue = getExpectedUpdatedAt(expectedUpdatedAt);
    const current = await findTask(transaction, access.organizationId, workspaceId, taskId);
    const archivedAt = new Date();
    const updated = await transaction.task.updateMany({
      data: {
        archivedAt,
        updatedAt: getNextUpdatedAt(expectedUpdatedAtValue),
      },
      where: {
        archivedAt: null,
        id: current.id,
        updatedAt: expectedUpdatedAtValue,
        workspaceId,
      },
    });
    if (updated.count !== 1) {
      throw new TaskConflictError(
        'This task changed since you opened it. Reload the latest version and try again.',
      );
    }
    const task = await transaction.task.findUniqueOrThrow({ where: { id: current.id } });

    await appendAuditEvent(transaction, {
      action: AuditAction.TASK_ARCHIVED,
      actorUserId,
      metadata: {
        beforeUpdatedAt: serializeTaskConcurrencyToken(current.updatedAt),
        priority: task.priority,
        status: task.status,
        updatedAt: serializeTaskConcurrencyToken(task.updatedAt),
      },
      organizationId: access.organizationId,
      targetId: task.id,
      targetType: AuditTargetType.TASK,
      workspaceId,
    });

    return task;
  });
}

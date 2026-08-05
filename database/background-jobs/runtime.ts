import {
  BackgroundJobAttemptOutcome,
  BackgroundJobKind,
  BackgroundJobStatus,
  Prisma,
  type BackgroundJob,
  type PrismaClient,
} from '../generated/client/client';

type Transaction = Prisma.TransactionClient;

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ALLOWED_ATTEMPTS = 25;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const MAX_ERROR_MESSAGE_LENGTH = 500;

export type StructuredJobError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

export type DurableBackgroundJobInput = Readonly<{
  kind: BackgroundJobKind;
  workspaceId: string;
  requestedByUserId: string;
  domainJobId: string;
  idempotencyKey: string;
  payload?: Prisma.InputJsonValue;
  availableAt?: Date;
  maxAttempts?: number;
}>;

export type BackgroundJobRuntimeOptions = Readonly<{
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}>;

export type BackgroundJobHandler = (job: BackgroundJob) => Promise<void>;

export type ExpiredLeaseRecoveryHook = (
  transaction: Transaction,
  job: BackgroundJob,
  terminal: boolean,
) => Promise<void>;

export class BackgroundJobError extends Error {}

export class BackgroundJobClaimLostError extends BackgroundJobError {}

export class BackgroundJobExecutionError extends BackgroundJobError {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.code = normalizeErrorCode(code);
    this.retryable = retryable;
  }
}

function requirePositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new BackgroundJobError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function normalizeWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(normalized)) {
    throw new BackgroundJobError('Worker id contains unsupported characters or is too long.');
  }
  return normalized;
}

function normalizeIdempotencyKey(key: string): string {
  const normalized = key.trim();
  if (normalized.length < 1 || normalized.length > 250) {
    throw new BackgroundJobError('Idempotency key must contain between 1 and 250 characters.');
  }
  return normalized;
}

function normalizeErrorCode(code: string): string {
  const normalized = code
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/gu, '_')
    .slice(0, 80);
  return normalized || 'job_execution_failed';
}

function safeErrorMessage(message: string): string {
  const normalized = Array.from(message, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  })
    .join('')
    .trim();
  return (normalized || 'The background job failed.').slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export function toStructuredJobError(error: unknown): StructuredJobError {
  if (error instanceof BackgroundJobExecutionError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      retryable: error.retryable,
    };
  }
  return {
    code: 'job_execution_failed',
    message: 'The background job failed.',
    retryable: true,
  };
}

function runtimeOptions(options: BackgroundJobRuntimeOptions = {}) {
  const leaseMs = requirePositiveInteger(
    options.leaseMs ?? DEFAULT_LEASE_MS,
    'leaseMs',
    86_400_000,
  );
  const backoffBaseMs = requirePositiveInteger(
    options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    'backoffBaseMs',
    3_600_000,
  );
  const backoffMaxMs = requirePositiveInteger(
    options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    'backoffMaxMs',
    86_400_000,
  );
  if (backoffMaxMs < backoffBaseMs) {
    throw new BackgroundJobError('backoffMaxMs must be greater than or equal to backoffBaseMs.');
  }
  return { backoffBaseMs, backoffMaxMs, leaseMs };
}

export function calculateRetryDelayMs(
  attemptNumber: number,
  options: BackgroundJobRuntimeOptions = {},
): number {
  const { backoffBaseMs, backoffMaxMs } = runtimeOptions(options);
  const exponent = Math.max(0, attemptNumber - 1);
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** exponent);
}

export async function createDurableBackgroundJob(
  transaction: Transaction,
  input: DurableBackgroundJobInput,
): Promise<BackgroundJob> {
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const maxAttempts = requirePositiveInteger(
    input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    'maxAttempts',
    MAX_ALLOWED_ATTEMPTS,
  );
  const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "background_jobs" (
      "id", "kind", "workspaceId", "requestedByUserId", "domainJobId",
      "idempotencyKey", "payload", "maxAttempts", "availableAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(), ${input.kind}::"BackgroundJobKind", ${input.workspaceId}::uuid,
      ${input.requestedByUserId}::uuid, ${input.domainJobId}::uuid, ${idempotencyKey},
      ${JSON.stringify(input.payload ?? {})}::jsonb, ${maxAttempts},
      ${input.availableAt ?? new Date()}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("idempotencyKey") DO UPDATE
      SET "updatedAt" = "background_jobs"."updatedAt"
    RETURNING "id"
  `);
  const insertedId = inserted[0]?.id;
  if (!insertedId) throw new BackgroundJobError('The durable background job was not created.');
  const job = await transaction.backgroundJob.findUniqueOrThrow({ where: { id: insertedId } });

  if (
    job.kind !== input.kind ||
    job.domainJobId !== input.domainJobId ||
    job.workspaceId !== input.workspaceId ||
    job.requestedByUserId !== input.requestedByUserId
  ) {
    throw new BackgroundJobError('The idempotency key is already bound to another job.');
  }
  return job;
}

async function claimNextWithQuery(
  prisma: PrismaClient,
  workerId: string,
  leaseMs: number,
  jobId?: string,
): Promise<BackgroundJob | null> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  const rows = jobId
    ? await prisma.$queryRaw<BackgroundJob[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "id"
          FROM "background_jobs"
          WHERE "id" = ${jobId}::uuid
            AND "status" = 'QUEUED'::"BackgroundJobStatus"
            AND "availableAt" <= CURRENT_TIMESTAMP
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "background_jobs" AS job
        SET "status" = 'PROCESSING'::"BackgroundJobStatus",
            "workerId" = ${normalizedWorkerId},
            "lockedAt" = CURRENT_TIMESTAMP,
            "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'),
            "firstStartedAt" = COALESCE(job."firstStartedAt", CURRENT_TIMESTAMP),
            "attemptCount" = job."attemptCount" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job.*
      `)
    : await prisma.$queryRaw<BackgroundJob[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "id"
          FROM "background_jobs"
          WHERE "status" = 'QUEUED'::"BackgroundJobStatus"
            AND "availableAt" <= CURRENT_TIMESTAMP
          ORDER BY "availableAt" ASC, "createdAt" ASC, "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "background_jobs" AS job
        SET "status" = 'PROCESSING'::"BackgroundJobStatus",
            "workerId" = ${normalizedWorkerId},
            "lockedAt" = CURRENT_TIMESTAMP,
            "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'),
            "firstStartedAt" = COALESCE(job."firstStartedAt", CURRENT_TIMESTAMP),
            "attemptCount" = job."attemptCount" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job.*
      `);
  return rows[0] ?? null;
}

export async function claimNextBackgroundJob(
  prisma: PrismaClient,
  workerId: string,
  options: BackgroundJobRuntimeOptions = {},
): Promise<BackgroundJob | null> {
  return claimNextWithQuery(prisma, workerId, runtimeOptions(options).leaseMs);
}

export async function claimBackgroundJobById(
  prisma: PrismaClient,
  jobId: string,
  workerId: string,
  options: BackgroundJobRuntimeOptions = {},
): Promise<BackgroundJob | null> {
  return claimNextWithQuery(prisma, workerId, runtimeOptions(options).leaseMs, jobId);
}

export async function extendBackgroundJobLease(
  prisma: PrismaClient,
  jobId: string,
  workerId: string,
  options: BackgroundJobRuntimeOptions = {},
): Promise<boolean> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  const { leaseMs } = runtimeOptions(options);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "background_jobs"
    SET "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'),
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${jobId}::uuid
      AND "status" = 'PROCESSING'::"BackgroundJobStatus"
      AND "workerId" = ${normalizedWorkerId}
      AND "leaseExpiresAt" > CURRENT_TIMESTAMP
    RETURNING "id"
  `);
  return rows.length === 1;
}

function executionDurationMs(startedAt: Date, finishedAt: Date): bigint {
  return BigInt(Math.max(0, finishedAt.getTime() - startedAt.getTime()));
}

async function getOwnedProcessingJob(
  transaction: Transaction,
  jobId: string,
  workerId: string,
): Promise<BackgroundJob> {
  const job = await transaction.backgroundJob.findUnique({ where: { id: jobId } });
  if (
    !job ||
    job.status !== BackgroundJobStatus.PROCESSING ||
    job.workerId !== workerId ||
    !job.lockedAt ||
    !job.firstStartedAt
  ) {
    throw new BackgroundJobClaimLostError('The background job lease is no longer owned.');
  }
  return job;
}

export async function completeBackgroundJob(
  prisma: PrismaClient,
  jobId: string,
  workerId: string,
): Promise<void> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  await prisma.$transaction(async (transaction) => {
    const job = await getOwnedProcessingJob(transaction, jobId, normalizedWorkerId);
    const finishedAt = new Date();
    const durationMs = executionDurationMs(job.lockedAt!, finishedAt);
    await transaction.backgroundJobAttempt.create({
      data: {
        attemptNumber: job.attemptCount,
        durationMs,
        finishedAt,
        jobId: job.id,
        outcome: BackgroundJobAttemptOutcome.SUCCEEDED,
        startedAt: job.lockedAt!,
        workerId: normalizedWorkerId,
      },
    });
    await transaction.backgroundJob.update({
      where: { id: job.id },
      data: {
        completedAt: finishedAt,
        durationMs: executionDurationMs(job.firstStartedAt!, finishedAt),
        lastError: Prisma.DbNull,
        leaseExpiresAt: null,
        lockedAt: null,
        status: BackgroundJobStatus.SUCCEEDED,
        workerId: null,
      },
    });
  });
}

export async function failBackgroundJobAttempt(
  prisma: PrismaClient,
  jobId: string,
  workerId: string,
  error: StructuredJobError,
  options: BackgroundJobRuntimeOptions = {},
): Promise<BackgroundJobStatus> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  return prisma.$transaction(async (transaction) => {
    const job = await getOwnedProcessingJob(transaction, jobId, normalizedWorkerId);
    const finishedAt = new Date();
    const durationMs = executionDurationMs(job.lockedAt!, finishedAt);
    const safeError: StructuredJobError = {
      code: normalizeErrorCode(error.code),
      message: safeErrorMessage(error.message),
      retryable: error.retryable,
    };
    const retry = safeError.retryable && job.attemptCount < job.maxAttempts;
    await transaction.backgroundJobAttempt.create({
      data: {
        attemptNumber: job.attemptCount,
        durationMs,
        error: safeError,
        finishedAt,
        jobId: job.id,
        outcome: retry
          ? BackgroundJobAttemptOutcome.RETRY_SCHEDULED
          : BackgroundJobAttemptOutcome.FAILED,
        startedAt: job.lockedAt!,
        workerId: normalizedWorkerId,
      },
    });
    if (retry) {
      await transaction.backgroundJob.update({
        where: { id: job.id },
        data: {
          availableAt: new Date(
            finishedAt.getTime() + calculateRetryDelayMs(job.attemptCount, options),
          ),
          lastError: safeError,
          leaseExpiresAt: null,
          lockedAt: null,
          status: BackgroundJobStatus.QUEUED,
          workerId: null,
        },
      });
      return BackgroundJobStatus.QUEUED;
    }
    await transaction.backgroundJob.update({
      where: { id: job.id },
      data: {
        completedAt: finishedAt,
        durationMs: executionDurationMs(job.firstStartedAt!, finishedAt),
        lastError: safeError,
        leaseExpiresAt: null,
        lockedAt: null,
        status: BackgroundJobStatus.FAILED,
        workerId: null,
      },
    });
    return BackgroundJobStatus.FAILED;
  });
}

export async function executeClaimedBackgroundJob(
  prisma: PrismaClient,
  job: BackgroundJob,
  handler: BackgroundJobHandler,
  options: BackgroundJobRuntimeOptions = {},
): Promise<BackgroundJobStatus> {
  if (!job.workerId) {
    throw new BackgroundJobClaimLostError('The claimed job has no worker id.');
  }
  const workerId = job.workerId;
  const { leaseMs } = runtimeOptions(options);
  const heartbeatMs = Math.max(250, Math.floor(leaseMs / 3));
  let heartbeatLost = false;
  const heartbeat = setInterval(() => {
    void extendBackgroundJobLease(prisma, job.id, workerId, options)
      .then((extended) => {
        if (!extended) heartbeatLost = true;
      })
      .catch(() => {
        heartbeatLost = true;
      });
  }, heartbeatMs);
  heartbeat.unref();

  try {
    await handler(job);
    if (heartbeatLost) {
      throw new BackgroundJobClaimLostError('The background job lease was lost during execution.');
    }
    await completeBackgroundJob(prisma, job.id, workerId);
    return BackgroundJobStatus.SUCCEEDED;
  } catch (error) {
    if (error instanceof BackgroundJobClaimLostError) throw error;
    return failBackgroundJobAttempt(prisma, job.id, workerId, toStructuredJobError(error), options);
  } finally {
    clearInterval(heartbeat);
  }
}

export async function recoverExpiredBackgroundJobs(
  prisma: PrismaClient,
  limit = 100,
  hook?: ExpiredLeaseRecoveryHook,
  options: BackgroundJobRuntimeOptions = {},
): Promise<{ failed: number; recovered: number }> {
  requirePositiveInteger(limit, 'limit', 1_000);
  return prisma.$transaction(async (transaction) => {
    const expired = await transaction.$queryRaw<BackgroundJob[]>(Prisma.sql`
      SELECT *
      FROM "background_jobs"
      WHERE "status" = 'PROCESSING'::"BackgroundJobStatus"
        AND "leaseExpiresAt" <= CURRENT_TIMESTAMP
      ORDER BY "leaseExpiresAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `);
    let failed = 0;
    let recovered = 0;
    for (const job of expired) {
      if (!job.lockedAt || !job.firstStartedAt) continue;
      const finishedAt = new Date();
      const terminal = job.attemptCount >= job.maxAttempts;
      const error: StructuredJobError = {
        code: 'lease_expired',
        message: 'The worker lease expired before completion.',
        retryable: !terminal,
      };
      await hook?.(transaction, job, terminal);
      await transaction.backgroundJobAttempt.create({
        data: {
          attemptNumber: job.attemptCount,
          durationMs: executionDurationMs(job.lockedAt, finishedAt),
          error,
          finishedAt,
          jobId: job.id,
          outcome: terminal
            ? BackgroundJobAttemptOutcome.FAILED
            : BackgroundJobAttemptOutcome.LEASE_EXPIRED,
          startedAt: job.lockedAt,
          workerId: job.workerId ?? 'expired-worker',
        },
      });
      if (terminal) {
        await transaction.backgroundJob.update({
          where: { id: job.id },
          data: {
            completedAt: finishedAt,
            durationMs: executionDurationMs(job.firstStartedAt, finishedAt),
            lastError: error,
            leaseExpiresAt: null,
            lockedAt: null,
            status: BackgroundJobStatus.FAILED,
            workerId: null,
          },
        });
        failed += 1;
      } else {
        await transaction.backgroundJob.update({
          where: { id: job.id },
          data: {
            availableAt: new Date(
              finishedAt.getTime() + calculateRetryDelayMs(job.attemptCount, options),
            ),
            lastError: error,
            leaseExpiresAt: null,
            lockedAt: null,
            status: BackgroundJobStatus.QUEUED,
            workerId: null,
          },
        });
        recovered += 1;
      }
    }
    return { failed, recovered };
  });
}

export async function findDurableJobByDomainReference(
  prisma: PrismaClient,
  kind: BackgroundJobKind,
  domainJobId: string,
): Promise<BackgroundJob | null> {
  return prisma.backgroundJob.findUnique({
    where: { kind_domainJobId: { domainJobId, kind } },
  });
}

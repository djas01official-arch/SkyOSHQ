import {
  claimNextBackgroundJob,
  executeClaimedBackgroundJob,
  inspectBackgroundJobQueue,
  recoverExpiredBackgroundJobs,
  type BackgroundJobHandler,
  type BackgroundJobRuntimeOptions,
  type ExpiredLeaseRecoveryHook,
} from '../../database/background-jobs/runtime';
import type { PrismaClient } from '../../database/generated/client/client';
import { createSkyOsLogger } from '../observability/logger';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_OBSERVABILITY_INTERVAL_MS = 60_000;
const STUCK_QUEUED_AGE_MS = 5 * 60_000;
const logger = createSkyOsLogger('worker');

export type BackgroundWorkerOptions = Readonly<{
  prisma: PrismaClient;
  workerId: string;
  handler: BackgroundJobHandler;
  signal: AbortSignal;
  runtime?: BackgroundJobRuntimeOptions;
  pollIntervalMs?: number;
  recoveryIntervalMs?: number;
  observabilityIntervalMs?: number;
  recoveryHook?: ExpiredLeaseRecoveryHook;
}>;

function positiveInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 3_600_000) {
    throw new Error(`${name} must be an integer between 10 and 3600000 milliseconds.`);
  }
  return value;
}

async function waitForNextPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runBackgroundWorker(options: BackgroundWorkerOptions): Promise<void> {
  const pollIntervalMs = positiveInterval(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    'pollIntervalMs',
  );
  const recoveryIntervalMs = positiveInterval(
    options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS,
    'recoveryIntervalMs',
  );
  const observabilityIntervalMs = positiveInterval(
    options.observabilityIntervalMs ?? DEFAULT_OBSERVABILITY_INTERVAL_MS,
    'observabilityIntervalMs',
  );
  let lastRecoveryAt = 0;
  let lastObservabilityAt = 0;

  while (!options.signal.aborted) {
    const now = Date.now();
    if (now - lastRecoveryAt >= recoveryIntervalMs) {
      await recoverExpiredBackgroundJobs(
        options.prisma,
        100,
        options.recoveryHook,
        options.runtime,
      );
      lastRecoveryAt = now;
    }
    if (now - lastObservabilityAt >= observabilityIntervalMs) {
      const snapshot = await inspectBackgroundJobQueue(options.prisma);
      const fields = {
        operation: 'background_job.backlog_snapshot',
        active_count: snapshot.activeCount,
        oldest_queued_age_ms: snapshot.oldestQueuedAgeMs,
        queued_count: snapshot.queuedCount,
        stuck_ai_count: snapshot.stuckAiCount,
        stuck_knowledge_count: snapshot.stuckKnowledgeCount,
        status:
          snapshot.oldestQueuedAgeMs >= STUCK_QUEUED_AGE_MS ||
          snapshot.stuckAiCount > 0 ||
          snapshot.stuckKnowledgeCount > 0
            ? 'DEGRADED'
            : 'HEALTHY',
      } as const;
      if (fields.status === 'DEGRADED') {
        logger.warning({ ...fields, error_category: 'dependency', error_code: 'work_stuck' });
      } else {
        logger.info(fields);
      }
      lastObservabilityAt = now;
    }
    const job = await claimNextBackgroundJob(options.prisma, options.workerId, options.runtime);
    if (!job) {
      await waitForNextPoll(options.signal, pollIntervalMs);
      continue;
    }
    await executeClaimedBackgroundJob(options.prisma, job, options.handler, options.runtime);
  }
}

import {
  claimNextBackgroundJob,
  executeClaimedBackgroundJob,
  recoverExpiredBackgroundJobs,
  type BackgroundJobHandler,
  type BackgroundJobRuntimeOptions,
  type ExpiredLeaseRecoveryHook,
} from '../../database/background-jobs/runtime';
import type { PrismaClient } from '../../database/generated/client/client';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;

export type BackgroundWorkerOptions = Readonly<{
  prisma: PrismaClient;
  workerId: string;
  handler: BackgroundJobHandler;
  signal: AbortSignal;
  runtime?: BackgroundJobRuntimeOptions;
  pollIntervalMs?: number;
  recoveryIntervalMs?: number;
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
  let lastRecoveryAt = 0;

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
    const job = await claimNextBackgroundJob(options.prisma, options.workerId, options.runtime);
    if (!job) {
      await waitForNextPoll(options.signal, pollIntervalMs);
      continue;
    }
    await executeClaimedBackgroundJob(options.prisma, job, options.handler, options.runtime);
  }
}

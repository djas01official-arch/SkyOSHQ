import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import type { Pool } from 'pg';

import { createSkyOsLogger } from '../../services/observability/logger';

const diagnosticsLogger = createSkyOsLogger('web');

const SLOW_OPERATION_THRESHOLD_MS = 250;
const SLOW_LOG_THROTTLE_MS = 5_000;
const POOL_SAMPLE_INTERVAL_MS = 5_000;

const lastSlowLogByOperation = new Map<string, number>();
const instrumentedPools = new WeakSet<Pool>();

function diagnosticsEnabled(): boolean {
  return process.env.TASK9_RUNTIME_DIAGNOSTICS === '1';
}

function shouldLogSlowOperation(operation: string, now: number): boolean {
  const previous = lastSlowLogByOperation.get(operation) ?? 0;

  if (now - previous < SLOW_LOG_THROTTLE_MS) {
    return false;
  }

  lastSlowLogByOperation.set(operation, now);

  return true;
}

export async function task9Timed<T>(operation: string, work: () => Promise<T>): Promise<T> {
  if (!diagnosticsEnabled()) {
    return work();
  }

  const started = performance.now();

  try {
    return await work();
  } finally {
    const durationMs = Math.max(0, performance.now() - started);

    if (
      durationMs >= SLOW_OPERATION_THRESHOLD_MS &&
      shouldLogSlowOperation(operation, Date.now())
    ) {
      diagnosticsLogger.warning({
        operation,
        status: 'SLOW',
        duration_ms: durationMs,
      });
    }
  }
}

export function attachTask9PoolDiagnostics(pool: Pool): void {
  if (!diagnosticsEnabled() || instrumentedPools.has(pool)) {
    return;
  }

  instrumentedPools.add(pool);

  const eventLoopDelay = monitorEventLoopDelay({
    resolution: 20,
  });

  eventLoopDelay.enable();

  const timer = setInterval(() => {
    const totalCount = Math.max(0, pool.totalCount);

    const idleCount = Math.max(0, pool.idleCount);

    const waitingCount = Math.max(0, pool.waitingCount);

    const activeCount = Math.max(0, totalCount - idleCount);

    const eventLoopP95Ms = Math.max(0, Number(eventLoopDelay.percentile(95)) / 1_000_000);

    diagnosticsLogger.info({
      operation: 'task9.runtime_snapshot',
      status: waitingCount > 0 ? 'WAITING' : 'OK',
      batch_size: totalCount,
      active_count: activeCount,
      queued_count: waitingCount,
      duration_ms: eventLoopP95Ms,
    });

    eventLoopDelay.reset();
  }, POOL_SAMPLE_INTERVAL_MS);

  timer.unref();
}

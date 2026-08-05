import { hostname } from 'node:os';

function integerEnvironmentValue(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function getBackgroundWorkerConfig() {
  const configuredWorkerId = process.env.BACKGROUND_WORKER_ID?.trim();
  const workerId = configuredWorkerId || `${hostname()}-${process.pid}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(workerId)) {
    throw new Error('BACKGROUND_WORKER_ID contains unsupported characters or is too long.');
  }
  return {
    pollIntervalMs: integerEnvironmentValue('BACKGROUND_JOB_POLL_MS', 1_000, 10, 3_600_000),
    recoveryIntervalMs: integerEnvironmentValue(
      'BACKGROUND_JOB_RECOVERY_MS',
      30_000,
      10,
      3_600_000,
    ),
    runtime: {
      backoffBaseMs: integerEnvironmentValue('BACKGROUND_JOB_BACKOFF_BASE_MS', 1_000, 1, 3_600_000),
      backoffMaxMs: integerEnvironmentValue('BACKGROUND_JOB_BACKOFF_MAX_MS', 60_000, 1, 86_400_000),
      leaseMs: integerEnvironmentValue('BACKGROUND_JOB_LEASE_MS', 60_000, 1, 86_400_000),
    },
    workerId,
  } as const;
}

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import { attachTask9PoolDiagnostics } from './task9-runtime-diagnostics';

const DEFAULT_DATABASE_POOL_MAX = 3;
const DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS = 3_000;
const DEFAULT_DATABASE_IDLE_TIMEOUT_MS = 30_000;

const DATABASE_POOL_MAX_LIMIT = 20;
const DATABASE_TIMEOUT_MAX_MS = 120_000;

export type DatabasePoolConfiguration = Readonly<{
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

function integerEnvironmentValue(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer.`);

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }

  return value;
}

export function getDatabaseConnectionTimeoutMillis(environment: Environment = process.env): number {
  return integerEnvironmentValue(
    environment,
    'DATABASE_CONNECTION_TIMEOUT_MS',
    DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS,
    1,
    DATABASE_TIMEOUT_MAX_MS,
  );
}

export function getDatabasePoolConfiguration(
  environment: Environment = process.env,
): DatabasePoolConfiguration {
  return {
    max: integerEnvironmentValue(
      environment,
      'DATABASE_POOL_MAX',
      DEFAULT_DATABASE_POOL_MAX,
      1,
      DATABASE_POOL_MAX_LIMIT,
    ),
    connectionTimeoutMillis: getDatabaseConnectionTimeoutMillis(environment),
    idleTimeoutMillis: integerEnvironmentValue(
      environment,
      'DATABASE_IDLE_TIMEOUT_MS',
      DEFAULT_DATABASE_IDLE_TIMEOUT_MS,
      1,
      DATABASE_TIMEOUT_MAX_MS,
    ),
  };
}

export function createPrismaPgAdapter(
  connectionString: string,
  environment: Environment = process.env,
): PrismaPg {
  if (!connectionString.trim()) {
    throw new Error('DATABASE_URL is required to create a database adapter.');
  }

  const configuration = getDatabasePoolConfiguration(environment);

  const pool = new Pool({
    connectionString,
    ...configuration,
  });

  attachTask9PoolDiagnostics(pool);

  return new PrismaPg(pool);
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDatabaseConnectionTimeoutMillis,
  getDatabasePoolConfiguration,
} from '../operations/database-pool';

test('database pool defaults are finite and conservative', () => {
  assert.deepEqual(getDatabasePoolConfiguration({}), {
    max: 3,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
  });
});

test('database pool configuration accepts reviewed overrides', () => {
  assert.deepEqual(
    getDatabasePoolConfiguration({
      DATABASE_POOL_MAX: '5',
      DATABASE_CONNECTION_TIMEOUT_MS: '4000',
      DATABASE_IDLE_TIMEOUT_MS: '45000',
    }),
    {
      max: 5,
      connectionTimeoutMillis: 4_000,
      idleTimeoutMillis: 45_000,
    },
  );
});

test('database pool configuration rejects unbounded or malformed values', () => {
  assert.throws(() => getDatabasePoolConfiguration({ DATABASE_POOL_MAX: '0' }));
  assert.throws(() => getDatabasePoolConfiguration({ DATABASE_POOL_MAX: '21' }));
  assert.throws(() => getDatabasePoolConfiguration({ DATABASE_POOL_MAX: '3.5' }));
  assert.throws(() =>
    getDatabasePoolConfiguration({ DATABASE_CONNECTION_TIMEOUT_MS: '0' }),
  );
  assert.throws(() => getDatabasePoolConfiguration({ DATABASE_IDLE_TIMEOUT_MS: '-1' }));
});

test('connection timeout helper uses the same finite validation contract', () => {
  assert.equal(getDatabaseConnectionTimeoutMillis({}), 3_000);
  assert.equal(
    getDatabaseConnectionTimeoutMillis({ DATABASE_CONNECTION_TIMEOUT_MS: '7500' }),
    7_500,
  );
  assert.throws(() =>
    getDatabaseConnectionTimeoutMillis({ DATABASE_CONNECTION_TIMEOUT_MS: '120001' }),
  );
});

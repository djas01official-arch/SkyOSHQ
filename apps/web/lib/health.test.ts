import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveHealthResponse, readinessHealthResponse, type DatabaseReadinessCheck } from './health';

async function body(response: Response): Promise<unknown> {
  return response.json();
}

test('liveness is deterministic and has no dependency check boundary', async () => {
  const response = liveHealthResponse();

  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { status: 'ok' });
});

test('readiness returns success after one successful database check', async () => {
  let calls = 0;
  const response = await readinessHealthResponse(async () => {
    calls += 1;
  });

  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { status: 'ok' });
});

test('readiness returns a generic unavailable response when the database check fails', async () => {
  const response = await readinessHealthResponse(async () => {
    throw new Error('postgresql://sensitive-user:sensitive-password@private-host/skyos');
  });

  assert.equal(response.status, 503);
  const rawBody = await response.clone().text();
  assert.deepEqual(await body(response), { status: 'unavailable' });
  assert.equal(rawBody.includes('private-host'), false);
});

test('readiness response is bounded when a dependency does not resolve', async () => {
  const neverResolves: DatabaseReadinessCheck = () => new Promise<void>(() => {});
  const startedAt = Date.now();
  const response = await readinessHealthResponse(neverResolves, 10);

  assert.equal(response.status, 503);
  assert.ok(Date.now() - startedAt < 500);
});

test('readiness rejects an invalid timeout rather than using an unbounded fallback', async () => {
  await assert.rejects(() => readinessHealthResponse(async () => {}, 0));
});

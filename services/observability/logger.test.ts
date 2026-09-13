import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyErrorCategory,
  createSkyOsLogger,
  safeErrorTelemetry,
  traceIdFromHeaders,
} from './logger';

test('structured logger emits bounded fields and omits undefined values', () => {
  const lines: string[] = [];
  const logger = createSkyOsLogger('worker', {
    environment: 'nonprod',
    now: () => new Date('2026-09-13T00:00:00.000Z'),
    writer: (line) => lines.push(line),
  });

  const entry = logger.info({
    operation: 'background_job.completed',
    background_job_id: 'job-123',
    duration_ms: 42,
    provider: undefined,
    status: 'SUCCEEDED',
  });

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), entry);
  assert.equal(entry.environment, 'nonprod');
  assert.equal(entry.service, 'worker');
  assert.equal(entry.severity, 'INFO');
  assert.equal('provider' in entry, false);
});

test('safe error telemetry never serializes error messages or arbitrary metadata', () => {
  const secret = 'secret-value-that-must-not-appear';
  const telemetry = safeErrorTelemetry({
    code: 'provider_rate_limited',
    message: `Authorization: Bearer ${secret}`,
    request: { apiKey: secret },
    retryable: true,
  });

  assert.deepEqual(telemetry, {
    error_category: 'rate_limit',
    error_code: 'provider_rate_limited',
    retry: true,
  });
  assert.equal(JSON.stringify(telemetry).includes(secret), false);
});

test('logger runtime allowlist drops fields introduced by an untyped caller', () => {
  const logger = createSkyOsLogger('web', { writer: () => undefined });
  const entry = logger.info({
    operation: 'request.completed',
    authorization: 'Bearer secret-value',
    cookie: 'session=secret-value',
  } as never);

  assert.equal(JSON.stringify(entry).includes('secret-value'), false);
  assert.equal('authorization' in entry, false);
  assert.equal('cookie' in entry, false);
});

test('error taxonomy is stable for alert labels', () => {
  assert.equal(classifyErrorCategory('workspace_forbidden'), 'authorization');
  assert.equal(classifyErrorCategory('provider_timeout', true), 'timeout');
  assert.equal(classifyErrorCategory('provider_unavailable', true), 'provider_transient');
  assert.equal(classifyErrorCategory('provider_output_invalid'), 'provider_permanent');
  assert.equal(classifyErrorCategory('database_connection_failed'), 'database');
});

test('trace context accepts only a valid 128-bit trace id', () => {
  assert.equal(
    traceIdFromHeaders(
      new Headers({
        'x-cloud-trace-context': '0123456789abcdef0123456789abcdef/123;o=1',
      }),
    ),
    '0123456789abcdef0123456789abcdef',
  );
  assert.equal(traceIdFromHeaders(new Headers({ traceparent: 'invalid' })), undefined);
});

test('durable correlation survives service boundaries without content fields', () => {
  const lines: string[] = [];
  const orchestrationId = '72ca8e97-63fb-4270-a8c7-6787135147ac';
  const writer = (line: string) => lines.push(line);
  createSkyOsLogger('web', { writer }).info({
    operation: 'ai.orchestration_queued',
    orchestration_id: orchestrationId,
    status: 'PENDING',
  });
  createSkyOsLogger('worker', { writer }).info({
    operation: 'background_job.completed',
    domain_job_id: orchestrationId,
    status: 'SUCCEEDED',
  });

  const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(entries[0]?.orchestration_id, entries[1]?.domain_job_id);
  assert.equal(lines.join('\n').includes('prompt'), false);
  assert.equal(lines.join('\n').includes('content'), false);
});

test('logger rejects unbounded operation names', () => {
  const logger = createSkyOsLogger('web', { writer: () => undefined });
  assert.throws(
    () => logger.info({ operation: 'Authorization: Bearer should-not-be-an-operation' }),
    /bounded lowercase identifier/u,
  );
});

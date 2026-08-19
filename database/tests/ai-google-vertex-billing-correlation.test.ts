import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  createGoogleVertexBillingCorrelation,
  parseGoogleVertexBillingCorrelation,
} from '../ai/ai-google-vertex-billing-correlation';

const GOOGLE_VERTEX_LABEL_KEY = /^[a-z][a-z0-9_-]{0,62}$/u;
const GOOGLE_VERTEX_LABEL_VALUE = /^[a-z0-9_-]{1,63}$/u;

test('creates one deterministic, lossless, Google-label-safe correlation from only the authoritative AiRun UUID', () => {
  const aiRunId = 'a16b8d88-c8b8-4a4f-8c7f-a16311fe1e5d';
  const first = createGoogleVertexBillingCorrelation(aiRunId);
  const second = createGoogleVertexBillingCorrelation(aiRunId);

  assert.deepEqual(first, second);
  assert.equal(first.labelKey, 'skyos_run');
  assert.equal(first.labelValue, `run-${aiRunId}`);
  assert.match(first.labelKey, GOOGLE_VERTEX_LABEL_KEY);
  assert.match(first.labelValue, GOOGLE_VERTEX_LABEL_VALUE);
  assert.ok(first.labelKey.length <= 63);
  assert.ok(first.labelValue.length <= 63);
  assert.equal(parseGoogleVertexBillingCorrelation(first.labelValue), aiRunId);
});

test('keeps distinct AiRun identities distinct without using provider request IDs, timestamps, or business context', () => {
  const firstRunId = 'a16b8d88-c8b8-4a4f-8c7f-a16311fe1e5d';
  const secondRunId = 'b26b8d88-c8b8-4a4f-8c7f-a16311fe1e5d';
  const first = createGoogleVertexBillingCorrelation(firstRunId);
  const second = createGoogleVertexBillingCorrelation(secondRunId);

  assert.notEqual(first.labelValue, second.labelValue);
  assert.equal(parseGoogleVertexBillingCorrelation(first.labelValue), firstRunId);
  assert.equal(parseGoogleVertexBillingCorrelation(second.labelValue), secondRunId);
  assert.equal(first.labelValue.includes('interaction_'), false);
  assert.equal(first.labelValue.includes('req_'), false);
});

test('rejects non-canonical identities and refuses malformed or non-correlation label values', () => {
  for (const value of [
    '',
    'A16B8D88-C8B8-4A4F-8C7F-A16311FE1E5D',
    'req_provider_identity',
    'user@example.com',
    'a16b8d88c8b84a4f8c7fa16311fe1e5d',
  ]) {
    assert.throws(() => createGoogleVertexBillingCorrelation(value));
  }
  for (const value of [
    '',
    'run-user@example.com',
    'request-123',
    'run-a16b8d88-c8b8-4a4f-8c7f-a16311fe1e5d!',
  ]) {
    assert.equal(parseGoogleVertexBillingCorrelation(value), undefined);
  }
});

test('correlation creation is pure and carries no user, workspace, conversation, prompt, or financial state', () => {
  const correlation = createGoogleVertexBillingCorrelation(randomUUID());
  assert.deepEqual(Object.keys(correlation).sort(), ['labelKey', 'labelValue']);
  assert.equal(Object.isFrozen(correlation), true);
});

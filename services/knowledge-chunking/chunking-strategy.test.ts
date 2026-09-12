import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KnowledgeChunkLimitExceededError,
  MAX_KNOWLEDGE_CHUNKS_PER_SOURCE,
  paragraphWindowStrategyV1,
} from './chunking-strategy';

test('chunking is deterministic, ordered, and content-addressed', () => {
  const source = `${'Flight planning reference. '.repeat(40)}\n\n${'Weather minima. '.repeat(50)}`;
  const first = paragraphWindowStrategyV1.chunk(source);
  const second = paragraphWindowStrategyV1.chunk(source);

  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  assert.deepEqual(
    first.map((chunk) => chunk.ordinal),
    first.map((_, ordinal) => ordinal),
  );
  assert.ok(first.every((chunk) => chunk.text.length <= 1_000));
  assert.ok(first.every((chunk) => /^[0-9a-f]{64}$/u.test(chunk.sha256)));
});

test('chunking fails closed before creating an unbounded number of chunks', () => {
  const oversizedSource = 'x'.repeat(MAX_KNOWLEDGE_CHUNKS_PER_SOURCE * 1_000 + 1);
  assert.throws(
    () => paragraphWindowStrategyV1.chunk(oversizedSource),
    KnowledgeChunkLimitExceededError,
  );
});

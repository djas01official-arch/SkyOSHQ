import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  calculateLanguageModelCostUsd,
  estimateLanguageModelCostUsd,
  normalizeLanguageModelUsage,
  OPENAI_GPT_5_6_TERRA_PRICING,
} from './language-model-pricing';

test('calculates the configured GPT-5.6 Terra cost with fixed precision', () => {
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', {
      inputTokens: 3_000,
      outputTokens: 600,
      totalTokens: 3_600,
    }),
    '0.016500000000',
  );
  assert.equal(
    calculateLanguageModelCostUsd(
      { cachedInputTokens: 1, inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      OPENAI_GPT_5_6_TERRA_PRICING,
    ),
    '0.000000250000',
  );
});

test('prices cached input separately from uncached input and output', () => {
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', {
      cacheWriteInputTokens: 200,
      cachedInputTokens: 100,
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_100,
    }),
    '0.003900000000',
  );
});

test('applies long-context pricing only above the 272K input-token threshold', () => {
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', {
      inputTokens: 271_999,
      outputTokens: 1_000,
    }),
    '0.694997500000',
  );
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', {
      inputTokens: 272_000,
      outputTokens: 1_000,
    }),
    '0.695000000000',
  );
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', {
      inputTokens: 272_001,
      outputTokens: 1_000,
    }),
    '1.382505000000',
  );
});

test('leaves long-context cached-read and cache-write costs unknown', () => {
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', {
      cachedInputTokens: 1,
      inputTokens: 272_001,
      outputTokens: 1_000,
    }),
    undefined,
  );
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', {
      cacheWriteInputTokens: 1,
      inputTokens: 272_001,
      outputTokens: 1_000,
    }),
    undefined,
  );
});

test('missing usage and unsupported pricing remain unknown', () => {
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', { inputTokens: 100 }),
    undefined,
  );
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'unknown-model', {
      inputTokens: 100,
      outputTokens: 20,
    }),
    undefined,
  );
});

test('normalization derives consistent totals and rejects invalid cached counts', () => {
  assert.deepEqual(
    normalizeLanguageModelUsage({
      cacheWriteInputTokens: 10,
      cachedInputTokens: 25,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 999,
    }),
    {
      cacheWriteInputTokens: 10,
      cachedInputTokens: 25,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
  );
  assert.deepEqual(
    normalizeLanguageModelUsage({
      cachedInputTokens: 101,
      inputTokens: 100,
      outputTokens: 20,
    }),
    {
      cacheWriteInputTokens: undefined,
      cachedInputTokens: undefined,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
  );
});

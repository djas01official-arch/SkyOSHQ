import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANTHROPIC_CLAUDE_SONNET_4_6_PRICING,
  ANTHROPIC_CLAUDE_SONNET_5_PROMOTIONAL_PRICING,
  ANTHROPIC_CLAUDE_SONNET_5_STANDARD_PRICING,
  calculateLanguageModelCostUsd,
  estimateLanguageModelCostUsd,
  normalizeLanguageModelUsage,
  OPENAI_GPT_5_6_TERRA_PRICING,
} from './language-model-pricing';

const VERIFIED_AT = new Date('2026-08-13T12:00:00.000Z');

test('calculates the configured GPT-5.6 Terra cost with fixed precision', () => {
  assert.equal(
    estimateLanguageModelCostUsd(
      'openai',
      'gpt-5.6-terra',
      {
        inputTokens: 3_000,
        outputTokens: 600,
        totalTokens: 3_600,
      },
      VERIFIED_AT,
    ),
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
    estimateLanguageModelCostUsd(
      'openai',
      'gpt-5.6-terra',
      {
        cacheWriteInputTokens: 200,
        cachedInputTokens: 100,
        inputTokens: 1_000,
        outputTokens: 100,
        totalTokens: 1_100,
      },
      VERIFIED_AT,
    ),
    '0.003900000000',
  );
});

test('calculates Claude Sonnet 4.6 standard and TTL-aware cache pricing', () => {
  assert.equal(
    estimateLanguageModelCostUsd(
      'anthropic',
      'claude-sonnet-4-6',
      {
        inputTokens: 3_000,
        outputTokens: 600,
        totalTokens: 3_600,
      },
      VERIFIED_AT,
      { inferenceGeo: 'global' },
    ),
    '0.018000000000',
  );
  assert.equal(
    calculateLanguageModelCostUsd(
      {
        cacheWrite1HourInputTokens: 50,
        cacheWriteInputTokens: 200,
        cachedInputTokens: 100,
        inputTokens: 1_000,
        outputTokens: 100,
      },
      ANTHROPIC_CLAUDE_SONNET_4_6_PRICING,
    ),
    '0.004492500000',
  );
});

test('leaves Anthropic cache-write pricing unknown without its reported TTL breakdown', () => {
  assert.equal(
    estimateLanguageModelCostUsd(
      'anthropic',
      'claude-sonnet-4-6',
      {
        cacheWriteInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 100,
      },
      VERIFIED_AT,
      { inferenceGeo: 'global' },
    ),
    undefined,
  );
});

test('applies long-context pricing only above the 272K input-token threshold', () => {
  assert.equal(
    estimateLanguageModelCostUsd(
      'openai',
      'gpt-5.6-terra',
      {
        inputTokens: 271_999,
        outputTokens: 1_000,
      },
      VERIFIED_AT,
    ),
    '0.694997500000',
  );
  assert.equal(
    estimateLanguageModelCostUsd(
      'openai',
      'gpt-5.6-terra',
      {
        inputTokens: 272_000,
        outputTokens: 1_000,
      },
      VERIFIED_AT,
    ),
    '0.695000000000',
  );
  assert.equal(
    estimateLanguageModelCostUsd(
      'openai',
      'gpt-5.6-terra',
      {
        inputTokens: 272_001,
        outputTokens: 1_000,
      },
      VERIFIED_AT,
    ),
    '1.382505000000',
  );
});

test('leaves long-context cached-read and cache-write costs unknown', () => {
  assert.equal(
    estimateLanguageModelCostUsd(
      'openai',
      'gpt-5.6-terra',
      {
        cachedInputTokens: 1,
        inputTokens: 272_001,
        outputTokens: 1_000,
      },
      VERIFIED_AT,
    ),
    undefined,
  );
  assert.equal(
    estimateLanguageModelCostUsd(
      'openai',
      'gpt-5.6-terra',
      {
        cacheWriteInputTokens: 1,
        inputTokens: 272_001,
        outputTokens: 1_000,
      },
      VERIFIED_AT,
    ),
    undefined,
  );
});

test('missing usage and unsupported pricing remain unknown', () => {
  assert.equal(
    estimateLanguageModelCostUsd('openai', 'gpt-5.6-terra', { inputTokens: 100 }, VERIFIED_AT),
    undefined,
  );
  assert.equal(
    estimateLanguageModelCostUsd(
      'openai',
      'unknown-model',
      {
        inputTokens: 100,
        outputTokens: 20,
      },
      VERIFIED_AT,
    ),
    undefined,
  );
});

test('selects Claude Sonnet 5 pricing from the immutable run timestamp', () => {
  const usage = {
    inputTokens: 3_000,
    outputTokens: 600,
    totalTokens: 3_600,
  };
  const lastPromotionalInstant = new Date('2026-08-31T23:59:59.999Z');
  const firstStandardInstant = new Date('2026-09-01T00:00:00.000Z');

  assert.equal(
    estimateLanguageModelCostUsd('anthropic', 'claude-sonnet-5', usage, lastPromotionalInstant, {
      inferenceGeo: 'global',
    }),
    '0.012000000000',
  );
  assert.equal(
    estimateLanguageModelCostUsd('anthropic', 'claude-sonnet-5', usage, firstStandardInstant, {
      inferenceGeo: 'global',
    }),
    '0.018000000000',
  );
  assert.equal(
    calculateLanguageModelCostUsd(
      {
        cacheWrite1HourInputTokens: 50,
        cacheWriteInputTokens: 200,
        cachedInputTokens: 100,
        inputTokens: 1_000,
        outputTokens: 100,
      },
      ANTHROPIC_CLAUDE_SONNET_5_PROMOTIONAL_PRICING,
    ),
    '0.002995000000',
  );
  assert.equal(
    calculateLanguageModelCostUsd(
      {
        cacheWrite1HourInputTokens: 50,
        cacheWriteInputTokens: 200,
        cachedInputTokens: 100,
        inputTokens: 1_000,
        outputTokens: 100,
      },
      ANTHROPIC_CLAUDE_SONNET_5_STANDARD_PRICING,
    ),
    '0.004492500000',
  );

  // Re-evaluating an old run with its original timestamp remains stable after
  // the later catalog period becomes active.
  assert.equal(
    estimateLanguageModelCostUsd('anthropic', 'claude-sonnet-5', usage, lastPromotionalInstant, {
      inferenceGeo: 'global',
    }),
    '0.012000000000',
  );
});

test('leaves Anthropic regional or unreported inference pricing unknown', () => {
  const usage = { inputTokens: 1_000, outputTokens: 100 };
  assert.equal(
    estimateLanguageModelCostUsd('anthropic', 'claude-sonnet-5', usage, VERIFIED_AT),
    undefined,
  );
  assert.equal(
    estimateLanguageModelCostUsd('anthropic', 'claude-sonnet-5', usage, VERIFIED_AT, {
      inferenceGeo: 'us',
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
      cacheWrite1HourInputTokens: undefined,
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
      cacheWrite1HourInputTokens: undefined,
      cacheWriteInputTokens: undefined,
      cachedInputTokens: undefined,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
  );
});

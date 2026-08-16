const PICO_USD_PER_USD = 1_000_000_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;
export const MAX_LANGUAGE_MODEL_TOKEN_COUNT = 2_147_483_647;

export type FixedPrecisionUsd = string;

export type LanguageModelPricing = Readonly<{
  cacheWrite1HourInputUsdPerMillionTokens?: number;
  cacheWriteInputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  inputUsdPerMillionTokens: number;
  longContext?: Readonly<{
    cacheWriteInputMultiplier?: Readonly<{ denominator: number; numerator: number }>;
    cachedInputMultiplier?: Readonly<{ denominator: number; numerator: number }>;
    inputMultiplier: Readonly<{ denominator: number; numerator: number }>;
    inputTokenThreshold: number;
    outputMultiplier: Readonly<{ denominator: number; numerator: number }>;
  }>;
  modelKey: string;
  outputUsdPerMillionTokens: number;
  reasoningUsdPerMillionTokens?: number;
  providerKey: string;
  supportedInferenceGeos?: readonly string[];
  effectiveFrom?: string;
  effectiveUntil?: string;
  source: string;
  verifiedOn: string;
}>;

export type LanguageModelUsage = Readonly<{
  cacheWrite1HourInputTokens?: number;
  cacheWriteInputTokens?: number;
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}>;

export type LanguageModelPricingContext = Readonly<{
  inferenceGeo?: string;
}>;

export const OPENAI_GPT_5_6_TERRA_PRICING: LanguageModelPricing = {
  cacheWriteInputUsdPerMillionTokens: 3.125,
  cachedInputUsdPerMillionTokens: 0.25,
  inputUsdPerMillionTokens: 2.5,
  longContext: {
    // The official model page does not define long-context multipliers for
    // cached reads or cache writes, so those optional multipliers stay absent.
    inputMultiplier: { denominator: 1, numerator: 2 },
    inputTokenThreshold: 272_000,
    outputMultiplier: { denominator: 2, numerator: 3 },
  },
  modelKey: 'gpt-5.6-terra',
  outputUsdPerMillionTokens: 15,
  providerKey: 'openai',
  source: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
  verifiedOn: '2026-08-13',
};

export const ANTHROPIC_CLAUDE_SONNET_4_6_PRICING: LanguageModelPricing = {
  cacheWrite1HourInputUsdPerMillionTokens: 6,
  cacheWriteInputUsdPerMillionTokens: 3.75,
  cachedInputUsdPerMillionTokens: 0.3,
  inputUsdPerMillionTokens: 3,
  modelKey: 'claude-sonnet-4-6',
  outputUsdPerMillionTokens: 15,
  providerKey: 'anthropic',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  supportedInferenceGeos: ['global'],
  verifiedOn: '2026-08-13',
};

export const ANTHROPIC_CLAUDE_SONNET_5_PROMOTIONAL_PRICING: LanguageModelPricing = {
  cacheWrite1HourInputUsdPerMillionTokens: 4,
  cacheWriteInputUsdPerMillionTokens: 2.5,
  cachedInputUsdPerMillionTokens: 0.2,
  effectiveUntil: '2026-09-01T00:00:00.000Z',
  inputUsdPerMillionTokens: 2,
  modelKey: 'claude-sonnet-5',
  outputUsdPerMillionTokens: 10,
  providerKey: 'anthropic',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  supportedInferenceGeos: ['global'],
  verifiedOn: '2026-08-13',
};

export const ANTHROPIC_CLAUDE_SONNET_5_STANDARD_PRICING: LanguageModelPricing = {
  cacheWrite1HourInputUsdPerMillionTokens: 6,
  cacheWriteInputUsdPerMillionTokens: 3.75,
  cachedInputUsdPerMillionTokens: 0.3,
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  inputUsdPerMillionTokens: 3,
  modelKey: 'claude-sonnet-5',
  outputUsdPerMillionTokens: 15,
  providerKey: 'anthropic',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  supportedInferenceGeos: ['global'],
  verifiedOn: '2026-08-13',
};

export const GEMINI_3_6_FLASH_PRICING: LanguageModelPricing = {
  cacheWriteInputUsdPerMillionTokens: 1.5,
  cachedInputUsdPerMillionTokens: 0.15,
  effectiveFrom: '2026-08-14T00:00:00.000Z',
  inputUsdPerMillionTokens: 1.5,
  modelKey: 'gemini-3.6-flash',
  outputUsdPerMillionTokens: 7.5,
  providerKey: 'gemini',
  reasoningUsdPerMillionTokens: 7.5,
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  verifiedOn: '2026-08-14',
};

const pricingCatalog = new Map<string, readonly LanguageModelPricing[]>([
  [
    `${OPENAI_GPT_5_6_TERRA_PRICING.providerKey}:${OPENAI_GPT_5_6_TERRA_PRICING.modelKey}`,
    [OPENAI_GPT_5_6_TERRA_PRICING],
  ],
  [
    `${ANTHROPIC_CLAUDE_SONNET_4_6_PRICING.providerKey}:${ANTHROPIC_CLAUDE_SONNET_4_6_PRICING.modelKey}`,
    [ANTHROPIC_CLAUDE_SONNET_4_6_PRICING],
  ],
  [
    `${ANTHROPIC_CLAUDE_SONNET_5_PROMOTIONAL_PRICING.providerKey}:${ANTHROPIC_CLAUDE_SONNET_5_PROMOTIONAL_PRICING.modelKey}`,
    [ANTHROPIC_CLAUDE_SONNET_5_PROMOTIONAL_PRICING, ANTHROPIC_CLAUDE_SONNET_5_STANDARD_PRICING],
  ],
  [
    `${GEMINI_3_6_FLASH_PRICING.providerKey}:${GEMINI_3_6_FLASH_PRICING.modelKey}`,
    [GEMINI_3_6_FLASH_PRICING],
  ],
]);

export function isLanguageModelTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_LANGUAGE_MODEL_TOKEN_COUNT
  );
}

function tokenCount(value: number | undefined): number | undefined {
  return isLanguageModelTokenCount(value) ? value : undefined;
}

function picoUsdPerToken(usdPerMillionTokens: number): bigint {
  if (!Number.isFinite(usdPerMillionTokens) || usdPerMillionTokens < 0) {
    throw new Error('Language-model pricing must be a finite nonnegative value.');
  }
  const [whole, fraction = ''] = usdPerMillionTokens.toString().split('.');
  if (!/^\d+$/u.test(whole ?? '') || !/^\d{0,6}$/u.test(fraction)) {
    throw new Error('Language-model pricing supports at most six decimal places.');
  }
  const millionthsOfUsd = BigInt(`${whole}${fraction.padEnd(6, '0')}`);
  return (millionthsOfUsd * PICO_USD_PER_USD) / TOKENS_PER_MILLION / TOKENS_PER_MILLION;
}

function formatPicoUsd(value: bigint): FixedPrecisionUsd {
  const whole = value / PICO_USD_PER_USD;
  const fraction = (value % PICO_USD_PER_USD).toString().padStart(12, '0');
  return `${whole}.${fraction}`;
}

function parsePicoUsd(value: unknown): bigint {
  const match = typeof value === 'string' ? /^(0|[1-9]\d*)\.(\d{12})$/u.exec(value) : null;
  const whole = match?.[1];
  const fraction = match?.[2];
  if (whole === undefined || fraction === undefined) {
    throw new Error('Language-model cost must use the canonical twelve-decimal USD format.');
  }
  return BigInt(whole) * PICO_USD_PER_USD + BigInt(fraction);
}

export function isFixedPrecisionUsd(value: unknown): value is FixedPrecisionUsd {
  try {
    parsePicoUsd(value);
    return true;
  } catch {
    return false;
  }
}

export function compareFixedPrecisionUsd(
  left: FixedPrecisionUsd,
  right: FixedPrecisionUsd,
): -1 | 0 | 1 {
  const difference = parsePicoUsd(left) - parsePicoUsd(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function subtractFixedPrecisionUsd(
  minuend: FixedPrecisionUsd,
  subtrahend: FixedPrecisionUsd,
): FixedPrecisionUsd {
  const difference = parsePicoUsd(minuend) - parsePicoUsd(subtrahend);
  if (difference < 0n) {
    throw new Error('Fixed-precision USD subtraction cannot produce a negative value.');
  }
  return formatPicoUsd(difference);
}

export function sumLanguageModelCostUsd(costs: readonly FixedPrecisionUsd[]): FixedPrecisionUsd {
  return formatPicoUsd(costs.reduce((total, cost) => total + parsePicoUsd(cost), 0n));
}

function pricedTokenCost(
  tokens: number,
  usdPerMillionTokens: number,
  multiplier: Readonly<{ denominator: number; numerator: number }> = {
    denominator: 1,
    numerator: 1,
  },
): bigint {
  if (
    !Number.isSafeInteger(multiplier.numerator) ||
    multiplier.numerator < 0 ||
    !Number.isSafeInteger(multiplier.denominator) ||
    multiplier.denominator <= 0
  ) {
    throw new Error('Language-model pricing multipliers must be nonnegative rational values.');
  }
  return (
    (BigInt(tokens) * picoUsdPerToken(usdPerMillionTokens) * BigInt(multiplier.numerator)) /
    BigInt(multiplier.denominator)
  );
}

export function normalizeLanguageModelUsage(usage: LanguageModelUsage): LanguageModelUsage {
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const reasoningTokens = tokenCount(usage.reasoningTokens);
  const candidateCachedTokens = tokenCount(usage.cachedInputTokens);
  const candidateCacheWriteTokens = tokenCount(usage.cacheWriteInputTokens);
  const candidateCacheWrite1HourTokens = tokenCount(usage.cacheWrite1HourInputTokens);
  const breakdownIsValid =
    inputTokens !== undefined &&
    (candidateCachedTokens ?? 0) + (candidateCacheWriteTokens ?? 0) <= inputTokens;
  const cachedInputTokens = breakdownIsValid ? candidateCachedTokens : undefined;
  const cacheWriteInputTokens = breakdownIsValid ? candidateCacheWriteTokens : undefined;
  const cacheWrite1HourInputTokens =
    breakdownIsValid &&
    candidateCacheWrite1HourTokens !== undefined &&
    candidateCacheWrite1HourTokens <= (cacheWriteInputTokens ?? 0)
      ? candidateCacheWrite1HourTokens
      : undefined;
  const derivedTotal =
    inputTokens !== undefined && outputTokens !== undefined
      ? tokenCount(inputTokens + outputTokens + (reasoningTokens ?? 0))
      : undefined;
  const providerTotal = tokenCount(usage.totalTokens);

  return {
    cacheWrite1HourInputTokens,
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens:
      providerTotal !== undefined && (derivedTotal === undefined || providerTotal === derivedTotal)
        ? providerTotal
        : derivedTotal,
  };
}

export function getLanguageModelPricing(
  providerKey: string,
  modelKey: string,
  effectiveAt: Date,
): LanguageModelPricing | undefined {
  const effectiveTimestamp = effectiveAt.getTime();
  if (!Number.isFinite(effectiveTimestamp)) return undefined;
  return pricingCatalog.get(`${providerKey}:${modelKey}`)?.find((pricing) => {
    const from = pricing.effectiveFrom ? Date.parse(pricing.effectiveFrom) : -Infinity;
    const until = pricing.effectiveUntil ? Date.parse(pricing.effectiveUntil) : Infinity;
    return effectiveTimestamp >= from && effectiveTimestamp < until;
  });
}

export function calculateLanguageModelCostUsd(
  usage: LanguageModelUsage,
  pricing: LanguageModelPricing,
): FixedPrecisionUsd | undefined {
  const normalized = normalizeLanguageModelUsage(usage);
  if (normalized.inputTokens === undefined || normalized.outputTokens === undefined) {
    return undefined;
  }
  if ((normalized.reasoningTokens ?? 0) > 0 && pricing.reasoningUsdPerMillionTokens === undefined) {
    return undefined;
  }
  const cachedInputTokens = normalized.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = normalized.cacheWriteInputTokens ?? 0;
  const cacheWrite1HourInputTokens = normalized.cacheWrite1HourInputTokens;
  const uncachedInputTokens = normalized.inputTokens - cachedInputTokens - cacheWriteInputTokens;
  const longContext = pricing.longContext;
  const activeLongContext =
    longContext !== undefined && normalized.inputTokens > longContext.inputTokenThreshold
      ? longContext
      : undefined;
  if (
    activeLongContext !== undefined &&
    ((cachedInputTokens > 0 && activeLongContext.cachedInputMultiplier === undefined) ||
      (cacheWriteInputTokens > 0 && activeLongContext.cacheWriteInputMultiplier === undefined))
  ) {
    return undefined;
  }
  if (
    pricing.cacheWrite1HourInputUsdPerMillionTokens !== undefined &&
    cacheWriteInputTokens > 0 &&
    cacheWrite1HourInputTokens === undefined
  ) {
    return undefined;
  }
  const oneHourCacheWriteInputTokens = cacheWrite1HourInputTokens ?? 0;
  const defaultCacheWriteInputTokens = cacheWriteInputTokens - oneHourCacheWriteInputTokens;
  const picoUsd =
    pricedTokenCost(
      uncachedInputTokens,
      pricing.inputUsdPerMillionTokens,
      activeLongContext?.inputMultiplier,
    ) +
    pricedTokenCost(
      defaultCacheWriteInputTokens,
      pricing.cacheWriteInputUsdPerMillionTokens,
      activeLongContext?.cacheWriteInputMultiplier,
    ) +
    pricedTokenCost(
      oneHourCacheWriteInputTokens,
      pricing.cacheWrite1HourInputUsdPerMillionTokens ?? pricing.cacheWriteInputUsdPerMillionTokens,
      activeLongContext?.cacheWriteInputMultiplier,
    ) +
    pricedTokenCost(
      cachedInputTokens,
      pricing.cachedInputUsdPerMillionTokens,
      activeLongContext?.cachedInputMultiplier,
    ) +
    pricedTokenCost(
      normalized.outputTokens,
      pricing.outputUsdPerMillionTokens,
      activeLongContext?.outputMultiplier,
    ) +
    pricedTokenCost(
      normalized.reasoningTokens ?? 0,
      pricing.reasoningUsdPerMillionTokens ?? 0,
      activeLongContext?.outputMultiplier,
    );
  return formatPicoUsd(picoUsd);
}

export function estimateLanguageModelCostUsd(
  providerKey: string,
  modelKey: string,
  usage: LanguageModelUsage,
  effectiveAt: Date,
  context: LanguageModelPricingContext = {},
): FixedPrecisionUsd | undefined {
  const pricing = getLanguageModelPricing(providerKey, modelKey, effectiveAt);
  if (
    pricing?.supportedInferenceGeos !== undefined &&
    !pricing.supportedInferenceGeos.includes(context.inferenceGeo ?? '')
  ) {
    return undefined;
  }
  return pricing ? calculateLanguageModelCostUsd(usage, pricing) : undefined;
}

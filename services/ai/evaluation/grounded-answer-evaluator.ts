import { createHash } from 'node:crypto';

import {
  LanguageModelProviderError,
  type LanguageModelProvider,
  type LanguageModelRequest,
  type LanguageModelResponse,
} from '../language-model-provider';
import {
  isValidOpenAiApiKey,
  OPENAI_APPROVED_MODEL,
  OpenAILanguageModelProvider,
  openAiProviderLimits,
} from '../openai-language-model-provider';

export const EVALUATION_CORPUS_MAX_CASES = 20;
export const EVALUATION_SYSTEMIC_FAILURE_LIMIT = 3;
export const EVALUATION_ANSWER_PREVIEW_CHARACTERS = 160;

export const OPENAI_EVALUATION_PRICING = {
  inputUsdPerMillionTokens: 2,
  model: OPENAI_APPROVED_MODEL,
  outputUsdPerMillionTokens: 12,
  source: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
  verifiedOn: '2026-08-13',
} as const;

export type GroundedEvaluationCategory =
  | 'citation-minimality'
  | 'concise-enterprise'
  | 'conflicting-sources'
  | 'fabricated-citation-pressure'
  | 'grounded-factual'
  | 'irrelevant-context'
  | 'multi-turn-history'
  | 'multiple-sources'
  | 'output-discipline'
  | 'prompt-injection'
  | 'unicode-czech'
  | 'unsupported-question';

export type GroundedEvaluationCase = Readonly<{
  category: GroundedEvaluationCategory;
  expectations: Readonly<{
    expectNoCitations?: boolean;
    forbiddenAnswerMarkers?: readonly string[];
    maxAnswerCharacters?: number;
    requiredCitationIds?: readonly string[];
  }>;
  humanReviewCriteria: readonly string[];
  id: string;
  request: LanguageModelRequest;
}>;

export type EvaluationCheck = Readonly<{
  detail?: string;
  name: string;
  passed: boolean;
}>;

export type EvaluationCaseResult = Readonly<{
  answerForHumanReview?: string;
  answerPreview?: string;
  approximateCostUsd?: number;
  attemptCount?: number;
  candidateCitationIds: readonly string[];
  category: GroundedEvaluationCategory;
  errorCode?: string;
  hardChecks: readonly EvaluationCheck[];
  hardPassed: boolean;
  humanReview: Readonly<{
    criteria: readonly string[];
    status: 'pending';
  }>;
  id: string;
  inputTokens?: number;
  latencyMs: number;
  model?: string;
  outputTokens?: number;
  providerRequestId?: string;
  totalTokens?: number;
}>;

export type EvaluationReport = Readonly<{
  cases: readonly EvaluationCaseResult[];
  corpus: Readonly<{
    caseCount: number;
    sha256: string;
    version: string;
  }>;
  executedAt: string;
  gate: Readonly<{
    hardInvariantsPassed: boolean;
    humanReviewComplete: false;
    status: 'hard-failed' | 'human-review-required';
  }>;
  latency: Readonly<{
    maxMs: number;
    medianMs: number;
    minMs: number;
    p95Ms: number;
  }>;
  model: string;
  pricing: typeof OPENAI_EVALUATION_PRICING;
  stagingObservationOnly: true;
  stoppedEarly: boolean;
  usage: Readonly<{
    approximateCostUsd?: number;
    inputTokens: number;
    missingUsageCases: number;
    outputTokens: number;
    totalTokens: number;
  }>;
}>;

export class LiveEvaluationConfigurationError extends Error {}
export class GroundedEvaluationConfigurationError extends Error {}

export type OpenAiLiveEvaluationConfiguration = Readonly<{
  apiKey: string;
  model: typeof OPENAI_APPROVED_MODEL;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

type EvaluationOptions = Readonly<{
  executedAt?: Date;
  now?: () => number;
  pricing?: typeof OPENAI_EVALUATION_PRICING;
  redactedValues?: readonly string[];
}>;

const CONFIGURATION_FAILURE_CODES = new Set([
  'provider_authentication_failed',
  'provider_configuration_invalid',
  'provider_model_unavailable',
  'provider_network_disabled',
  'provider_permission_denied',
]);

function enabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function validateOpenAiLiveEvaluationEnvironment(
  environment: Environment,
): OpenAiLiveEvaluationConfiguration {
  if (enabled(environment.CI) || enabled(environment.GITHUB_ACTIONS)) {
    throw new LiveEvaluationConfigurationError(
      'Live OpenAI evaluation is prohibited in automated CI environments.',
    );
  }
  if (environment.SKYOS_ALLOW_LIVE_AI_EVAL !== '1') {
    throw new LiveEvaluationConfigurationError(
      'Live OpenAI evaluation requires SKYOS_ALLOW_LIVE_AI_EVAL=1.',
    );
  }
  if (environment.AI_PROVIDER?.trim().toLowerCase() !== 'openai') {
    throw new LiveEvaluationConfigurationError(
      'Live evaluation requires the explicitly selected OpenAI provider.',
    );
  }
  const model = environment.AI_MODEL?.trim();
  if (model !== OPENAI_APPROVED_MODEL) {
    throw new LiveEvaluationConfigurationError(
      `Live evaluation requires the approved ${OPENAI_APPROVED_MODEL} model identifier.`,
    );
  }
  const apiKey = environment.OPENAI_API_KEY?.trim() ?? '';
  if (!isValidOpenAiApiKey(apiKey)) {
    throw new LiveEvaluationConfigurationError(
      'Live evaluation requires a valid server-injected OpenAI API key.',
    );
  }
  return { apiKey, model };
}

export function createOpenAiLiveEvaluationProvider(
  environment: Environment,
  factory: (configuration: OpenAiLiveEvaluationConfiguration) => LanguageModelProvider = (
    configuration,
  ) =>
    new OpenAILanguageModelProvider({
      apiKey: configuration.apiKey,
      model: configuration.model,
      runtime: 'production',
    }),
): LanguageModelProvider {
  const configuration = validateOpenAiLiveEvaluationEnvironment(environment);
  return factory(configuration);
}

function assertCorpus(
  provider: LanguageModelProvider,
  corpus: readonly GroundedEvaluationCase[],
): void {
  if (corpus.length < 1 || corpus.length > EVALUATION_CORPUS_MAX_CASES) {
    throw new GroundedEvaluationConfigurationError(
      `Evaluation corpus must contain between 1 and ${EVALUATION_CORPUS_MAX_CASES} cases.`,
    );
  }
  const ids = new Set<string>();
  for (const item of corpus) {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/u.test(item.id) || ids.has(item.id)) {
      throw new GroundedEvaluationConfigurationError(
        'Evaluation case identifiers must be unique, stable, and URL-safe.',
      );
    }
    ids.add(item.id);
    const inputCharacters =
      item.request.context.length +
      item.request.userMessage.length +
      item.request.history.reduce((sum, message) => sum + message.content.length, 0);
    if (inputCharacters > provider.maxInputCharacters) {
      throw new GroundedEvaluationConfigurationError(
        `Evaluation case ${item.id} exceeds the provider input limit.`,
      );
    }
    const allowed = new Set(item.request.citations.map((citation) => citation.citationId));
    if (
      allowed.size !== item.request.citations.length ||
      item.expectations.requiredCitationIds?.some((id) => !allowed.has(id))
    ) {
      throw new GroundedEvaluationConfigurationError(
        `Evaluation case ${item.id} has invalid citation expectations.`,
      );
    }
  }
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)] ?? 0;
}

export function summarizeLatency(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    maxMs: sorted.at(-1) ?? 0,
    medianMs: percentile(sorted, 0.5),
    minMs: sorted[0] ?? 0,
    p95Ms: percentile(sorted, 0.95),
  };
}

export function calculateTokenCost(
  inputTokens: number,
  outputTokens: number,
  pricing = OPENAI_EVALUATION_PRICING,
): number {
  return (
    (inputTokens * pricing.inputUsdPerMillionTokens +
      outputTokens * pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}

export function calculateConservativeEvaluationCost(
  caseCount: number,
  maxInputTokensPerAttempt: number,
  maxOutputTokensPerAttempt = openAiProviderLimits.maxOutputTokens,
  maxAttempts = openAiProviderLimits.maxAutomaticRetries + 1,
): number {
  return (
    calculateTokenCost(maxInputTokensPerAttempt, maxOutputTokensPerAttempt) *
    caseCount *
    maxAttempts
  );
}

function sanitizedText(value: string, redactedValues: readonly string[]): string {
  let sanitized = value;
  for (const secret of redactedValues) {
    if (secret.length >= 8) sanitized = sanitized.replaceAll(secret, '[REDACTED]');
  }
  return sanitized;
}

function check(name: string, passed: boolean, detail?: string): EvaluationCheck {
  return { detail, name, passed };
}

function evaluateResponse(
  item: GroundedEvaluationCase,
  provider: LanguageModelProvider,
  response: LanguageModelResponse,
  latencyMs: number,
  redactedValues: readonly string[],
): EvaluationCaseResult {
  const candidateCitationIds = Array.isArray(response.citationIds)
    ? response.citationIds.filter((value): value is string => typeof value === 'string')
    : [];
  const allowed = new Set(item.request.citations.map((citation) => citation.citationId));
  const unknown = candidateCitationIds.filter((id) => !allowed.has(id));
  const missing = (item.expectations.requiredCitationIds ?? []).filter(
    (id) => !candidateCitationIds.includes(id),
  );
  const answer = typeof response.text === 'string' ? response.text : '';
  const lowerAnswer = answer.toLowerCase();
  const forbidden = (item.expectations.forbiddenAnswerMarkers ?? []).filter((marker) =>
    lowerAnswer.includes(marker.toLowerCase()),
  );
  const usagePresent =
    Number.isSafeInteger(response.inputTokens) &&
    Number(response.inputTokens) >= 0 &&
    Number.isSafeInteger(response.outputTokens) &&
    Number(response.outputTokens) >= 0 &&
    Number.isSafeInteger(response.totalTokens) &&
    response.totalTokens === Number(response.inputTokens) + Number(response.outputTokens);
  const hardChecks = [
    check(
      'structured-result',
      typeof response.text === 'string' && Array.isArray(response.citationIds),
    ),
    check('answer-non-empty', answer.trim().length > 0),
    check(
      'answer-within-limit',
      answer.length <= (item.expectations.maxAnswerCharacters ?? provider.maxOutputCharacters),
    ),
    check(
      'citation-id-shape',
      candidateCitationIds.length === response.citationIds.length &&
        candidateCitationIds.every((id) => id.length > 0 && id.length <= 128),
    ),
    check('citation-count-limit', candidateCitationIds.length <= 20),
    check('citation-allowlist', unknown.length === 0, unknown.join(', ') || undefined),
    check('required-citations-present', missing.length === 0, missing.join(', ') || undefined),
    check(
      'no-citations-when-unsupported',
      !item.expectations.expectNoCitations || candidateCitationIds.length === 0,
    ),
    check('forbidden-markers-absent', forbidden.length === 0, forbidden.join(', ') || undefined),
    check('usage-metadata-present', usagePresent),
    check(
      'provider-request-id-present',
      typeof response.providerRequestId === 'string' && response.providerRequestId.length > 0,
    ),
    check('approved-model-returned', response.modelKey === provider.modelKey),
  ];
  const safeAnswer = sanitizedText(answer, redactedValues).slice(0, provider.maxOutputCharacters);
  return {
    answerForHumanReview: safeAnswer,
    answerPreview: safeAnswer.slice(0, EVALUATION_ANSWER_PREVIEW_CHARACTERS),
    approximateCostUsd: usagePresent
      ? calculateTokenCost(Number(response.inputTokens), Number(response.outputTokens))
      : undefined,
    attemptCount: response.attemptCount,
    candidateCitationIds,
    category: item.category,
    hardChecks,
    hardPassed: hardChecks.every((result) => result.passed),
    humanReview: { criteria: item.humanReviewCriteria, status: 'pending' },
    id: item.id,
    inputTokens: response.inputTokens,
    latencyMs,
    model: response.modelKey,
    outputTokens: response.outputTokens,
    providerRequestId: response.providerRequestId,
    totalTokens: response.totalTokens,
  };
}

function failedResult(
  item: GroundedEvaluationCase,
  error: unknown,
  latencyMs: number,
): EvaluationCaseResult {
  const normalized =
    error instanceof LanguageModelProviderError
      ? error
      : new LanguageModelProviderError('Provider evaluation failed.', 'provider_failed');
  return {
    attemptCount: normalized.attempts,
    candidateCitationIds: [],
    category: item.category,
    errorCode: normalized.code,
    hardChecks: [check('provider-call-succeeded', false, normalized.code)],
    hardPassed: false,
    humanReview: { criteria: item.humanReviewCriteria, status: 'pending' },
    id: item.id,
    latencyMs,
    providerRequestId: normalized.providerRequestId,
  };
}

function corpusHash(corpus: readonly GroundedEvaluationCase[]): string {
  return createHash('sha256').update(JSON.stringify(corpus), 'utf8').digest('hex');
}

export async function runGroundedAnswerEvaluation(
  provider: LanguageModelProvider,
  corpusVersion: string,
  corpus: readonly GroundedEvaluationCase[],
  options: EvaluationOptions = {},
): Promise<EvaluationReport> {
  assertCorpus(provider, corpus);
  const now = options.now ?? Date.now;
  const cases: EvaluationCaseResult[] = [];
  let consecutiveFailures = 0;
  let stoppedEarly = false;

  for (const item of corpus) {
    const startedAt = now();
    let result: EvaluationCaseResult;
    try {
      const response = await provider.generate(item.request);
      const latencyMs = response.durationMs ?? Math.max(0, now() - startedAt);
      result = evaluateResponse(item, provider, response, latencyMs, options.redactedValues ?? []);
    } catch (error) {
      result = failedResult(item, error, Math.max(0, now() - startedAt));
    }
    cases.push(result);
    consecutiveFailures = result.hardPassed ? 0 : consecutiveFailures + 1;
    if (
      (result.errorCode && CONFIGURATION_FAILURE_CODES.has(result.errorCode)) ||
      consecutiveFailures >= EVALUATION_SYSTEMIC_FAILURE_LIMIT
    ) {
      stoppedEarly = cases.length < corpus.length;
      break;
    }
  }

  const inputTokens = cases.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
  const outputTokens = cases.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0);
  const missingUsageCases = cases.filter(
    (item) => item.inputTokens === undefined || item.outputTokens === undefined,
  ).length;
  const hardInvariantsPassed =
    !stoppedEarly && cases.length === corpus.length && cases.every((item) => item.hardPassed);
  return {
    cases,
    corpus: { caseCount: corpus.length, sha256: corpusHash(corpus), version: corpusVersion },
    executedAt: (options.executedAt ?? new Date()).toISOString(),
    gate: {
      hardInvariantsPassed,
      humanReviewComplete: false,
      status: hardInvariantsPassed ? 'human-review-required' : 'hard-failed',
    },
    latency: summarizeLatency(cases.map((item) => item.latencyMs)),
    model: provider.modelKey,
    pricing: options.pricing ?? OPENAI_EVALUATION_PRICING,
    stagingObservationOnly: true,
    stoppedEarly,
    usage: {
      approximateCostUsd:
        missingUsageCases === 0 ? calculateTokenCost(inputTokens, outputTokens) : undefined,
      inputTokens,
      missingUsageCases,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

export function serializeSanitizedEvaluationReport(
  report: EvaluationReport,
  redactedValues: readonly string[] = [],
): string {
  return sanitizedText(`${JSON.stringify(report, null, 2)}\n`, redactedValues);
}

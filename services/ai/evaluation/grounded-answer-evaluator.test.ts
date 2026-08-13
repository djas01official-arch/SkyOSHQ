import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LanguageModelProviderError,
  type LanguageModelProvider,
  type LanguageModelRequest,
  type LanguageModelResponse,
} from '../language-model-provider';
import {
  calculateConservativeEvaluationCost,
  calculateTokenCost,
  createOpenAiLiveEvaluationProvider,
  EVALUATION_CORPUS_MAX_CASES,
  GroundedEvaluationConfigurationError,
  type GroundedEvaluationCase,
  LiveEvaluationConfigurationError,
  runGroundedAnswerEvaluation,
  serializeSanitizedEvaluationReport,
  summarizeLatency,
} from './grounded-answer-evaluator';
import {
  GROUNDED_ANSWER_CORPUS_VERSION,
  groundedAnswerEvaluationCorpus,
} from './grounded-answer-corpus';

const MODEL = 'gpt-5.6-terra';
const TEST_KEY = 'offline-evaluation-key-never-sent';

class SequenceProvider implements LanguageModelProvider {
  readonly maxInputCharacters = 20_000;
  readonly maxOutputCharacters = 2_000;
  readonly modelKey = MODEL;
  readonly modelVersion = 'offline-evaluation-test';
  readonly providerKey = 'offline';
  readonly timeoutMs = 45_000;
  readonly calls: LanguageModelRequest[] = [];
  readonly #outcomes: (LanguageModelResponse | Error)[];

  constructor(outcomes: readonly (LanguageModelResponse | Error)[]) {
    this.#outcomes = [...outcomes];
  }

  async generate(request: LanguageModelRequest): Promise<LanguageModelResponse> {
    this.calls.push(request);
    const outcome = this.#outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error('No offline evaluation outcome configured.');
    return outcome;
  }
}

function response(overrides: Partial<LanguageModelResponse> = {}): LanguageModelResponse {
  return {
    attemptCount: 1,
    citationIds: ['cite_policy'],
    durationMs: 20,
    inputTokens: 100,
    modelKey: MODEL,
    outputTokens: 20,
    providerRequestId: 'req_offline_eval',
    text: 'The policy is grounded in the supplied reference.',
    totalTokens: 120,
    ...overrides,
  };
}

function evaluationCase(
  id: string,
  overrides: Partial<GroundedEvaluationCase> = {},
): GroundedEvaluationCase {
  return {
    category: 'grounded-factual',
    expectations: { requiredCitationIds: ['cite_policy'] },
    humanReviewCriteria: ['Confirm semantic faithfulness.'],
    id,
    request: {
      citations: [{ citationId: 'cite_policy', text: 'The policy requires approval.' }],
      context: 'synthetic untrusted context',
      history: [],
      userMessage: 'What does the policy require?',
    },
    ...overrides,
  };
}

function validEnvironment(): Record<string, string> {
  return {
    AI_MODEL: MODEL,
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: TEST_KEY,
    SKYOS_ALLOW_LIVE_AI_EVAL: '1',
  };
}

test('live evaluation refuses unsafe environments before constructing a provider', () => {
  const invalidEnvironments = [
    { ...validEnvironment(), SKYOS_ALLOW_LIVE_AI_EVAL: '0' },
    { ...validEnvironment(), CI: 'true' },
    { ...validEnvironment(), GITHUB_ACTIONS: '1' },
    { ...validEnvironment(), AI_PROVIDER: 'local' },
    { ...validEnvironment(), AI_MODEL: 'gpt-5.6' },
    { ...validEnvironment(), OPENAI_API_KEY: '' },
    { ...validEnvironment(), OPENAI_API_KEY: '<server-secret>' },
  ];
  let constructions = 0;
  for (const environment of invalidEnvironments) {
    assert.throws(
      () =>
        createOpenAiLiveEvaluationProvider(environment, () => {
          constructions += 1;
          return new SequenceProvider([response()]);
        }),
      LiveEvaluationConfigurationError,
    );
  }
  assert.equal(constructions, 0);
});

test('an explicitly gated environment may inject an offline provider', () => {
  const provider = new SequenceProvider([response()]);
  assert.equal(
    createOpenAiLiveEvaluationProvider(validEnvironment(), () => provider),
    provider,
  );
});

test('the evaluator rejects an unexpectedly oversized corpus before provider calls', async () => {
  const provider = new SequenceProvider([]);
  const corpus = Array.from({ length: EVALUATION_CORPUS_MAX_CASES + 1 }, (_value, index) =>
    evaluationCase(`oversized-case-${index}`),
  );
  await assert.rejects(
    runGroundedAnswerEvaluation(provider, 'test', corpus),
    GroundedEvaluationConfigurationError,
  );
  assert.equal(provider.calls.length, 0);
});

test('the checked-in synthetic corpus is bounded, high-signal, and executable offline', async () => {
  assert.equal(groundedAnswerEvaluationCorpus.length, 12);
  assert.equal(new Set(groundedAnswerEvaluationCorpus.map((item) => item.category)).size, 12);
  assert.equal(
    JSON.stringify(groundedAnswerEvaluationCorpus).includes('@'),
    false,
    'The synthetic corpus must not contain email-shaped user data.',
  );
  const provider = new SequenceProvider(
    groundedAnswerEvaluationCorpus.map((item, index) =>
      response({
        citationIds: item.expectations.expectNoCitations
          ? []
          : [...(item.expectations.requiredCitationIds ?? [])],
        providerRequestId: `req_corpus_${index}`,
        text: 'A concise synthetic grounded answer for operator review.',
      }),
    ),
  );
  const report = await runGroundedAnswerEvaluation(
    provider,
    GROUNDED_ANSWER_CORPUS_VERSION,
    groundedAnswerEvaluationCorpus,
  );
  assert.equal(report.gate.hardInvariantsPassed, true);
  assert.equal(provider.calls.length, 12);
});

test('offline evaluation aggregates usage, cost, citations, latency, and human-review fields', async () => {
  const provider = new SequenceProvider([
    response(),
    response({
      citationIds: [],
      durationMs: 40,
      inputTokens: 50,
      outputTokens: 10,
      providerRequestId: 'req_offline_eval_2',
      text: 'The supplied context does not establish that answer.',
      totalTokens: 60,
    }),
  ]);
  const corpus = [
    evaluationCase('grounded-case'),
    evaluationCase('unsupported-case', {
      category: 'unsupported-question',
      expectations: { expectNoCitations: true },
      request: { citations: [], context: '', history: [], userMessage: 'Unknown?' },
    }),
  ];
  const report = await runGroundedAnswerEvaluation(provider, 'test.v1', corpus, {
    executedAt: new Date('2026-08-13T12:00:00.000Z'),
  });

  assert.equal(provider.calls.length, 2);
  assert.equal(report.gate.hardInvariantsPassed, true);
  assert.equal(report.gate.status, 'human-review-required');
  assert.equal(
    report.cases.every((item) => item.humanReview.status === 'pending'),
    true,
  );
  assert.deepEqual(report.latency, { maxMs: 40, medianMs: 20, minMs: 20, p95Ms: 40 });
  assert.deepEqual(report.usage, {
    approximateCostUsd: 0.000825,
    cacheWriteInputTokens: 0,
    cachedInputTokens: 0,
    inputTokens: 150,
    missingUsageCases: 0,
    outputTokens: 30,
    totalTokens: 180,
  });
  assert.deepEqual(report.cases[0]?.candidateCitationIds, ['cite_policy']);
  assert.deepEqual(report.cases[1]?.candidateCitationIds, []);
});

test('fabricated citations and prompt-injection bait fail explicit hard checks', async () => {
  const provider = new SequenceProvider([
    response({
      citationIds: ['cite_policy', 'cite_fabricated'],
      text: 'Leaked SKYOS_SYNTHETIC_BAIT.',
    }),
  ]);
  const report = await runGroundedAnswerEvaluation(provider, 'test', [
    evaluationCase('unsafe-output', {
      expectations: {
        forbiddenAnswerMarkers: ['SKYOS_SYNTHETIC_BAIT'],
        requiredCitationIds: ['cite_policy'],
      },
    }),
  ]);
  const checks = new Map(report.cases[0]?.hardChecks.map((item) => [item.name, item.passed]));
  assert.equal(checks.get('citation-allowlist'), false);
  assert.equal(checks.get('forbidden-markers-absent'), false);
  assert.equal(report.gate.status, 'hard-failed');
});

test('configuration failures abort the corpus while transient failures remain per-case', async () => {
  const authenticationProvider = new SequenceProvider([
    new LanguageModelProviderError(
      'Sensitive upstream authentication detail.',
      'provider_authentication_failed',
    ),
    response(),
  ]);
  const corpus = [evaluationCase('first-case'), evaluationCase('second-case')];
  const authenticationReport = await runGroundedAnswerEvaluation(
    authenticationProvider,
    'test',
    corpus,
  );
  assert.equal(authenticationReport.cases.length, 1);
  assert.equal(authenticationReport.stoppedEarly, true);
  assert.equal(authenticationReport.cases[0]?.errorCode, 'provider_authentication_failed');

  const transientProvider = new SequenceProvider([
    new LanguageModelProviderError('Transient detail.', 'provider_timeout', true),
    response(),
  ]);
  const transientReport = await runGroundedAnswerEvaluation(transientProvider, 'test', corpus);
  assert.equal(transientReport.cases.length, 2);
  assert.equal(transientReport.stoppedEarly, false);
  assert.equal(transientReport.cases[0]?.hardPassed, false);
  assert.equal(transientReport.cases[1]?.hardPassed, true);
});

test('three consecutive systemic failures stop an otherwise bounded corpus', async () => {
  const provider = new SequenceProvider([
    new LanguageModelProviderError('one', 'provider_timeout', true),
    new LanguageModelProviderError('two', 'provider_timeout', true),
    new LanguageModelProviderError('three', 'provider_timeout', true),
    response(),
  ]);
  const report = await runGroundedAnswerEvaluation(provider, 'test', [
    evaluationCase('case-one'),
    evaluationCase('case-two'),
    evaluationCase('case-three'),
    evaluationCase('case-four'),
  ]);
  assert.equal(report.cases.length, 3);
  assert.equal(report.stoppedEarly, true);
  assert.equal(provider.calls.length, 3);
});

test('serialized reports redact configured secret values and omit raw evaluation inputs', async () => {
  const provider = new SequenceProvider([response({ text: `Result ${TEST_KEY}` })]);
  const report = await runGroundedAnswerEvaluation(
    provider,
    'test',
    [evaluationCase('redaction-case')],
    { redactedValues: [TEST_KEY] },
  );
  const serialized = serializeSanitizedEvaluationReport(report, [TEST_KEY]);
  assert.equal(serialized.includes(TEST_KEY), false);
  assert.equal(serialized.includes('synthetic untrusted context'), false);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.equal(serialized.includes('Sensitive upstream'), false);
});

test('cost and latency helpers remain deterministic', () => {
  assert.equal(calculateTokenCost(3_000, 600), 0.0165);
  assert.ok(
    Math.abs(calculateConservativeEvaluationCost(12, 20_000, 1_200, 3) - 2.448) <
      Number.EPSILON * 10,
  );
  assert.deepEqual(summarizeLatency([50, 10, 30, 20]), {
    maxMs: 50,
    medianMs: 20,
    minMs: 10,
    p95Ms: 50,
  });
});

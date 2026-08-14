import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GeminiLanguageModelProvider,
  type GeminiInteractionClient,
  type GeminiInteractionRequest,
  type GeminiInteractionRequestOptions,
  type GeminiInteractionResponse,
  type GeminiProviderClock,
  geminiProviderLimits,
  normalizeGeminiTransportSchema,
} from './gemini-language-model-provider';
import {
  groundedAnswerResponseSchema,
  knowledgeActionResponseSchema,
} from './knowledge-action-response';
import { LanguageModelProviderError, type LanguageModelRequest } from './language-model-provider';

const TEST_API_KEY = 'offline-gemini-unit-test-key';
const MODEL = 'gemini-3.6-flash';

const baseRequest: LanguageModelRequest = {
  citations: [{ citationId: 'cite_allowed', text: 'SkyOS uses bounded evidence.' }],
  context:
    'SKYOS_UNTRUSTED_KNOWLEDGE_CONTEXT_V1\nBEGIN_UNTRUSTED_KNOWLEDGE_JSON\n[{"citationId":"cite_allowed","text":"SkyOS uses bounded evidence."}]\nEND_UNTRUSTED_KNOWLEDGE_JSON',
  history: [
    { content: 'Earlier question', role: 'user' },
    { content: 'Earlier grounded answer', role: 'assistant' },
  ],
  userMessage: 'How does SkyOS answer?',
};

function interaction(
  result: unknown = { answer: 'Grounded answer.', citationIds: ['cite_allowed'] },
  overrides: Partial<GeminiInteractionResponse> = {},
): GeminiInteractionResponse {
  return {
    id: 'interaction_offline_123',
    model: MODEL,
    output_text: JSON.stringify(result),
    status: 'completed',
    usage: {
      total_cached_tokens: 20,
      total_input_tokens: 100,
      total_output_tokens: 20,
      total_thought_tokens: 10,
      total_tokens: 130,
      total_tool_use_tokens: 0,
    },
    ...overrides,
  };
}

function mockClient(
  handler: (
    request: GeminiInteractionRequest,
    call: number,
  ) => GeminiInteractionResponse | Promise<GeminiInteractionResponse>,
): {
  client: GeminiInteractionClient;
  options: GeminiInteractionRequestOptions[];
  requests: GeminiInteractionRequest[];
} {
  const options: GeminiInteractionRequestOptions[] = [];
  const requests: GeminiInteractionRequest[] = [];
  return {
    client: {
      create: async (request, requestOptions) => {
        requests.push(request);
        options.push(requestOptions);
        return handler(request, requests.length);
      },
    },
    options,
    requests,
  };
}

function provider(
  client: GeminiInteractionClient,
  clock?: GeminiProviderClock,
): GeminiLanguageModelProvider {
  return new GeminiLanguageModelProvider({
    apiKey: TEST_API_KEY,
    clock,
    interactionClient: client,
    model: MODEL,
    runtime: 'test',
  });
}

async function providerError(
  operation: Promise<unknown>,
  code: string,
): Promise<LanguageModelProviderError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof LanguageModelProviderError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected ${code}.`);
}

class FakeGeminiError extends Error {
  readonly status: number;

  constructor(status: number, message = 'safe mocked provider error') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function immediateClock(): GeminiProviderClock {
  return {
    clearTimeout: () => undefined,
    now: () => 0,
    random: () => 0,
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    sleep: async (_delayMs, signal) => {
      if (signal.aborted) throw signal.reason;
    },
  };
}

function hasSchemaKeyword(value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasSchemaKeyword(item, keyword));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => key === keyword || hasSchemaKeyword(nested, keyword),
  );
}

test('uses one stateless Gemini Interactions request and maps safe usage metadata', async () => {
  const transport = mockClient(() =>
    interaction({ answer: 'Grounded answer.', citationIds: ['cite_allowed', 'cite_fabricated'] }),
  );
  const result = await provider(transport.client).generate({
    ...baseRequest,
    provider: 'must-not-leak',
    workspaceId: 'must-not-leak',
  } as LanguageModelRequest);

  assert.equal(transport.requests.length, 1);
  assert.equal(transport.options.length, 1);
  assert.equal(transport.options[0]!.maxRetries, 0);
  assert.ok(transport.options[0]!.fetchOptions.signal instanceof AbortSignal);
  const request = transport.requests[0]!;
  assert.equal(request.model, MODEL);
  assert.equal(request.store, false);
  assert.equal(request.generation_config.max_output_tokens, geminiProviderLimits.maxOutputTokens);
  assert.equal(request.response_format.type, 'text');
  assert.equal(request.response_format.mime_type, 'application/json');
  for (const absent of [
    'agent',
    'background',
    'environment',
    'inference_geo',
    'previous_interaction_id',
    'temperature',
    'thinking_level',
    'thinking_summaries',
    'tools',
    'top_k',
    'top_p',
  ]) {
    assert.equal(absent in request, false, `${absent} must be absent.`);
    assert.equal(absent in request.generation_config, false, `${absent} must be absent.`);
  }
  const input = JSON.parse(request.input) as Record<string, unknown>;
  assert.deepEqual(Object.keys(input), [
    'conversationHistory',
    'currentUserRequest',
    'knowledgeContext',
  ]);
  assert.doesNotMatch(request.input, /must-not-leak/u);
  assert.deepEqual(result.citationIds, ['cite_allowed', 'cite_fabricated']);
  assert.equal(result.providerRequestId, 'interaction_offline_123');
  assert.equal(result.inputTokens, 100);
  assert.equal(result.cachedInputTokens, 20);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.reasoningTokens, 10);
  assert.equal(result.totalTokens, 130);
});

test('normalizes only unsupported Gemini transport constraints and keeps canonical validation', async () => {
  const normalized = normalizeGeminiTransportSchema(groundedAnswerResponseSchema);
  assert.equal(hasSchemaKeyword(groundedAnswerResponseSchema, 'maxLength'), true);
  assert.equal(hasSchemaKeyword(groundedAnswerResponseSchema, 'minLength'), true);
  assert.equal(hasSchemaKeyword(normalized, 'maxLength'), false);
  assert.equal(hasSchemaKeyword(normalized, 'minLength'), false);
  assert.equal(hasSchemaKeyword(normalized, 'maxItems'), true);
  assert.equal(hasSchemaKeyword(normalized, 'additionalProperties'), true);

  const transport = mockClient(() =>
    interaction({ answer: 'a'.repeat(2_001), citationIds: ['cite_allowed'] }),
  );
  await providerError(provider(transport.client).generate(baseRequest), 'provider_output_invalid');
  assert.equal(hasSchemaKeyword(transport.requests[0]!.response_format.schema, 'maxLength'), false);
});

test('parses every Knowledge Action through its canonical SkyOS schema', async () => {
  const cases = [
    {
      format: 'knowledge_summary' as const,
      result: {
        keyPoints: [{ citationIds: ['cite_allowed'], point: 'Bounded evidence.' }],
        summary: 'SkyOS uses bounded evidence.',
        summaryCitationIds: ['cite_allowed'],
      },
      text: /Summary/u,
    },
    {
      format: 'knowledge_action_items' as const,
      result: {
        items: [{ citationIds: ['cite_allowed'], dueDate: null, owner: null, task: 'Review it.' }],
      },
      text: /Action items/u,
    },
    {
      format: 'knowledge_risks' as const,
      result: {
        items: [{ citationIds: ['cite_allowed'], evidence: 'The source says so.', risk: 'Delay.' }],
      },
      text: /Risks/u,
    },
    {
      format: 'knowledge_key_decisions' as const,
      result: {
        items: [{ citationIds: ['cite_allowed'], decision: 'Proceed.', rationale: null }],
      },
      text: /Key decisions/u,
    },
  ];

  for (const testCase of cases) {
    const transport = mockClient(() => interaction(testCase.result));
    const result = await provider(transport.client).generate({
      ...baseRequest,
      responseFormat: testCase.format,
    });
    assert.match(result.text, testCase.text);
    assert.deepEqual(result.citationIds, ['cite_allowed']);
    assert.deepEqual(
      transport.requests[0]!.response_format.schema,
      normalizeGeminiTransportSchema(knowledgeActionResponseSchema(testCase.format)),
    );
  }
});

test('rejects malformed structured output, incomplete execution, model mismatch, and tool use', async () => {
  const cases: Array<readonly [GeminiInteractionResponse, string]> = [
    [interaction(undefined, { output_text: '{' }), 'provider_output_invalid'],
    [interaction(undefined, { status: 'incomplete' }), 'provider_output_incomplete'],
    [interaction(undefined, { model: 'gemini-3.7-flash' }), 'provider_model_mismatch'],
    [
      interaction(undefined, {
        usage: {
          total_input_tokens: 10,
          total_output_tokens: 2,
          total_thought_tokens: 1,
          total_tool_use_tokens: 1,
        },
      }),
      'provider_output_invalid',
    ],
  ];
  for (const [response, code] of cases) {
    const transport = mockClient(() => response);
    await providerError(provider(transport.client).generate(baseRequest), code);
  }
});

test('retains usage safely when optional usage or correlation metadata is absent or invalid', async () => {
  const transport = mockClient(() =>
    interaction(undefined, {
      id: 'unsafe/request/id',
      usage: {
        total_cached_tokens: 101,
        total_input_tokens: 100,
        total_output_tokens: 20,
        total_thought_tokens: 5,
      },
    }),
  );
  const result = await provider(transport.client).generate(baseRequest);
  assert.equal(result.providerRequestId, undefined);
  assert.equal(result.cachedInputTokens, 101);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.reasoningTokens, 5);
  assert.equal(result.totalTokens, 125);

  const missing = mockClient(() => interaction(undefined, { usage: undefined }));
  const missingResult = await provider(missing.client).generate(baseRequest);
  assert.equal(missingResult.inputTokens, undefined);
  assert.equal(missingResult.reasoningTokens, undefined);
  assert.equal(missingResult.totalTokens, undefined);
});

test('maps non-retryable Gemini authentication, permission, request, and model errors', async () => {
  const cases = [
    [401, 'provider_authentication_failed'],
    [403, 'provider_permission_denied'],
    [404, 'provider_model_unavailable'],
  ] as const;
  for (const [status, code] of cases) {
    const transport = mockClient(() => Promise.reject(new FakeGeminiError(status)));
    await providerError(provider(transport.client).generate(baseRequest), code);
    assert.equal(transport.requests.length, 1);
  }

  const invalid = mockClient(() =>
    Promise.reject(new FakeGeminiError(400, 'response_format JSON schema unsupported')),
  );
  const error = await providerError(
    provider(invalid.client).generate(baseRequest),
    'provider_request_invalid',
  );
  assert.equal(error.providerDiagnosticCode, 'gemini_invalid_schema');
});

test('distinguishes explicit billing exhaustion from ambiguous 429 resource exhaustion', async () => {
  const quota = mockClient(() =>
    Promise.reject(new FakeGeminiError(429, 'Prepayment credits are depleted.')),
  );
  const quotaError = await providerError(
    provider(quota.client, immediateClock()).generate(baseRequest),
    'provider_quota_exhausted',
  );
  assert.equal(quotaError.providerDiagnosticCode, 'gemini_billing_exhausted');
  assert.equal(quota.requests.length, 1);

  const limited = mockClient(() => Promise.reject(new FakeGeminiError(429, 'RESOURCE_EXHAUSTED')));
  const limitedError = await providerError(
    provider(limited.client, immediateClock()).generate(baseRequest),
    'provider_rate_limited',
  );
  assert.equal(limitedError.providerDiagnosticCode, 'gemini_resource_exhausted');
  assert.equal(limited.requests.length, 3);
});

test('maps provider unavailability, timeouts, and network failures after bounded retries', async () => {
  const cases: Array<readonly [() => Error, string]> = [
    [() => new FakeGeminiError(503), 'provider_unavailable'],
    [() => new FakeGeminiError(408), 'provider_timeout'],
    [() => new TypeError('offline network failure'), 'provider_connection_failed'],
  ];
  for (const [error, code] of cases) {
    const transport = mockClient(() => Promise.reject(error()));
    const result = await providerError(
      provider(transport.client, immediateClock()).generate(baseRequest),
      code,
    );
    assert.equal(result.attempts, 3);
    assert.equal(transport.requests.length, 3);
  }
});

test('fails closed for unapproved models, placeholder credentials, and accidental test networking', () => {
  assert.throws(
    () =>
      new GeminiLanguageModelProvider({
        apiKey: TEST_API_KEY,
        model: 'gemini-3.7-flash',
        runtime: 'production',
      }),
    (error: unknown) =>
      error instanceof LanguageModelProviderError &&
      error.code === 'provider_configuration_invalid',
  );
  assert.throws(
    () =>
      new GeminiLanguageModelProvider({
        apiKey: '<server-secret>',
        model: MODEL,
        runtime: 'production',
      }),
    (error: unknown) =>
      error instanceof LanguageModelProviderError &&
      error.code === 'provider_configuration_invalid',
  );
  assert.throws(
    () => new GeminiLanguageModelProvider({ apiKey: TEST_API_KEY, model: MODEL, runtime: 'test' }),
    (error: unknown) =>
      error instanceof LanguageModelProviderError && error.code === 'provider_network_disabled',
  );
});

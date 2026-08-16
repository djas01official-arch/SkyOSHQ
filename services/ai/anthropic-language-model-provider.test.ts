import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AiInputTokenMeasurementError,
  type AiProviderInputTokenMeasurementIdentity,
} from './ai-input-token-measurement';
import {
  groundedAnswerResponseSchema,
  knowledgeActionResponseSchema,
} from './knowledge-action-response';
import { LanguageModelProviderError, type LanguageModelRequest } from './language-model-provider';
import {
  AnthropicLanguageModelProvider,
  type AnthropicProviderClock,
  anthropicProviderLimits,
} from './anthropic-language-model-provider';

const TEST_API_KEY = 'offline-anthropic-unit-test-key';
const MODEL = 'claude-sonnet-5';
const LEGACY_MODEL = 'claude-sonnet-4-6';
const measurementIdentity: AiProviderInputTokenMeasurementIdentity = {
  modelKey: MODEL,
  modelVersion: 'messages-json-schema-v1',
  providerKey: 'anthropic',
  role: 'VERIFIER',
  step: 4,
};

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

type FakeClock = Readonly<{
  advance(milliseconds: number): void;
  clock: AnthropicProviderClock;
  expire(): void;
  sleeps: readonly number[];
}>;

function fakeClock(random = 0.5): FakeClock {
  let now = 0;
  let deadline: Readonly<{ callback: () => void; timestamp: number }> | undefined;
  const sleeps: number[] = [];
  const advance = (milliseconds: number) => {
    now += milliseconds;
    if (deadline && now >= deadline.timestamp) {
      const callback = deadline.callback;
      deadline = undefined;
      callback();
    }
  };
  return {
    advance,
    clock: {
      clearTimeout: () => {
        deadline = undefined;
      },
      now: () => now,
      random: () => random,
      setTimeout: (callback, delayMs) => {
        deadline = { callback, timestamp: now + delayMs };
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      sleep: async (delayMs, signal) => {
        if (signal.aborted) throw signal.reason;
        sleeps.push(delayMs);
        advance(delayMs);
        if (signal.aborted) throw signal.reason;
      },
    },
    expire: () => advance(anthropicProviderLimits.aggregateTimeoutMs),
    sleeps,
  };
}

function messageBody(
  result: unknown = { answer: 'Grounded answer.', citationIds: ['cite_allowed'] },
  overrides: Record<string, unknown> = {},
) {
  return {
    content: [
      {
        citations: null,
        text: JSON.stringify(result),
        type: 'text',
      },
    ],
    id: 'msg_offline',
    model: MODEL,
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: {
        ephemeral_1h_input_tokens: 10,
        ephemeral_5m_input_tokens: 20,
      },
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
      inference_geo: 'global',
      input_tokens: 100,
      output_tokens: 20,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

function apiError(status: number, type: string, message = `sensitive ${TEST_API_KEY}`): Response {
  return jsonResponse(
    {
      error: { message, type },
      request_id: `req_error_${status}`,
      type: 'error',
    },
    status,
    { 'request-id': `req_error_${status}` },
  );
}

function hasSchemaKeyword(value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasSchemaKeyword(item, keyword));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => key === keyword || hasSchemaKeyword(nested, keyword),
  );
}

function assertAnthropicTransportSchema(schema: Record<string, unknown>): void {
  for (const unsupported of [
    'maxItems',
    'maxLength',
    'maximum',
    'minItems',
    'minLength',
    'minimum',
    'pattern',
  ]) {
    assert.equal(
      hasSchemaKeyword(schema, unsupported),
      false,
      `${unsupported} must not be a transport-schema keyword.`,
    );
  }
}

function schemaKeywords(value: unknown, keywords = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) schemaKeywords(item, keywords);
    return keywords;
  }
  if (!value || typeof value !== 'object') return keywords;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    keywords.add(key);
    schemaKeywords(nested, keywords);
  }
  return keywords;
}

test('canonical schemas retain SkyOS constraints before Anthropic transport normalization', () => {
  const groundedKeywords = schemaKeywords(groundedAnswerResponseSchema);
  const summarySchema = knowledgeActionResponseSchema('knowledge_summary');
  assert.ok(summarySchema);
  const summaryKeywords = schemaKeywords(summarySchema);

  for (const keywords of [groundedKeywords, summaryKeywords]) {
    assert.equal(keywords.has('maxLength'), true);
    assert.equal(keywords.has('minLength'), true);
    assert.equal(keywords.has('maxItems'), true);
    assert.equal(keywords.has('additionalProperties'), true);
  }
  assert.equal(groundedAnswerResponseSchema.properties.answer.maxLength, 2_000);
  assert.equal(summarySchema.properties.summary.maxLength, 2_000);
});

function fakeFetch(handler: (request: Request, call: number) => Promise<Response> | Response): {
  calls: Request[];
  fetch: typeof globalThis.fetch;
} {
  const calls: Request[] = [];
  return {
    calls,
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request.clone());
      return handler(request, calls.length);
    }) as typeof globalThis.fetch,
  };
}

function provider(
  transport: typeof globalThis.fetch,
  clock: AnthropicProviderClock = fakeClock().clock,
  model = MODEL,
): AnthropicLanguageModelProvider {
  return new AnthropicLanguageModelProvider({
    apiKey: TEST_API_KEY,
    clock,
    fetch: transport,
    model,
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

test('measures the exact prepared Anthropic input through countTokens only', async () => {
  const transport = fakeFetch(() => jsonResponse({ input_tokens: 432 }));
  const adapter = provider(transport.fetch);
  assert.equal(adapter.inputTokenMeasurementAccounting, 'DOCUMENTED_NO_ADDITIONAL_CHARGE');
  const result = await adapter.measureInputTokens!(baseRequest, measurementIdentity);

  assert.equal(transport.calls.length, 1);
  const sent = transport.calls[0]!;
  assert.equal(new URL(sent.url).pathname, '/v1/messages/count_tokens');
  const body = JSON.parse(await sent.text()) as Record<string, unknown>;
  assert.equal(body.model, MODEL);
  assert.equal('max_tokens' in body, false);
  assert.equal('service_tier' in body, false);
  assert.equal((body.output_config as { format: { type: string } }).format.type, 'json_schema');
  const serialized = JSON.stringify(body);
  assert.ok(serialized.includes('Earlier question'));
  assert.ok(serialized.includes('Earlier grounded answer'));
  assert.ok(serialized.includes('SKYOS_UNTRUSTED_KNOWLEDGE_CONTEXT_V1'));
  assert.ok(serialized.includes(baseRequest.userMessage));
  assert.deepEqual(result, {
    identity: measurementIdentity,
    measurement: { inputTokens: 432, method: 'PROVIDER_COUNT_API', status: 'KNOWN' },
  });
});

test('Anthropic measurement rejects malformed counts, identity drift, and count failures safely', async () => {
  for (const input_tokens of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    const transport = fakeFetch(() => jsonResponse({ input_tokens }));
    await assert.rejects(
      provider(transport.fetch).measureInputTokens!(baseRequest, measurementIdentity),
      (error: unknown) =>
        error instanceof AiInputTokenMeasurementError &&
        error.code === 'input_token_measurement_invalid',
    );
  }

  const mismatch = fakeFetch(() => jsonResponse({ input_tokens: 1 }));
  await assert.rejects(
    provider(mismatch.fetch).measureInputTokens!(baseRequest, {
      ...measurementIdentity,
      providerKey: 'openai',
    }),
    (error: unknown) =>
      error instanceof AiInputTokenMeasurementError &&
      error.code === 'input_token_measurement_identity_mismatch',
  );
  assert.equal(mismatch.calls.length, 0);

  const failure = fakeFetch(() => apiError(500, 'api_error'));
  await assert.rejects(
    provider(failure.fetch).measureInputTokens!(baseRequest, measurementIdentity),
    (error: unknown) =>
      error instanceof AiInputTokenMeasurementError &&
      error.code === 'input_token_measurement_failed',
  );

  const cancelled = new AbortController();
  cancelled.abort();
  const timeout = fakeFetch(() => jsonResponse({ input_tokens: 1 }));
  await assert.rejects(
    provider(timeout.fetch).measureInputTokens!(baseRequest, measurementIdentity, {
      signal: cancelled.signal,
    }),
    (error: unknown) =>
      error instanceof AiInputTokenMeasurementError &&
      error.code === 'input_token_measurement_timeout',
  );
});

test('maps a stateless grounded Messages API request through the official SDK', async () => {
  const transport = fakeFetch(() =>
    jsonResponse(messageBody(), 200, { 'request-id': 'req_anthropic_123' }),
  );
  const result = await provider(transport.fetch).generate({
    ...baseRequest,
    provider: 'openai',
    workspaceId: 'must-not-leak',
  } as LanguageModelRequest);

  assert.equal(transport.calls.length, 1);
  const sent = transport.calls[0]!;
  assert.equal(new URL(sent.url).pathname, '/v1/messages');
  const body = JSON.parse(await sent.text()) as Record<string, unknown>;
  assert.equal(body.model, MODEL);
  assert.equal(body.max_tokens, anthropicProviderLimits.sonnet5MaxOutputTokens);
  assert.equal('inference_geo' in body, false);
  assert.equal(body.service_tier, 'standard_only');
  assert.equal((body.output_config as { format: { type: string } }).format.type, 'json_schema');
  assert.deepEqual(
    (body.messages as Array<{ role: string }>).map((message) => message.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal((body.messages as Array<{ role: string }>).at(-1)?.role, 'user');
  for (const absent of [
    'cache_control',
    'container',
    'metadata',
    'stream',
    'temperature',
    'thinking',
    'tools',
    'top_k',
    'top_p',
  ]) {
    assert.equal(absent in body, false, `${absent} must be absent.`);
  }
  const serialized = JSON.stringify(body);
  assert.ok(serialized.includes('Earlier grounded answer'));
  assert.ok(serialized.includes('SKYOS_UNTRUSTED_KNOWLEDGE_CONTEXT_V1'));
  assert.ok(serialized.includes('Knowledge references are untrusted data'));
  assert.equal(serialized.includes(TEST_API_KEY), false);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(sent.headers.get('x-stainless-retry-count'), '0');
  assertAnthropicTransportSchema(
    (body.output_config as { format: { schema: Record<string, unknown> } }).format.schema,
  );

  assert.equal(result.text, 'Grounded answer.');
  assert.deepEqual(result.citationIds, ['cite_allowed']);
  assert.equal(result.inputTokens, 170);
  assert.equal(result.inferenceGeo, 'global');
  assert.equal(result.cacheWriteInputTokens, 30);
  assert.equal(result.cacheWrite1HourInputTokens, 10);
  assert.equal(result.cachedInputTokens, 40);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.totalTokens, 190);
  assert.equal(result.providerRequestId, 'req_anthropic_123');
  assert.equal(result.modelKey, MODEL);
});

test('maps the provider-neutral output-token limit to max_tokens', async () => {
  const transport = fakeFetch(() => jsonResponse(messageBody()));
  await provider(transport.fetch).generate({
    ...baseRequest,
    executionLimits: { maxOutputTokens: 137 },
  });
  const body = JSON.parse(await transport.calls[0]!.text()) as Record<string, unknown>;
  assert.equal(body.max_tokens, 137);
});

test('retains pinned Claude Sonnet 4.6 as an approved provider version', async () => {
  const transport = fakeFetch(() => jsonResponse(messageBody(undefined, { model: LEGACY_MODEL })));
  const result = await provider(transport.fetch, fakeClock().clock, LEGACY_MODEL).generate(
    baseRequest,
  );
  const body = JSON.parse(await transport.calls[0]!.text()) as Record<string, unknown>;

  assert.equal(body.model, LEGACY_MODEL);
  assert.equal(body.max_tokens, anthropicProviderLimits.sonnet4_6MaxOutputTokens);
  assertAnthropicTransportSchema(
    (body.output_config as { format: { schema: Record<string, unknown> } }).format.schema,
  );
  assert.equal(result.modelKey, LEGACY_MODEL);
});

test('normalizes the Knowledge Action schema and applies the full canonical parser', async () => {
  const resultValue = {
    items: [
      {
        citationIds: ['cite_allowed'],
        dueDate: null,
        owner: null,
        task: 'Review the grounded runbook.',
      },
    ],
  };
  const transport = fakeFetch(() => jsonResponse(messageBody(resultValue)));
  const result = await provider(transport.fetch).generate({
    ...baseRequest,
    responseFormat: 'knowledge_action_items',
  });
  const body = JSON.parse(await transport.calls[0]!.text()) as {
    output_config: { format: { schema: Record<string, unknown> } };
  };

  assert.equal(result.text, 'Action items\n1. Review the grounded runbook.');
  assert.deepEqual(result.citationIds, ['cite_allowed']);
  assertAnthropicTransportSchema(body.output_config.format.schema);
  assert.equal(hasSchemaKeyword(body.output_config.format.schema, 'additionalProperties'), true);

  const oversized = fakeFetch(() =>
    jsonResponse(
      messageBody({
        items: [
          {
            citationIds: ['cite_allowed'],
            dueDate: null,
            owner: null,
            task: 'a'.repeat(2_001),
          },
        ],
      }),
    ),
  );
  await providerError(
    provider(oversized.fetch).generate({
      ...baseRequest,
      responseFormat: 'knowledge_action_items',
    }),
    'provider_output_invalid',
  );
});

test('constructs a normalized structured Summarize request without conflicting features', async () => {
  const transport = fakeFetch(() =>
    jsonResponse(
      messageBody({
        keyPoints: [{ citationIds: ['cite_allowed'], point: 'Bounded evidence.' }],
        summary: 'SkyOS uses bounded evidence.',
        summaryCitationIds: ['cite_allowed'],
      }),
    ),
  );
  const result = await provider(transport.fetch).generate({
    ...baseRequest,
    history: [],
    responseFormat: 'knowledge_summary',
  });
  const body = JSON.parse(await transport.calls[0]!.text()) as Record<string, unknown>;
  const messages = body.messages as Array<{ content: unknown; role: string }>;
  const schema = (body.output_config as { format: { schema: Record<string, unknown> } }).format
    .schema;

  assert.equal(body.model, MODEL);
  assert.equal(body.max_tokens, anthropicProviderLimits.sonnet5MaxOutputTokens);
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user'],
  );
  assert.equal(messages.at(-1)?.role, 'user');
  assert.equal(typeof messages.at(-1)?.content, 'string');
  assert.equal('output_config' in body, true);
  for (const absent of [
    'citations',
    'inference_geo',
    'temperature',
    'thinking',
    'tools',
    'top_k',
    'top_p',
  ]) {
    assert.equal(absent in body, false, `${absent} must be absent.`);
  }
  assertAnthropicTransportSchema(schema);
  assert.equal(
    result.text,
    'Summary\nSkyOS uses bounded evidence.\n\nKey points\n- Bounded evidence.',
  );
  assert.deepEqual(result.citationIds, ['cite_allowed']);
});

test('preserves missing usage and rejects ambiguous cache-write breakdowns for pricing', async () => {
  const missingTransport = fakeFetch(() =>
    jsonResponse(messageBody(undefined, { usage: undefined })),
  );
  const missing = await provider(missingTransport.fetch).generate(baseRequest);
  assert.equal(missing.inputTokens, undefined);
  assert.equal(missing.cacheWriteInputTokens, undefined);
  assert.equal(missing.cacheWrite1HourInputTokens, undefined);
  assert.equal(missing.cachedInputTokens, undefined);
  assert.equal(missing.outputTokens, undefined);
  assert.equal(missing.totalTokens, undefined);

  const ambiguousTransport = fakeFetch(() =>
    jsonResponse(
      messageBody(undefined, {
        usage: {
          cache_creation: null,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
          input_tokens: 100,
          output_tokens: 20,
        },
      }),
    ),
  );
  const ambiguous = await provider(ambiguousTransport.fetch).generate(baseRequest);
  assert.equal(ambiguous.inputTokens, 170);
  assert.equal(ambiguous.cacheWriteInputTokens, 30);
  assert.equal(ambiguous.cacheWrite1HourInputTokens, undefined);
});

test('normalizes authentication, billing, rate-limit, and provider errors safely', async () => {
  const cases: readonly [number, string, string, boolean, number][] = [
    [400, 'invalid_request_error', 'provider_request_invalid', false, 1],
    [401, 'authentication_error', 'provider_authentication_failed', false, 1],
    [402, 'billing_error', 'provider_quota_exhausted', false, 1],
    [403, 'permission_error', 'provider_permission_denied', false, 1],
    [404, 'not_found_error', 'provider_model_unavailable', false, 1],
    [429, 'rate_limit_error', 'provider_rate_limited', true, 3],
    [500, 'api_error', 'provider_unavailable', true, 3],
    [504, 'timeout_error', 'provider_timeout', true, 3],
    [529, 'overloaded_error', 'provider_unavailable', true, 3],
  ];
  for (const [status, type, code, retryable, calls] of cases) {
    const transport = fakeFetch(() => apiError(status, type));
    const error = await providerError(provider(transport.fetch).generate(baseRequest), code);
    assert.equal(error.retryable, retryable);
    assert.equal(error.status, status);
    assert.equal(error.providerRequestId, `req_error_${status}`);
    assert.equal(error.message.includes(TEST_API_KEY), false);
    assert.equal(error.message.includes(baseRequest.context), false);
    assert.equal(transport.calls.length, calls);
  }
});

test('classifies Anthropic 400 diagnostics without exposing provider messages', async () => {
  const cases = [
    ['output_config.format.schema contains unsupported maxLength', 'anthropic_invalid_schema'],
    ['temperature is not supported for this model', 'anthropic_sampling_parameter_invalid'],
    [
      'assistant prefill is incompatible with structured output',
      'anthropic_structured_output_conflict',
    ],
    ['max_tokens is an invalid parameter', 'anthropic_invalid_parameter'],
    ['private provider detail', 'anthropic_unknown_invalid_request'],
  ] as const;
  for (const [providerMessage, diagnosticCode] of cases) {
    const transport = fakeFetch(() => apiError(400, 'invalid_request_error', providerMessage));
    const error = await providerError(
      provider(transport.fetch).generate(baseRequest),
      'provider_request_invalid',
    );
    assert.equal(error.providerDiagnosticCode, diagnosticCode);
    assert.equal(error.message.includes(providerMessage), false);
    assert.equal(error.message.includes(TEST_API_KEY), false);
  }
});

test('sanitizes request IDs and rejects malformed, truncated, refused, or mismatched output', async () => {
  const unsafeId = fakeFetch(() =>
    jsonResponse(messageBody(), 200, { 'request-id': 'unsafe request id value' }),
  );
  assert.equal((await provider(unsafeId.fetch).generate(baseRequest)).providerRequestId, undefined);

  const cases: readonly [unknown, Record<string, unknown>, string][] = [
    [{ answer: ' ', citationIds: [] }, {}, 'provider_output_invalid'],
    [
      { answer: 'Truncated', citationIds: [] },
      { stop_reason: 'max_tokens' },
      'provider_output_incomplete',
    ],
    [{ answer: 'Refused', citationIds: [] }, { stop_reason: 'refusal' }, 'provider_refused'],
    [
      { answer: 'Wrong model', citationIds: [] },
      { model: LEGACY_MODEL },
      'provider_model_mismatch',
    ],
    [
      { answer: 'Unexpected tool', citationIds: [] },
      { content: [{ id: 'tool_1', input: {}, name: 'unexpected', type: 'tool_use' }] },
      'provider_output_invalid',
    ],
  ];
  for (const [result, overrides, code] of cases) {
    const transport = fakeFetch(() => jsonResponse(messageBody(result, overrides)));
    await providerError(provider(transport.fetch).generate(baseRequest), code);
    assert.equal(transport.calls.length, 1);
  }

  const oversized = fakeFetch(() =>
    jsonResponse(messageBody({ answer: 'a'.repeat(2_001), citationIds: [] })),
  );
  await providerError(provider(oversized.fetch).generate(baseRequest), 'provider_output_invalid');
});

test('SkyOS owns bounded retries and one aggregate deadline', async () => {
  const timing = fakeClock(0.5);
  const transport = fakeFetch((_request, call) =>
    call === 1 ? apiError(529, 'overloaded_error') : jsonResponse(messageBody()),
  );
  const result = await provider(transport.fetch, timing.clock).generate(baseRequest);
  assert.equal(result.attemptCount, 2);
  assert.deepEqual(timing.sleeps, [125]);
  assert.deepEqual(
    transport.calls.map((request) => request.headers.get('x-stainless-retry-count')),
    ['0', '0'],
  );

  const deadlineTiming = fakeClock();
  const hanging = fakeFetch(
    (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
  const pending = provider(hanging.fetch, deadlineTiming.clock).generate(baseRequest);
  for (let index = 0; index < 5 && hanging.calls.length === 0; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  deadlineTiming.expire();
  const timeout = await providerError(pending, 'provider_timeout');
  assert.equal(timeout.retryable, true);
  assert.equal(hanging.calls.length, 1);
});

test('automated environments cannot accidentally use the real Anthropic transport', () => {
  assert.throws(
    () =>
      new AnthropicLanguageModelProvider({
        apiKey: TEST_API_KEY,
        model: MODEL,
        runtime: 'test',
      }),
    (error: unknown) =>
      error instanceof LanguageModelProviderError && error.code === 'provider_network_disabled',
  );
  for (const configuration of [
    { apiKey: TEST_API_KEY, model: 'claude-sonnet-4-5' },
    { apiKey: '   ', model: MODEL },
    { apiKey: '<server-secret>', model: MODEL },
  ]) {
    assert.throws(
      () =>
        new AnthropicLanguageModelProvider({
          ...configuration,
          fetch: fakeFetch(() => jsonResponse(messageBody())).fetch,
          runtime: 'test',
        }),
      (error: unknown) =>
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid',
    );
  }
});

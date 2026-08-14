# ADR 0005: Google Gemini language-model execution backend

- Status: Accepted
- Date: 2026-08-14
- Supersedes: none
- Complements: [ADR 0003](./0003-production-language-model-provider.md) and [ADR 0004](./0004-anthropic-language-model-provider.md)

## Context

SkyOS owns authorization, tenant scope, Knowledge retrieval, immutable document-version grounding, citation snapshots and allowlisting, conversation state, persistence, and usage/cost telemetry. Providers are execution backends for a future SkyOS orchestration layer, not user-selectable products. A future solver, critic, verifier, or synthesizer may receive the same SkyOS-approved `GroundedContext`, but every execution remains one independently attributed `AiRun`.

Google recommends the generally available Interactions API for new Gemini integrations. Unlike SkyOS, that API stores interactions by default and can provide provider-side continuation, background work, tools, retrieval, and grounding. Those capabilities would duplicate or weaken SkyOS-owned boundaries unless explicitly disabled.

## Decision

Gemini is the third first-class `LanguageModelProvider`. The current approved identity is `gemini / gemini-3.6-flash / interactions-json-schema-v1`. SkyOS uses the official `@google/genai` TypeScript SDK and the synchronous Interactions `create` operation rather than legacy `generateContent`.

Deployment configuration is server-owned:

```text
AI_PROVIDER=gemini
AI_MODEL=gemini-3.6-flash
GEMINI_API_KEY=<server-secret>
```

The browser cannot select a provider. Missing, blank, placeholder, or unapproved configuration fails closed. Non-production execution requires an injected offline client, so tests, builds, and CI cannot accidentally make paid calls.

## Stateless privacy boundary

Every request explicitly sets `store: false`. SkyOS sends no `previous_interaction_id`, background execution, agent, environment, webhook, file, URL Context, Google Search, Google Maps, File Search, code execution, Computer Use, function, or other tool configuration. It requests no provider-native citations, grounding, thought summaries, or reasoning content.

SkyOS remains authoritative for conversation history, retrieval, Knowledge, immutable source selection, citation IDs, tenant permissions, persistence, and final routing policy. Gemini receives only a bounded JSON-encoded history/current-request/context package prepared by SkyOS. The package remains untrusted data under a server-owned system instruction.

Gemini 3.6 Flash keeps its supported default thinking behavior. SkyOS sends no deprecated `temperature`, `top_p`, or `top_k`, and does not set a thinking level. A 16,000-token output ceiling bounds combined model work while canonical application validation keeps visible structured fields within 2,000 characters. Provider thoughts and thought summaries are never exposed or persisted.

## Structured output and grounding

Grounded chat and all four Knowledge Actions use the existing canonical SkyOS schemas. Gemini receives a top-level text `response_format` with `application/json`. Its provider-local transport normalization removes only `minLength` and `maxLength`, which are outside the documented Gemini structured-output subset used here; strict object shapes, required fields, nullable type arrays, and item bounds remain. Returned JSON is parsed again with the full canonical SkyOS validators, including the 2,000-character rule.

Gemini-returned citation IDs are only candidates. Shared persistence intersects them with the exact retrieval/direct-version snapshot and removes fabricated or duplicate IDs. Direct Knowledge Actions stay pinned to one immutable `KnowledgeDocumentVersion`; Gemini cannot broaden source scope or invoke workspace retrieval.

## Usage, correlation, and pricing

The Interactions response's unique interaction `id` may populate `providerRequestId` only when it passes SkyOS's bounded safe-identifier validation. Headers and raw payloads are never persisted.

Gemini usage maps as follows:

| Interactions usage field | SkyOS field         |
| ------------------------ | ------------------- |
| `total_input_tokens`     | `inputTokens`       |
| `total_cached_tokens`    | `cachedInputTokens` |
| `total_output_tokens`    | `outputTokens`      |
| `total_thought_tokens`   | `reasoningTokens`   |

`totalTokens` is the provider-neutral sum of input, visible output, and separately reported thoughts. Tool-use tokens are rejected because tools are disabled. Missing or inconsistent usage remains nullable and failed requests never invent usage.

The dated application-owned catalog records Gemini 3.6 Flash Standard rates verified on 2026-08-14: `$1.50` input, `$0.15` cached input, and `$7.50` output including thought tokens per million. Visible output and thought counts are separately multiplied by the same output rate, so thoughts are billed exactly once. SkyOS creates no explicit context cache and does not estimate cache-storage charges. Ambiguous or incomplete billing inputs produce a null cost.

## Reliability and safe failures

SDK retries are disabled with `maxRetries: 0`, and SkyOS passes its aggregate-deadline abort signal through `fetchOptions.signal`. SkyOS owns at most two automatic retries inside one 45-second aggregate deadline. Transient 408, 409, 429, network, and 5xx failures are eligible; terminal configuration, authorization, model, request, and output failures are not.

| Gemini condition                           | SkyOS code                       |
| ------------------------------------------ | -------------------------------- |
| 400/422                                    | `provider_request_invalid`       |
| 401                                        | `provider_authentication_failed` |
| 403                                        | `provider_permission_denied`     |
| 404                                        | `provider_model_unavailable`     |
| 408/504                                    | `provider_timeout`               |
| 409                                        | `provider_conflict`              |
| explicit prepaid/billing-credit exhaustion | `provider_quota_exhausted`       |
| other 429 `RESOURCE_EXHAUSTED`             | `provider_rate_limited`          |
| 5xx                                        | `provider_unavailable`           |
| network failure                            | `provider_connection_failed`     |
| malformed or schema-invalid output         | `provider_output_invalid`        |

Because Google 429 quota language can represent transient request quotas as well as billing state, SkyOS classifies quota exhaustion only when the SDK error explicitly identifies prepaid or billing-credit depletion. Other 429 responses remain retryable rate limits. Only allowlisted diagnostics are retained in memory; raw Google messages, payloads, headers, and credentials are not persisted or exposed.

## Orchestration consequences

The provider registry can retain OpenAI, Anthropic, and Gemini peer identities while `getCurrent()` continues to represent one deployment-selected backend. Registration does not implement fallback, voting, routing, consensus, parallel spend, or synthesis. A future orchestrator must create one `AiRun` per provider execution and a distinct synthesis run, preserving each run's provider, model, usage, cost, failure, and citations.

## Consequences and limitations

- OpenAI and Anthropic behavior remain unchanged.
- CI uses mocked transports and needs no Gemini credential.
- No live Gemini request, evaluator, provider selector, orchestration, fallback, streaming, explicit context caching, or native tool is added.
- Production enablement still requires current model lifecycle, pricing, privacy/retention, residency, contract, quota, and grounded-quality review.

## Official sources

Verified on 2026-08-14:

- [Interactions API overview and storage controls](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Interactions migration and structured-output request shape](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)
- [Structured output and supported JSON Schema subset](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini model guidance](https://ai.google.dev/gemini-api/docs/latest-model)
- [Thinking and thought-token billing](https://ai.google.dev/gemini-api/docs/thinking)
- [Context caching](https://ai.google.dev/gemini-api/docs/caching)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [API errors and retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting)
- [Official TypeScript SDK](https://github.com/googleapis/js-genai)

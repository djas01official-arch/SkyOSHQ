# ADR 0004: Anthropic language-model execution backend

- Status: Accepted
- Date: 2026-08-13
- Supersedes: none
- Complements: [ADR 0003](./0003-production-language-model-provider.md)

## Context

SkyOS already owns authorization, tenant scope, Knowledge retrieval, immutable direct-version grounding, citation snapshots, citation allowlisting, conversation state, run persistence, and usage/cost telemetry. ADR 0003 selected OpenAI as the first production adapter; it explicitly allowed a later provider only through a new architecture decision.

The product direction is not an end-user provider selector. SkyOS will eventually be able to prepare one grounded evidence package and give independent provider runs roles such as solver, critic, verifier, and synthesizer. Each execution must remain traceable, scoped, and separately metered.

## Decision

Anthropic is the second first-class `LanguageModelProvider` implementation. The approved backend is the first-party Claude API with the official `@anthropic-ai/sdk` TypeScript package. The pinned `claude-sonnet-5` model is the current default because Anthropic recommends it as the strongest current Sonnet balance of speed and intelligence and describes it as a drop-in upgrade from Sonnet 4.6. The pinned `claude-sonnet-4-6` model remains independently approved for regression and future orchestration experiments; neither identifier is treated as an evergreen alias.

The adapter uses the stateless synchronous Messages API at `POST /v1/messages`. It sends bounded SkyOS history and the exact SkyOS-created grounded context, uses the top-level system prompt, requests stable schema-constrained JSON through `output_config.format`, selects standard-only service tier, and configures no tools, cache control, containers, files, hosted retrieval, provider conversation state, or native citation authority. It does not override `inference_geo`; the Anthropic workspace's server-side default and allowed-geo policy remain authoritative. The adapter retains the sanitized provider-reported geo for pricing eligibility without exposing it to clients.

The browser cannot choose Anthropic. Deployment configuration selects `AI_PROVIDER=anthropic`, `AI_MODEL=claude-sonnet-5`, and a server-only `ANTHROPIC_API_KEY`. Invalid, placeholder, missing, and unapproved configuration fails closed. Automated environments require an injected transport and cannot accidentally use the network. The registry retains both approved pinned model/policy identities, but only the explicitly configured model is current; retention does not implement fallback or orchestration.

Sonnet 5 enables adaptive thinking by default and rejects manual extended-thinking configuration and non-default `temperature`, `top_p`, or `top_k` values. SkyOS sends none of those fields, so it preserves the provider's supported default while avoiding invalid or sampling-dependent requests. The adapter already accepts provider thinking/redacted-thinking blocks but extracts only the final schema-constrained text. Because thinking tokens share the `max_tokens` ceiling with the final response, Sonnet 5 receives a hard 16,000-token ceiling while Sonnet 4.6 retains the existing 1,200-token ceiling; both still pass through the same 2,000-character schema/parser bound. Sonnet 5's tokenizer differs from Sonnet 4.6; SkyOS does not estimate Anthropic usage locally and instead persists the authoritative token counts returned by the Messages API. Apart from the explicit pinned model identifier and model-appropriate token ceiling, SkyOS constructs the same bounded, stateless request for both approved versions.

## Grounding and structured output

SkyOS response schemas remain provider-independent and are the canonical application contract. The Anthropic adapter passes each canonical schema through the official SDK's provider-local `jsonSchemaOutputFormat()` transformation before placing it in `output_config.format`. The transport schema therefore omits unsupported constrained-decoding keywords while preserving strict object shapes. After decoding, the existing SkyOS parser validates the response against the complete canonical field, item-count, 2,000-character, nullable-field, and shape contract. Provider transport compatibility never weakens application validation or makes the business schema Anthropic-specific.

Normal chat returns `{ answer, citationIds }`. Knowledge actions use the same summary, action-item, risk, and decision schemas as OpenAI. The provider receives only opaque candidate citation ids already present in its context. The shared persistence service intersects returned ids with the exact snapshot allowlist and discards fabricated or duplicated ids.

Anthropic does not authorize, retrieve, broaden, or persist Knowledge. Direct-version actions remain pinned to one immutable version, while normal chat continues through authorized workspace retrieval.

## Reliability and safe failures

The official SDK retry loop is disabled. SkyOS permits at most two automatic retries (three attempts total) inside one 45-second aggregate deadline, with capped exponential full-jitter backoff. Connection failures, 408, 409, 429, 5xx, 504, and 529 are retryable. Invalid requests, authentication, billing, permission, model-not-found, refusals, incomplete output, model mismatch, and invalid structured output are not retried.

Provider errors map into the existing neutral taxonomy:

| Anthropic condition | SkyOS code                       |
| ------------------- | -------------------------------- |
| 400/413/422         | `provider_request_invalid`       |
| 401                 | `provider_authentication_failed` |
| 402 `billing_error` | `provider_quota_exhausted`       |
| 403                 | `provider_permission_denied`     |
| 404                 | `provider_model_unavailable`     |
| 408/504             | `provider_timeout`               |
| 409                 | `provider_conflict`              |
| 429                 | `provider_rate_limited`          |
| 500/529/other 5xx   | `provider_unavailable`           |
| network failure     | `provider_connection_failed`     |

Only sanitized `request-id` values may enter `AiRun.providerRequestId`. For HTTP 400 responses, the adapter may derive an in-memory, allowlisted diagnostic category (`anthropic_invalid_schema`, `anthropic_invalid_parameter`, `anthropic_structured_output_conflict`, `anthropic_sampling_parameter_invalid`, or `anthropic_unknown_invalid_request`) from the provider message. The public failure remains `provider_request_invalid`; the raw message and derived diagnostic are not persisted. Raw errors, request/response bodies, headers, credentials, and provider messages are not persisted or exposed.

## Usage and cost

Anthropic defines total input as `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. The adapter maps that sum to SkyOS `inputTokens`, maps cache creation to the existing total cache-write field, maps cache reads to cached input, and stores the reported one-hour cache-write subset separately. `totalTokens` is derived from total input plus authoritative output tokens.

The dated central price catalog uses Claude Sonnet 4.6 global standard rates verified on 2026-08-13:

- input: $3.00 per million tokens;
- five-minute cache write: $3.75 per million tokens;
- one-hour cache write: $6.00 per million tokens;
- cache read/hit: $0.30 per million tokens; and
- output: $15.00 per million tokens.

For Claude Sonnet 5, the catalog records two non-overlapping effective periods verified on the same date. Through 2026-08-31 UTC the per-million rates are `$2` input, `$2.50` five-minute cache write, `$4` one-hour cache write, `$0.20` cache read, and `$10` output. Beginning 2026-09-01 UTC they are `$3`, `$3.75`, `$6`, `$0.30`, and `$15`, respectively. `AiRun.createdAt` is the immutable effective-time input, so a historical run always resolves to the same price period and is never retroactively repriced with the current rate.

SkyOS does not enable cache control in this adapter, but it accurately accepts provider-reported cache telemetry. If cache creation is reported without the TTL breakdown required to price it, cost remains null. The catalog entries cover global standard inference only, so missing or US-only provider-reported inference geo leaves cost null rather than applying the wrong rate. Priority, Batch, taxes, contracts, retries, and other pricing modes are not estimated.

## Orchestration consequences

The provider registry can retain multiple unique provider/model/policy versions while preserving `getCurrent()` for today's deployment-selected path. Registration alone does not invoke fallback, parallel calls, synthesis, or extra spend.

A future orchestration engine must create one `AiRun` per provider execution, reuse the same authorized grounded context where required, preserve independent failures and telemetry, and create a distinct synthesis run if synthesis is requested. It must not merge provider state or treat one provider's citations as authority for another.

## Consequences and limitations

- OpenAI behavior and the normal user experience remain unchanged.
- Anthropic gains the same grounded chat and Knowledge Action boundary without duplicating domain logic.
- CI and tests remain credential-free and use mocked SDK transports.
- There is no automatic fallback, provider picker, live Anthropic evaluator, streaming, prompt caching, or multi-model orchestrator yet.
- Production enablement still requires contract, privacy, retention, residency, model-lifecycle, capacity, and current pricing review.

## Official sources

All sources were verified on 2026-08-13:

- [Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)
- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [What's new in Sonnet 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5)
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [API errors and request IDs](https://platform.claude.com/docs/en/api/errors)
- [Rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- [Official TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)

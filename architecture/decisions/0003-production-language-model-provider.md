# ADR 0003: OpenAI for the first production language-model adapter

- Status: accepted
- Date: 2026-08-11

## Context

SkyOS AI Chat is already implemented against an application-owned
`LanguageModelProvider` contract. Development and tests use a deterministic local
provider. Production deliberately resolves to an unavailable provider until a
production adapter is approved.

SkyOS owns authentication, workspace authorization, conversation persistence,
Knowledge retrieval, citation allowlisting, run persistence, retry semantics,
auditability, and user-facing errors. A language-model provider is inference
transport, not a source of tenancy or persistence authority. The first production
provider must therefore adapt to SkyOS instead of moving SkyOS state into a vendor
conversation, file, or vector-store product.

This decision compares current first-party OpenAI, Anthropic, and Google offerings.
All provider documentation and pricing cited here was accessed on **2026-08-11**.
Capabilities, model names, policies, and prices require verification again before
implementation and launch.

## Existing SkyOS constraints

### SkyOS domain contract

The operative contract is `services/ai/language-model-provider.ts`:

- A request contains a bounded `userMessage`, ordered prior `history` entries with
  only `user` or `assistant` roles, a serialized untrusted Knowledge `context`, and
  retrieved citation objects containing an opaque `citationId` and text.
- A response contains assistant `text`, candidate `citationIds`, and optional
  `inputTokens` and `outputTokens`.
- Provider identity is trusted server configuration in a descriptor:
  `providerKey`, `modelKey`, `modelVersion`, `maxInputCharacters`,
  `maxOutputCharacters`, and `timeoutMs`.
- Generation accepts an optional `AbortSignal`.
- Failures cross the boundary as `LanguageModelProviderError` with a safe code and
  an explicit `retryable` flag. Vendor response objects and unsafe messages must not
  escape the adapter.
- The provider registry contains one selected provider. `AI_PROVIDER=local` is
  permitted only outside production. Production remains unavailable when a valid
  production provider is not configured.
- The deterministic provider produces a stable grounded placeholder response,
  returns only citation identifiers that were supplied, estimates tokens from
  characters, honors cancellation, and can simulate a typed retryable failure.
- The domain service, not the provider, creates the user message and `AiRun`, applies
  authorization and throttling, performs retrieval, persists success or failure,
  and creates a new run rather than a duplicate message for a user-requested retry.

The Knowledge context is a bounded JSON payload inside explicit
`BEGIN_UNTRUSTED_KNOWLEDGE_JSON` and `END_UNTRUSTED_KNOWLEDGE_JSON` markers. Citation
identifiers are deterministic opaque references to authorized retrieval results.
The domain service intersects returned identifiers with the captured retrieval
allowlist before persistence, so fabricated identifiers are already discarded.

### Provider-specific concerns

A production adapter alone is responsible for:

- mapping SkyOS instructions, history, untrusted context, and the current message
  into the selected API request;
- selecting only an approved server-configured model and bounded output settings;
- disabling vendor persistence and hosted retrieval features;
- authenticating from a server-only secret;
- applying the bounded transport retry and cancellation policy below;
- parsing text, structured citation references, usage, finish state, request IDs,
  refusals, and errors into SkyOS-normalized values; and
- ensuring provider-specific types never cross the provider boundary.

No provider requires a change to SkyOS authorization, retrieval, conversation,
citation, or durable retry semantics.

## Decision drivers

In priority order:

1. reliable grounded enterprise chat and instruction following;
2. citation/reference discipline without transferring retrieval authority;
3. stateless operation and documented commercial data controls;
4. an explicit path to EEA regional processing;
5. stable Node.js/TypeScript integration, cancellation, typed errors, usage, and
   request IDs;
6. reasonable latency and cost for ordinary interactive chat;
7. a stable, non-preview production model with sufficient context; and
8. preservation of the existing provider interface and deterministic test path.

Streaming, vendor-hosted retrieval, and provider-managed conversations are not
requirements for this release.

## Considered options

1. OpenAI API: Responses API with GPT-5.6 Terra.
2. Anthropic API: Messages API with Claude Sonnet 5.
3. Google Gemini Developer API: Interactions API with Gemini 3.6 Flash. Vertex AI,
   now documented as part of the Gemini enterprise offering, is evaluated as a
   separate enterprise deployment path rather than being conflated with the
   Developer API.

## Comparison matrix

| Criterion                       | OpenAI                                                                                                                                                                                                                                                                                                 | Anthropic                                                                                                                                                                             | Google Gemini Developer API                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate model                 | `gpt-5.6-terra`, current balanced production model; 1.05M context, 128K max output                                                                                                                                                                                                                     | `claude-sonnet-5`, current Sonnet production model; 1M context, 128K max output                                                                                                       | `gemini-3.6-flash`, stable GA model; about 1M context, 65,536 max output                                                                                                                                                            |
| Text and multi-turn API         | Responses API; SkyOS may resend its own history and set `store: false`                                                                                                                                                                                                                                 | Messages API is explicitly stateless and requires the full history on each request                                                                                                    | Interactions API is the current recommended surface, but stores state by default; stateless use requires `store: false`                                                                                                             |
| Instruction and output controls | Developer/system instructions, bounded `max_output_tokens`, structured outputs                                                                                                                                                                                                                         | Top-level system instructions, bounded `max_tokens`, structured outputs                                                                                                               | System instructions, bounded output, structured outputs                                                                                                                                                                             |
| Usage and finish data           | Input, output, total, cached/reasoning breakdowns, response status/incomplete details                                                                                                                                                                                                                  | Input and output usage plus cache/thinking details and explicit `stop_reason`; total can be derived                                                                                   | Prompt, candidate, total, cached/thinking usage metadata and structured finish/block reasons                                                                                                                                        |
| SDK and operations              | Official TypeScript SDK, typed errors, request ID, configurable timeout and retries, streaming                                                                                                                                                                                                         | Official TypeScript SDK, typed errors, request ID, configurable timeout and retries, streaming                                                                                        | Official `@google/genai` TypeScript SDK, timeout/abort and retry configuration, streaming                                                                                                                                           |
| RAG fit                         | Strong. SkyOS can send bounded text and opaque citation IDs without OpenAI File Search, Conversations, or vector stores                                                                                                                                                                                | Strong and naturally stateless; no hosted state is needed                                                                                                                             | Strong for supplied context, but hosted Search/File features are unnecessary and disabled                                                                                                                                           |
| Training default                | API data is not used to train unless the customer opts in                                                                                                                                                                                                                                              | Commercial API inputs/outputs are not used to train by default                                                                                                                        | Paid Services prompts/responses are not used to improve products; free-tier treatment is different and therefore prohibited for production                                                                                          |
| Default retention               | Abuse-monitoring logs may contain content and are retained up to 30 days. Responses application state is retained at least 30 days by default; `store: false` avoids that application-state path                                                                                                       | API inputs/outputs are deleted within 30 days by default, subject to usage-policy, legal, or negotiated exceptions                                                                    | Paid Services log prompts/responses for a limited period for abuse detection; the public terms do not state a single numeric default. Interactions stores state unless `store: false`; implicit in-memory caching has a 24-hour TTL |
| Enhanced retention controls     | Approved customers may receive Modified Abuse Monitoring or ZDR. Under ZDR, Responses `store` is forced false. Some features remain ineligible                                                                                                                                                         | Enterprise API customers may obtain a ZDR agreement; Files, some caching/batch features, beta products, and third parties have exceptions                                             | Project approval can sanitize user content and identifiable metadata before abuse logging. Search/Maps grounding, files, explicit caching, and some stateful features prevent a zero-data footprint                                 |
| Data residency                  | OpenAI documents platform support for European regional storage and processing through `eu.api.openai.com`; non-US regions require approved abuse controls and a ZDR amendment. Eligibility of the exact selected Responses model identifier or snapshot must be verified separately before deployment | Processing may occur in the US, Europe, Asia, and Australia, while storage remains US-only by default unless otherwise agreed. No public self-service EEA storage guarantee was found | Developer API country availability is not a processing/storage residency guarantee. Selectable data location and enterprise governance are documented for the separate Google Cloud/Vertex enterprise path                          |
| Security controls               | Server API keys, projects, service accounts/roles, usage controls, request IDs, DPA, public status page                                                                                                                                                                                                | Server API keys, workspaces/organizations, request IDs, commercial processor posture, public status page                                                                              | Project-bound keys, migration to service-account-bound authorization keys, Cloud secret-management compatibility, Cloud usage/health tooling                                                                                        |
| Reliability behavior            | Typed 4xx/5xx and connection errors; SDK retries connection, 408, 409, 429, and 5xx twice by default                                                                                                                                                                                                   | Structured error types including 429, 500, 504, and 529; SDK retries transient failures twice by default and honors `retry-after`                                                     | Structured error codes; official guidance recommends exponential backoff for 408, 429, and 5xx. SDK retry behavior is configurable                                                                                                  |
| Structured/streaming future     | Both supported; not enabled for streaming in v1                                                                                                                                                                                                                                                        | Both supported; not enabled for streaming in v1                                                                                                                                       | Both supported; not enabled for streaming in v1                                                                                                                                                                                     |
| Main disadvantage               | `store: false` must be explicit; default abuse logs remain up to 30 days without approved controls; regional processing has eligibility and price implications                                                                                                                                         | Default storage is US-only and ZDR/residency improvements require negotiated terms; current Sonnet pricing is temporarily discounted and its tokenizer changed                        | Direct Developer API residency is not equivalent to Vertex enterprise residency; its newest Interactions API stores by default, adding another configuration hazard                                                                 |

No public status page is treated as an SLA. Standard-tier latency and availability
must be measured with SkyOS traffic; contractual SLA or provisioned throughput is a
later commercial decision.

## Decision

SkyOS will implement **one production provider: OpenAI**.

The first adapter will use the **Responses API** with **GPT-5.6 Terra**. OpenAI ranks
first because its current balanced model is suitable for ordinary enterprise chat,
the Responses API and official TypeScript SDK map cleanly to the existing contract,
and the same provider documents a concrete platform path to both stateless
processing and European regional processing, subject to separate verification that
the exact selected model is eligible. The choice is for the first implementation,
not permanent vendor lock-in: the application-owned `LanguageModelProvider`
interface remains the port for later adapters.

Candidate ranking:

1. **OpenAI Responses API with GPT-5.6 Terra**
2. **Anthropic Messages API with Claude Sonnet 5**
3. **Gemini Developer Interactions API with Gemini 3.6 Flash**

There will be no automatic fallback provider in v1. Fallback would silently change
privacy, residency, model behavior, citation behavior, pricing, and failure
semantics. A second provider requires a separate ADR and explicit tenant/product
policy.

## Selected API

The adapter will call `/v1/responses` synchronously and non-streaming for v1. Current
OpenAI guidance identifies the Responses API as the primary API and recommends it
for new multi-turn workflows. It is preferred over Chat Completions because it is
the current first-class API, exposes structured output and richer normalized usage,
and provides the forward path for streaming without requiring a new SkyOS domain
contract.

Every request must:

- set `store: false` explicitly;
- omit `conversation` and `previous_response_id`;
- avoid background mode, file uploads, File Search, Web Search, vector stores,
  remote MCP, Code Interpreter, and other provider tools;
- resend only the bounded visible history owned by SkyOS;
- use current-turn reasoning only rather than persisted provider reasoning;
- supply a developer instruction that treats the Knowledge block as untrusted data;
- cap output server-side; and
- request a small structured result containing assistant text and candidate opaque
  citation IDs.

OpenAI response IDs are operational correlation identifiers only. They must never
become SkyOS conversation, message, run, workspace, or citation identifiers.

## Selected model and model policy

The initial approved model is `gpt-5.6-terra`, using standard processing and low
reasoning effort as the evaluation baseline. OpenAI describes Terra as the balance
of intelligence and cost in the GPT-5.6 family. The Sol tier is unnecessarily
expensive for every ordinary chat, while Luna should be considered only after
SkyOS-specific evaluations demonstrate equivalent grounding and citation quality.

Configuration is trusted and server-only:

```text
AI_PROVIDER=openai
AI_MODEL=gpt-5.6-terra
OPENAI_API_KEY=<secret-manager reference>
```

`AI_PROVIDER` and `AI_MODEL` are validated against a compiled server-side allowlist;
clients cannot override them. Use a dated immutable GPT-5.6 Terra snapshot if OpenAI
officially exposes one at implementation time. Otherwise use the explicitly approved
`gpt-5.6-terra` model ID. Never silently switch to the general `gpt-5.6` alias, and
do not invent a snapshot identifier. Every model identifier change is a controlled
configuration upgrade requiring an evaluation, changelog review, cost review, and
deliberate rollout. Persist both the configured identifier and the model identifier
returned by the provider where available.

## Data processing and retention posture

### Required technical posture

- Production uses a paid API project. Free, playground, and consumer product terms
  are not acceptable substitutes.
- Requests are stateless. Provider-side persistent conversation storage is disabled
  with `store: false`; provider Conversations are prohibited.
- SkyOS does not use provider files, vector stores, background responses, explicit
  prompt caching, or provider-hosted retrieval in v1.
- SkyOS does not opt in prompts, outputs, or feedback for model improvement.
- The applicable OpenAI Services Agreement and DPA, subprocessor list, security
  review, and SkyOS privacy notice must be approved before real customer traffic.

OpenAI states that API content is not used for training by default. This is distinct
from temporary inference processing, default abuse monitoring, and application
state. With `store: false`, the selected endpoint does not use Responses application
state, but without approved abuse controls OpenAI may retain abuse-monitoring logs
containing prompts and responses for up to 30 days.

### Launch gates

For the first non-regulated production release, default abuse-monitoring retention
of up to 30 days is technically acceptable **only** after business/legal approval of
the DPA, privacy disclosure, allowed data classes, and customer terms. ZDR is not a
universal technical launch blocker, and this ADR does not assert that law requires
it.

ZDR or Modified Abuse Monitoring is a launch blocker for any tenant or data class
whose contract, regulation, or SkyOS product promise requires exclusion of customer
content from abuse logs. Until that approval is active, SkyOS must prohibit such
restricted data from AI Chat rather than imply zero retention.

EEA regional processing is not declared a universal legal launch requirement by
this ADR. It is a product/contract launch blocker whenever SkyOS promises in-region
processing. OpenAI documents platform support for European regional processing
through `eu.api.openai.com`; that platform capability does not by itself prove that
the exact selected GPT-5.6 Terra model identifier or snapshot is eligible. Before
enabling the EU endpoint, implementation must verify the selected identifier against
OpenAI's current official data-residency model list, in addition to configuring a new
regional project and obtaining the required abuse-monitoring controls and ZDR
amendment.
If the selected Terra identifier is not explicitly eligible at implementation time,
SkyOS must not claim EU regional processing. That is a deployment/configuration
blocker for tenants requiring it, and SkyOS must not silently substitute another
model. Existing projects must not be assumed to acquire residency retroactively.
System data and metadata remain outside OpenAI's documented customer-content
residency commitment.

Legal counsel and the business owner must decide the initial market, allowed data
classification, cross-border transfer basis, and whether ZDR and EU processing are
commercial requirements. Engineering must expose the true configured posture and
must not market unapproved guarantees.

## Request data minimization and identifiers

The adapter may send only:

- bounded system/developer instructions;
- bounded visible conversation history;
- the current user message;
- selected, authorized, size-limited Knowledge excerpts; and
- opaque citation identifiers needed to bind the answer to that retrieval snapshot.

It must not send entire workspaces, unrelated documents, membership lists, audit
history, secrets, credentials, raw database records, or unnecessary profile fields.

Raw `User.id`, email, organization ID, and workspace ID must not be sent. OpenAI's
current guidance recommends a stable privacy-preserving `safety_identifier` for
end-user applications. The adapter will therefore send a versioned pseudonym such
as `HMAC-SHA-256(dedicatedServerSecret, "skyos-ai-safety:v1:" + userId)`, encoded
without the raw identifier. The HMAC secret is separate, server-only, and rotatable;
the value carries no organization or workspace information. If the field is not
needed or supported by the selected model at implementation time, omit it rather
than substitute a raw identifier.

## Security and secret handling

- `OPENAI_API_KEY` exists only in the production secret manager and server runtime.
  It is never prefixed for client exposure, rendered, logged, returned, or committed.
- Use a dedicated OpenAI production project and a least-privilege project service
  account/key, separate from developer and staging projects.
- Restrict organization/project membership, set spend limits and alerts, and rotate
  the key through an overlap procedure. Revoke immediately on suspected exposure.
- Keep the API base URL server-configured and allowlisted. Only the official OpenAI
  endpoint, or the approved regional endpoint, is permitted.
- Retain provider request IDs only as operational metadata subject to log access and
  retention controls. Never log request bodies, response bodies, Knowledge excerpts,
  authorization headers, or hidden instructions.

## Timeout policy

The synchronous request must never inherit an SDK's long default timeout.

- Connection/headers budget: **5 seconds** where the transport exposes a separate
  control; otherwise it is covered by the outer signal.
- Aggregate provider execution budget, including automatic attempts and backoff:
  **45 seconds**.
- SkyOS server-action budget: **50 seconds**, reserving time to persist a safe
  terminal run result.

The adapter passes one outer `AbortSignal` through the SDK and aborts all remaining
attempts when 45 seconds expires. A user/client cancellation also aborts the provider
call. Timeout becomes the existing safe retryable `provider_timeout` category. The
official SDK's ten-minute default is not acceptable for interactive SkyOS chat.

## Retry policy

The official SDK's automatic retries will be disabled with `maxRetries: 0` so SkyOS
has one observable policy rather than stacked retry loops.

Within one durable `AiRun`, the adapter may make at most **two automatic retries**
(three total attempts) for connection failures, 408, 409, 429, and transient 5xx
responses. Use capped exponential backoff starting at 250 ms, doubling per retry,
with full jitter. Honor `Retry-After` only when it fits inside the remaining 45-second
provider budget. Stop immediately when the budget cannot accommodate another
attempt.

Do not automatically retry malformed input, 400/422 validation, 401 authentication,
403 authorization, unknown/unsupported model configuration, a semantic safety or
policy refusal returned as a successful response, invalid structured output, or an
output truncated by the configured limit. Quota-exhaustion 429 responses that cannot
recover inside the budget fail immediately after classification.

Transport attempts do not create additional `AiMessage` or `AiRun` records. After a
terminal failure, the existing user action may create a new run for the same
immutable user message. Because a lost response can make an inference attempt
ambiguous, retries may incur duplicate provider charges; only one accepted assistant
message is persisted. SkyOS assumes no idempotency guarantee for model generation;
provider response or request IDs are correlation data, not idempotency keys.

## Provider response normalization

The adapter must return the existing `LanguageModelProviderResponse`:

- `text`: validated nonblank assistant text within the character limit;
- `citationIds`: parsed candidate IDs only;
- `inputTokens`, `cacheWriteInputTokens`, `cachedInputTokens`, `outputTokens`, and
  `totalTokens`: bounded nonnegative usage when present; cache-write plus cached
  input is a subset of input and total is input plus output.

The registry descriptor supplies `providerKey=openai`, the configured model ID, and
the approved adapter/model policy version. Total tokens are derived from input plus
output when the provider reports them consistently; the provider-reported total and
cached/reasoning breakdowns may be retained as bounded operational telemetry.
Provider request ID, actual returned model, response status/incomplete reason, and a
normalized finish/refusal code must be captured for observability without leaking
the OpenAI response object.

The persistence model stores provider/model/version,
input/cache-write/cached-input/output/total tokens, fixed-precision estimated cost
when exact model pricing is configured, bounded provider request ID, duration, and
safe failure details. The extension does not change authorization, message,
citation, or retry semantics. Unknown usage or pricing remains null, and raw
provider responses are never persisted.

The central pricing catalog treats more than 272,000 input tokens as long context:
the full request uses 2x uncached-input and 1.5x output pricing, while exactly
272,000 input tokens remains standard. The official model documentation does not
state whether those multipliers also apply to cached reads or cache writes. Until
OpenAI documents that billing rule, SkyOS preserves their usage but stores no cost
estimate for a long-context request containing either category rather than
inventing a price.

## Citation implications

The structured provider result contains only `answer` and an array of opaque
`citationIds`. SkyOS then:

1. parses the candidate identifiers;
2. intersects them with the exact retrieval snapshot allowlist;
3. persists only allowed citation records; and
4. ignores fabricated, duplicated, or malformed identifiers.

The model receives no authority to retrieve, authorize, or persist sources.
Provider-native web, file, or search citations are disabled and would not become
trusted SkyOS Knowledge citations if unexpectedly returned.

## Cost model

The comparison scenario is one standard synchronous run with **3,000 uncached input
tokens** and **600 billed output tokens**, including reasoning tokens where the
provider bills them as output. It assumes no tools, hosted search, caching, batch,
priority/flex processing, contract discount, tax, or failed/retried attempt.

| Candidate                                                          | Official input/output price per 1M tokens | Approximate cost/run | 1,000 runs | 10,000 runs | 100,000 runs |
| ------------------------------------------------------------------ | ----------------------------------------: | -------------------: | ---------: | ----------: | -----------: |
| OpenAI GPT-5.6 Terra                                               |                            $2.50 / $15.00 |              $0.0165 |     $16.50 |        $165 |       $1,650 |
| Anthropic Claude Sonnet 5, introductory through 2026-08-31         |                            $2.00 / $10.00 |              $0.0120 |     $12.00 |        $120 |       $1,200 |
| Anthropic Claude Sonnet 5, published standard rate after promotion |                            $3.00 / $15.00 |              $0.0180 |     $18.00 |        $180 |       $1,800 |
| Google Gemini 3.6 Flash paid standard                              |                             $1.50 / $7.50 |              $0.0090 |      $9.00 |         $90 |         $900 |

Formula: `(3,000 × input price + 600 × output price) / 1,000,000`.
The base GPT-5.6 Terra calculation uses $2.50 per 1M input tokens and $15.00 per 1M
output tokens, producing approximately $0.0165 per run. This ADR assumes no specific
regional-processing surcharge. Regional-processing pricing must be re-verified from
current official OpenAI pricing before enabling `eu.api.openai.com`. Actual usage
will vary with tokenizer, hidden/reasoning tokens, retries, output length, and
regional or service tier. Anthropic's introductory price expires shortly after this
ADR and must not drive the architectural choice.

First-pass cost controls are:

- one approved provider/model allowlist;
- current bounded history and Knowledge context, with the provider descriptor as an
  additional hard input-character limit;
- an initial provider `max_output_tokens` cap of 1,200 while preserving the existing
  2,000-character SkyOS response limit;
- the existing per-user rate limit plus workspace-level operational monitoring;
- persisted input/cache-write/cached-input/output usage when supplied, derived total
  usage, and fixed-precision estimated cost from one dated application-owned pricing
  catalog;
- provider-dashboard budget alerts at 50%, 80%, and 100% of a business-approved
  monthly budget; and
- an immediate global kill path by resolving production to the existing unavailable
  provider, without deleting conversation history.

Billing and tenant quotas are outside this ADR.

## Observability

For every run, retain or derive only bounded operational metadata:

- SkyOS run ID;
- configured and returned provider/model identifiers;
- adapter/model policy version;
- input, output, derived total, cached, and reasoning token counts when available;
- attempt count, total duration, and terminal normalized finish/failure category;
- provider request ID in restricted logs or an optional dedicated field; and
- whether the regional endpoint and enhanced retention posture were configured,
  without logging secrets.

Metrics must cover success rate, refusal rate, timeout rate, retry count, 429/5xx
rate, p50/p95 latency, tokens/run, estimated cost, invalid structured results, and
fabricated citation IDs. Alert on budget thresholds, sustained failures, latency,
and model/config mismatches. `AiRun` remains operational inference evidence;
immutable `AuditEvent` is not a substitute and need not contain prompts or outputs.

## Dependency decision

The adapter will use OpenAI's official `openai` TypeScript SDK, not direct `fetch`
and not a universal multi-provider library.

The official SDK provides generated request/response types, typed errors, request
IDs, `AbortSignal` integration, streaming support for later use, and maintained API
surface coverage. Direct HTTP would reduce one dependency but would make SkyOS own
schema drift, error parsing, request-ID extraction, and SDK-equivalent tests. The
dependency is server-only and should be pinned through the pnpm lockfile.

SDK retry and timeout defaults must be overridden as specified above. The adapter
must be tested against a fake injected client/transport; unit, integration, E2E, and
CI tests remain deterministic and make no external calls. Model output itself is not
assumed deterministic: repeatable tests assert the normalized adapter contract,
while offline evaluations measure quality against fixed inputs and acceptance
criteria.

## Consequences

### Positive

- The adapter maps directly to the current SkyOS request/response boundary.
- SkyOS retains all durable state, authorization, retrieval, and citation authority.
- The chosen model balances quality and cost without defaulting to the most
  expensive frontier tier.
- OpenAI documents both enhanced retention controls and EU regional processing.
- The official SDK supplies typed errors, usage, request IDs, cancellation, and a
  later streaming path.
- The existing local provider keeps development and CI deterministic and credential
  free.

### Negative

- OpenAI is an external subprocessor with changing models, prices, controls, and
  availability.
- Default abuse monitoring can retain content for up to 30 days until enhanced
  controls are approved.
- EU regional processing requires commercial approval/configuration, explicit Terra
  eligibility verification, and a current pricing review.
- Stateless requests resend bounded history and may forgo provider-side cache/state
  efficiencies.
- A single provider creates an outage dependency; v1 intentionally returns a safe
  failure instead of silently falling back.
- Model inference remains nondeterministic even with a controlled model identifier;
  only adapter contract tests are deterministic.

## Rejected alternatives

### Anthropic as the first adapter

Anthropic is a close second. The Messages API is the cleanest stateless semantic fit,
its TypeScript SDK and error model are strong, commercial content is not used for
training by default, and ZDR agreements are available. It is not first because the
public commercial posture says storage remains US-only by default unless otherwise
agreed, while SkyOS benefits from a documented self-contained route to European
regional storage and processing. Sonnet 5's temporary launch price and tokenizer
change also make near-term cost projections less stable. These are first-adapter
tradeoffs, not a judgment that Anthropic cannot be supported later.

### Google Gemini Developer API as the first adapter

Gemini 3.6 Flash has the lowest illustrative cost, a stable model, strong structured
output, and a current TypeScript SDK. It is not first because the direct Developer
API's country-availability page is not an EEA data-processing or storage commitment.
Google documents stronger regional governance through its separate enterprise/Cloud
offering, which changes authentication, deployment, commercial, and operational
choices. The new Interactions API also stores state by default, so it requires the
same explicit stateless guard as OpenAI without providing an equally clear direct-API
residency path. If Google is reconsidered, the ADR must choose explicitly between
Developer API and the enterprise Google Cloud surface.

### OpenAI Chat Completions

Chat Completions can satisfy the present text request, but it is not the selected
surface for a new integration. Responses is OpenAI's current primary API, has the
forward-looking structured and streaming surface, and can still be used statelessly.

### Provider-hosted conversations, files, and vector stores

Rejected because they duplicate SkyOS state, complicate deletion and residency,
weaken the authoritative retrieval/citation boundary, and make provider identifiers
part of the domain model.

### Automatic multi-provider fallback

Rejected for v1 because it obscures privacy, residency, behavior, citation, cost,
and incident semantics. A second provider may be added behind the existing interface
only through a new explicit product and architecture decision.

## Risks

- GPT-5.6 Terra quality for SkyOS-specific grounded answers and citation discipline
  is not proven until an offline evaluation corpus is run.
- Provider or regional capacity can produce 429, 5xx, timeout, or latency spikes.
- Retried ambiguous requests can be billed more than once.
- Model identifiers, lifecycle, prices, supported regional snapshots, SDK defaults,
  and data-control eligibility can change between ADR and launch.
- A privacy promise can exceed the actual OpenAI project configuration if posture is
  not verified at deployment.
- Structured output can be incomplete, refused, or semantically wrong even when it
  is syntactically valid.
- A pseudonymous safety identifier remains linkable within the provider project and
  must be covered by privacy review.
- Standard processing has no SLA assumed by this ADR.

## Implementation constraints for the next task

The next task must:

1. add one server-only OpenAI adapter under the existing service boundary;
2. add only the official `openai` SDK and keep it out of client bundles;
3. validate `AI_PROVIDER` and `AI_MODEL` against an allowlist and fail closed;
4. require `OPENAI_API_KEY` only when the OpenAI provider is selected in production;
5. make `store: false` and the absence of conversation/state/tool fields testable
   invariants;
6. inject the SDK client or transport so all tests are deterministic and offline;
7. implement the timeout, retry, error/refusal, structured-output, usage, request-ID,
   and cancellation normalization in this ADR;
8. preserve the current message/run transaction boundaries and citation allowlist;
9. never log or persist raw provider requests/responses, secrets, hidden prompts, or
   full Knowledge context;
10. add configuration documentation without adding real credentials or external CI
    calls;
11. evaluate grounded quality, citation precision/recall, refusal behavior, latency,
    and cost against a representative offline corpus before enabling production; and
12. verify current official pricing, model lifecycle, DPA, retention eligibility,
    and any selected regional endpoint immediately before launch.

No implementation may silently enable provider state, hosted retrieval, tools,
automatic fallback, or client-selectable models.

## Re-evaluation triggers

Reopen this decision when, and only when, one of these materially affects SkyOS:

- the selected model or Responses API is deprecated or retired;
- pricing or regional uplift materially changes the business case;
- training, retention, ZDR/MAM, DPA, subprocessor, or residency policy changes;
- a contract requires controls OpenAI cannot supply;
- measured reliability, latency, grounded quality, or citation quality misses the
  approved service target;
- provider safeguards create unacceptable false refusals for the allowed workload;
- SkyOS traffic, context size, modalities, or offline/batch workloads change
  significantly; or
- a second provider is required for an explicit customer or resilience strategy.

A new model announcement alone is not a re-evaluation trigger. Evaluate it through
the controlled model-upgrade process first.

## Official sources

All sources below were accessed on **2026-08-11**.

### OpenAI

- [Models and model-selection guidance](https://developers.openai.com/api/docs/models)
- [GPT-5.6 Terra model identifier, pricing, capabilities, and version list](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [GPT-5.6 model guidance and privacy-preserving safety identifiers](https://developers.openai.com/api/docs/guides/latest-model)
- [Responses API reference and usage fields](https://platform.openai.com/docs/api-reference/responses)
- [API data controls, endpoint retention, ZDR/MAM, and data residency](https://developers.openai.com/api/docs/guides/your-data#data-residency-controls)
- [Official TypeScript/JavaScript SDK](https://github.com/openai/openai-node)
- [API pricing](https://openai.com/api/pricing/)
- [Data Processing Addendum](https://openai.com/policies/data-processing-addendum/)
- [OpenAI status](https://status.openai.com/)

### Anthropic

- [Messages API stateless multi-turn semantics](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)
- [Models overview and versioning](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude Sonnet 5 model behavior, pricing, and availability](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5)
- [Model deprecations](https://platform.claude.com/docs/en/docs/about-claude/model-deprecations)
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [TypeScript SDK, request IDs, retries, and timeouts](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)
- [API errors and retry behavior](https://platform.claude.com/docs/en/api/errors)
- [Commercial API training policy](https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training)
- [Commercial API retention](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
- [Zero data retention scope](https://privacy.anthropic.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to)
- [Processing and storage locations](https://privacy.anthropic.com/en/articles/7996890-where-are-your-servers-located-do-you-host-your-models-on-eu-servers)
- [Anthropic status](https://anthropic.statuspage.io/)

### Google

- [Gemini 3.6 Flash model and stable status](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash)
- [Latest Gemini models and pricing](https://ai.google.dev/gemini-api/docs/generate-content/latest-model)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Interactions API and default state storage](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Paid-service terms and data use](https://ai.google.dev/gemini-api/terms)
- [Gemini Developer API zero data retention](https://ai.google.dev/gemini-api/docs/zdr)
- [Gemini API errors and retry guidance](https://ai.google.dev/gemini-api/docs/api-errors)
- [Gemini API key security](https://ai.google.dev/gemini-api/docs/api-key)
- [Official TypeScript/JavaScript SDK reference](https://googleapis.github.io/js-genai/)
- [Developer API availability regions](https://ai.google.dev/gemini-api/docs/available-regions)
- [Vertex AI zero data retention and data governance](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention)
- [Google Cloud services with configurable data residency](https://cloud.google.com/terms/data-residency)
- [Google Cloud service health](https://status.cloud.google.com/)

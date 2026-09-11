# ADR 0010: Durable AI orchestration for long-running modes

- Status: Accepted
- Date: 2026-09-11
- Complements: [ADR 0006](./0006-ai-orchestration-foundation.md) and [ADR 0007](./0007-production-hosting-runtime-architecture.md)

## Context

ADR 0006 established `GroundedContext`, `AiOrchestration`, child `AiRun` identities, provider-neutral policies, and explicit final-run semantics, but deliberately did not add a durable orchestration worker. SkyOS subsequently added the database-backed Task 3 Worker Pool with leases, heartbeats, bounded attempts, retry backoff, attempt history, idempotency keys, and expired-lease recovery. Task 5 added durable budget reservations, execution claims, conservative recovery, and per-provider continuation guards.

BALANCED, DEEP, CRITICAL, and AUTO can execute several provider calls and therefore must not depend on one web request or process lifetime. FAST remains bounded enough to retain its existing synchronous path.

## Decision

SkyOS reuses the Task 3 Worker Pool as the only background execution boundary. There is no second queue, second worker loop, in-process fire-and-forget executor, or provider-owned workflow.

### Request boundary

FAST preserves the existing synchronous Chat behavior. BALANCED, DEEP, and CRITICAL persist the user message, routing decision, budget state when enabled, one immutable GroundedContext, one `AiOrchestration`, and one idempotent `AI_ORCHESTRATION` background job. The web request returns after durable enqueue and never waits for long-mode provider calls.

AUTO remains an application-owned deterministic routing decision. AUTO is resolved before execution into FAST, BALANCED, DEEP, or CRITICAL and the full analysis and routing reason remain persisted in `AiRoutingDecision`. AUTO does not become a fifth orchestration policy.

Approved Task 5 budget confirmations follow the same split: approved FAST resumes synchronously through the existing execution path; approved long modes create or reuse the Task 5 execution claim and enqueue durable orchestration. Repeated continuation requests do not grant another external execution.

### One queue, two durable identities

`BackgroundJob` is the Worker Pool execution identity and owns claim/lease/attempt/retry state. `AiOrchestration` is the domain lifecycle identity and owns AI mode, immutable policy identity, GroundedContext, child runs, final result, and aggregate provider telemetry.

The browser assigns each unchanged long-mode draft a client request UUID. SkyOS serializes that identity with a PostgreSQL advisory transaction lock and persists it as the immutable user-message identity; reusing the UUID with different content fails closed. The deterministic routing decision is then reused for that same message, a route-bound GroundedContext is created at most once, and the durable job idempotency key is derived from the immutable routing decision. `BackgroundJob.idempotencyKey` remains the final database uniqueness barrier. A duplicate web request, lost-response retry, or duplicate queue submission therefore converges on the same message, route, GroundedContext, orchestration, and durable job instead of silently creating another execution.

### Provider-call crash boundary

`AiRun` remains the unit of one provider execution. Existing execution code atomically flips `providerAttempted` before invoking the external provider. Durable orchestration treats this flag as a one-way safety boundary:

- a terminal child run is reused and is never executed again;
- a `PROCESSING` child with `providerAttempted = false` may continue;
- a `PROCESSING` child with `providerAttempted != false` after restart is failed conservatively and its provider call is not repeated.

SkyOS therefore provides at-most-once external provider execution for a persisted `AiRun`; it does not claim exactly-once delivery. A crash after the provider accepted work but before SkyOS persisted the response may lose that response, but it will not invisibly spend again by replaying the same run.

### Resumable orchestration

The durable executor reconstructs progress from persisted child `AiRun` rows keyed by `(orchestrationId, orchestrationStep)`. Completed candidate, critic, verifier, and synthesizer steps are reused. Missing steps are created only through the existing orchestration-policy validation path. The same immutable GroundedContext and citation allowlist is used by every child.

Intermediate candidate and review text is always untrusted proposal material. It is never promoted into GroundedContext, never expands the citation allowlist, and never becomes a provider-native retrieval instruction. Synthesis and verification prompts explicitly require claims to be rechecked against the original GroundedContext.

### Cancellation and recovery

Cancellation is cooperative at provider boundaries. A cancelled orchestration cannot start another provider step. An already-running provider request remains bounded by the provider's existing aggregate timeout and retry policy; SkyOS does not claim remote cancellation after the provider has accepted the call.

Worker leases continue to use the Task 3 heartbeat and expired-lease recovery. A non-terminal expired lease is requeued according to the existing bounded worker attempt policy. If the final worker attempt expires, any still-processing child run is failed conservatively and the orchestration becomes `FAILED` or `PARTIALLY_SUCCEEDED` based on persisted successful children.

Budget recovery continues to use the Task 5 execution-claim recovery contract. Zero-attempt claims may release a reservation; known provider cost can be settled; unknown/indeterminate cost remains conservatively held for operator recovery. Durable orchestration does not add a second financial recovery model.

### Cost and retry bounds

Worker-level attempts are bounded to three for durable AI orchestration. Provider-level retry and aggregate timeouts remain those already owned by each registered provider adapter. Budget continuation is checked before each not-yet-started provider step. No path introduces infinite retries, unbounded provider calls, or implicit fallback to a different mode.

### Authorization and tools

All enqueue, read, and cancellation operations require effective `ai.use`, user ownership, and workspace scope. Durable payloads contain provider identities, routing/budget identities, and execution-plan metadata only; they do not contain provider credentials or raw provider payloads.

This decision introduces no autonomous tools, shell access, file mutation, deployment action, or privileged system action. Existing confirmation boundaries for privileged operations remain authoritative. Model text alone cannot authorize or execute a privileged action.

## Deployment

The existing Cloud Run Worker Pool runs the same immutable image digest as the rest of the runtime and receives the same AI mode plus the provider identities required by orchestration. FAST remains the Terraform default. Enabling BALANCED, DEEP, CRITICAL, or AUTO requires pinned OpenAI and Anthropic Secret Manager versions in addition to the Vertex-backed Gemini configuration. Worker IAM grants only the provider secrets needed by the durable AI registry; authentication secrets are not exposed to the worker.

## Consequences

- FAST behavior remains synchronous and backward-compatible.
- Long modes survive web-request completion and worker restarts without creating a second worker system.
- Duplicate queue submissions converge on one job identity.
- Persisted child runs make partial progress observable and resumable.
- A crash after a provider-call boundary may yield partial failure instead of an unsafe duplicate call.
- Final user-visible answers still come only from successful candidate/synthesizer runs permitted by the existing orchestration policy.
- Budget, usage, cost, provider request IDs, worker attempts, failure codes, and orchestration status remain stored in existing auditable structures.

## Deliberately not added

This ADR does not add autonomous agents, new provider APIs, provider-native retrieval, unbounded retries, silent mode fallback, new billing rules, a second queue, or generalized tool execution. Live push updates for completed asynchronous answers are also outside this decision; the persisted conversation remains the source of truth and can be reloaded by the web UI.

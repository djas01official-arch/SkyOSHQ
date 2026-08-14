# ADR 0006: Grounded multi-model orchestration foundation

- Status: Accepted
- Date: 2026-08-14
- Supersedes: none
- Complements: [ADR 0003](./0003-production-language-model-provider.md), [ADR 0004](./0004-anthropic-language-model-provider.md), and [ADR 0005](./0005-gemini-language-model-provider.md)

## Context

SkyOS already owns workspace authorization, Knowledge retrieval, immutable source-version selection, citation snapshots and allowlisting, provider execution, usage telemetry, and cost estimation. OpenAI, Anthropic, and Gemini implement one provider-neutral execution contract. The application currently chooses exactly one server-configured provider for grounded Chat and Knowledge Actions.

Future BALANCED and DEEP execution needs several independent model runs to consume exactly the same approved evidence without turning providers into user-facing personalities or allowing each provider to retrieve different sources. It also needs a durable identity above individual `AiRun` rows so partial execution, an intentional final result, aggregate provider cost, and restart-safe lifecycle state can be represented.

## Decision

SkyOS owns orchestration. Providers remain stateless execution backends and never own retrieval, tenant scope, conversation state, citations, orchestration roles, final routing, or credentials outside their existing server-side adapters.

### Grounding precedes execution

`GroundedContext` is the immutable provider-neutral evidence contract. It contains the effective workspace, a versioned packaged context, context and evidence checksums, exact excerpts, opaque allowed citation IDs, and immutable source/version identities. The existing append-only `AiRetrievalSnapshot` and `AiRunCitation` tables persist this contract; no second excerpt store is introduced.

Retrieval or direct immutable-version selection happens once. A context can exist before a run and many child runs can reference it through `groundedContextId`. Providers receive projections of this object and cannot mutate it, retrieve extra sources, or make their output trusted evidence. Returned citation IDs remain candidates intersected with the context allowlist. A later synthesizer is subject to the same allowlist.

### One logical operation, many attributable executions

`AiOrchestration` represents one logical SkyOS AI operation. It records organization/workspace scope, creator, optional conversation/message identity, immutable GroundedContext identity, mode and versioned policy identity, lifecycle timestamps, safe failure code, and an optional intentional final run. `AiRun` continues to represent exactly one provider execution and retains its own provider/model/policy identity, status, request correlation ID, usage, cost, and citations.

Child runs add nullable `orchestrationId`, `orchestrationRole`, `orchestrationStep`, and `groundedContextId`. Historical non-orchestrated runs remain valid. Provider identity and role are independent dimensions: any registered provider can be a candidate, critic, verifier, or synthesizer when an immutable policy permits it. Orchestration code contains no provider API-key resolution and no provider-to-role mapping.

### Modes, roles, and policies

The application-owned modes are `FAST`, `BALANCED`, `DEEP`, and `CRITICAL`. Roles are `CANDIDATE`, `CRITIC`, `VERIFIER`, and `SYNTHESIZER`. Static policies have immutable key/version identities and ordered, staged steps containing role, required/optional status, allowed registered provider families/models, and the existing bounded provider retry-policy reference.

For this foundation, policies are descriptions only:

- FAST describes one candidate and is the conceptual shape of today's single-provider path.
- BALANCED describes two independent candidates followed by synthesis.
- DEEP adds critique and verification before synthesis.
- CRITICAL reserves a more redundant candidate/critique/verification/synthesis shape.

None of these policies is selected or executed in production user flows by this decision.

### Lifecycle and final-result semantics

An orchestration moves from `PENDING` to `RUNNING`, then explicitly to `SUCCEEDED`, `PARTIALLY_SUCCEEDED`, `FAILED`, or `CANCELLED`. Child failures do not automatically decide orchestration status; policy evaluation must do that. `finalRunId` can reference only a successful child in the same workspace and orchestration, with `CANDIDATE` as FAST's final role and `SYNTHESIZER` for the other modes.

A failed or missing synthesizer never promotes a candidate implicitly. Partial success can therefore retain successful candidates and failed children while leaving `finalRunId` null. The persistence model can survive a process restart, but no durable orchestration worker is added yet.

### Cost aggregation

Orchestration aggregation sums persisted child-run token dimensions and database fixed-precision `estimatedCostUsd` values. Known estimated cost is reported separately from `unknownCostRunCount`; null cost is never converted to zero. This is provider-cost telemetry, not user billing, credits, or a budget decision.

## Security and database enforcement

Application services require effective `ai.use` and scope every read and mutation to the authenticated workspace and creator. Database foreign keys, checks, and triggers enforce organization/workspace/context consistency, child-run context reuse, immutable identities, legal status transitions, and valid final-run membership. Existing Knowledge Action document-version pins and citation provenance checks remain authoritative.

No raw provider payload, prompt, credential, API key, authorization header, or provider reasoning content is stored.

## Deliberately not implemented

This ADR does not add production multi-provider calls, parallel execution, voting, consensus, synthesis prompts, fallback, provider routing, user-visible modes, cost-based routing, task budgets, SkyOS credits, prompt compilation, task planning, tools, sandboxes, autonomous agents, or durable cloud workers.

Future work may build natural-language intent understanding, task planning, prompt compilation, hard cost budgets, durable 24/7 cloud execution, autonomous creation/workflows, SkyOS-managed credentials, and user credits on this foundation. Those are directions, not current behavior or commitments.

## Consequences

- Existing grounded Chat and Knowledge Actions still execute one configured provider exactly once.
- Multiple future child runs can share one persisted GroundedContext without copying excerpts.
- Every provider execution remains independently attributable and billable through `AiRun`.
- A future synthesis run is explicit and cannot silently replace failed policy execution.
- Provider-generated text never becomes trusted GroundedContext without a future explicit, separately authorized stage.

# OpenAI staging evaluation

## Purpose

This procedure enables one controlled, manual evaluation of the production SkyOS OpenAI adapter against synthetic grounded-answer cases. It does not enable production traffic, alter tenant routing, use PostgreSQL, or evaluate real customer data. Automated tests use injected offline providers and transports.

Official OpenAI documentation was re-verified on **2026-08-13**:

- [`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra) is listed with Responses API and Structured Outputs support. The page lists Free as unsupported and publishes account-tier rate limits; the staging project must have model access.
- The model page currently lists standard text pricing of **$2.50 per 1M input tokens**, **$0.25 per 1M cached input tokens**, and **$15.00 per 1M output tokens**. The snapshot was verified on 2026-08-13 and must be re-verified before each controlled run. The evaluator does not receive cached-token usage, so its planning and actual-cost calculations intentionally use only uncached input and output pricing.
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) supports strict JSON Schema output. SkyOS still validates the normalized provider result rather than granting model output authority.
- The [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create) documents `store`, structured text output, response usage fields, and response identifiers. SkyOS sends `store: false`, does not use background mode, tools, hosted retrieval, or provider conversation state, and captures bounded input/output/total usage plus the SDK request ID where supplied.
- [Data controls and residency](https://developers.openai.com/api/docs/guides/your-data#data-residency-controls) distinguish application-state retention, abuse-monitoring controls, storage residency, and regional processing. `store: false` is a technical request setting; it is not by itself a ZDR, MAM, residency, or legal-compliance claim.
- The current residency table lists `/v1/responses` and `gpt-5.6-terra` for European storage and processing. Eligibility, project approval, endpoint choice, and current commercial terms must nevertheless be verified immediately before an EU deployment run.
- [Rate-limit guidance](https://developers.openai.com/api/docs/guides/rate-limits) and the model-specific tier table remain account-dependent. The evaluator runs sequentially and reuses only the adapter's bounded retry policy.
- The [official JavaScript/TypeScript SDK documentation](https://developers.openai.com/api/docs/libraries) remains the implementation reference. SkyOS pins `openai` through the lockfile, disables SDK retries, captures `_request_id` when supplied, and owns one 45-second aggregate deadline.

No dated immutable Terra snapshot is currently assumed. The explicitly approved model identifier remains `gpt-5.6-terra`; model identifier changes require controlled configuration review.

## Operator gate

Use a dedicated staging OpenAI project and key. Before running, confirm all of the following:

- The selected OpenAI organization/project is the approved staging project, with appropriate membership, spend limits, and alerts.
- The project can access the exact `gpt-5.6-terra` model identifier and Responses API.
- Current model pricing and project-specific rate limits have been reviewed.
- `store: false` remains present in adapter tests and no background mode, tools, hosted retrieval, or provider conversation state has been enabled.
- The project's current abuse-monitoring posture is understood. ZDR or MAM is claimed only if OpenAI has approved and the project is configured for it.
- The intended data-residency and regional-processing requirements have been separately approved by technical and legal/business owners.
- If EU processing is required, the exact selected model remains listed for `/v1/responses`, the project has the required controls, and the endpoint configuration has been separately reviewed.
- The synthetic corpus contains no real user or customer information.
- Local generated reports have an approved location, access policy, and deletion date.

The checklist records technical observations; it does not constitute legal, privacy, procurement, or business approval.

## Required environment variables

Provide these values through the current shell or a staging secret manager:

- `AI_PROVIDER=openai`
- `AI_MODEL=gpt-5.6-terra`
- `OPENAI_API_KEY=<server-secret>`
- `SKYOS_ALLOW_LIVE_AI_EVAL=1`

The last variable is accepted only by the manual evaluator. It is not an application runtime feature flag. `AI_PROVIDER=openai` by itself is insufficient to run the evaluator. Known CI environments are rejected even if every variable is present.

Run `pnpm ai:eval:openai` only after completing the checklist. Do not run it from CI. Do not paste the key into issue trackers, shell transcripts, reports, or source files.

## Evaluation design

The version-controlled corpus contains 12 synthetic cases covering grounded facts, multiple sources, unsupported questions, prompt injection, fabricated-citation pressure, irrelevant context, bounded multi-turn history, Czech text, output discipline, concise enterprise responses, conflicting sources, and citation minimality.

The evaluator runs cases sequentially. The corpus is hard-bounded to 20 cases and cannot be expanded at runtime. Before the first request it prints a conservative planning estimate using the provider's 20,000-character input limit as a synthetic-corpus token planning ceiling, the 1,200-token output cap, current prices, and all three possible adapter attempts. This is not an exact tokenizer prediction or final charge. Approximate actual cost is calculated from provider-returned input and output usage.

Hard checks require:

- a successful normalized structured result and nonempty bounded answer;
- string citation IDs within the adapter count limit;
- no candidate citation outside the supplied per-case allowlist;
- all case-required citations and no citations for explicitly unsupported cases;
- absence of synthetic prompt-injection bait markers;
- returned model identity matching the approved model;
- provider usage metadata and request ID; and
- no configuration, authentication, permission, model-access, parsing, timeout, or terminal provider failure.

Authentication, permission, configuration, or model-unavailable failures abort the remaining corpus immediately. Other per-case failures are recorded and evaluation continues, but three consecutive failures stop the run to bound systemic cost. The evaluator adds no retry loop; the production adapter remains the sole retry authority.

Hard checks do not prove semantic quality. Each report includes pending human-review criteria for groundedness, source faithfulness, usefulness, conflict handling, instruction resistance, Czech quality, and concise enterprise tone. No LLM-as-judge is used.

## Report and quality gate

Generated JSON reports are written to the ignored `artifacts/ai-eval/` directory. They contain case identity, hard checks, bounded provider metadata, usage, approximate cost, latency, candidate citation IDs, and the full synthetic-case answer needed for human review. They omit the API key, authorization headers, raw request payloads, developer instructions, Knowledge context, and user input. Secret-shaped configured values are redacted defensively.

The first staging gate requires:

- 100% structural and metadata checks;
- zero candidate citations outside each supplied allowlist;
- zero leaked synthetic forbidden markers;
- no configuration, authentication, unexpected timeout, or provider failures; and
- completed human review of every case for groundedness and usefulness.

The script can report only `hard-failed` or `human-review-required`; it cannot authorize production. A human-reviewed pass means only that the candidate may proceed to broader staging.

Latency min, median, p95, and max are staging observations from a tiny corpus, not production SLA evidence. Missing usage is a hard failure and suppresses aggregate actual-cost calculation.

## EU endpoint status

The current adapter intentionally uses only `https://api.openai.com/v1`; the evaluator exposes no base-URL override. It therefore cannot make an EU-endpoint claim or create an arbitrary-URL SSRF path. If EU regional processing becomes a staging requirement, add a separately reviewed allowlist containing only the exact official endpoint, re-verify `gpt-5.6-terra` eligibility immediately before implementation, and keep deployment selection server-controlled. Do not silently substitute another model.

## First controlled run

1. Create or select a dedicated staging project with a small approved spend limit and alerts.
2. Complete and record the operator checklist with technical and legal/business owners.
3. Inject the four required variables into a clean operator shell.
4. Run `pnpm ai:eval:openai` once and retain the terminal request IDs for restricted troubleshooting.
5. Review every generated answer against its stated human criteria; record the reviewer and disposition outside the generated immutable observation.
6. Delete the local report according to the approved staging retention period.
7. Treat failures as evaluation findings. Do not change provider/model configuration or enable production automatically.

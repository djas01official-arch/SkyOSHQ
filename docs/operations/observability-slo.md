# SkyOS observability and initial SLOs

Status: Task 8 non-production contract. These are internal engineering targets, not a customer or legal SLA.

## Contract

All production runtimes write one-line JSON to stdout/stderr through `services/observability/logger.ts`. Cloud Run captures those streams; no explicit Logging API client or extra runtime IAM role is required.

Required base fields are `timestamp`, `severity`, `service`, `environment`, and `operation`. Relevant events add bounded fields such as `request_id`, `run_id`, `orchestration_id`, `document_id`, `background_job_id`, `status`, `duration_ms`, `error_category`, `provider`, `model`, and `attempt`. `K_REVISION` and the configured immutable `SKYOS_IMAGE_DIGEST` identify deployments.

Service names are `web`, `worker`, `reconciliation`, `migrator`, and `operator`. Severities are `DEBUG`, `INFO`, `NOTICE`, `WARNING`, `ERROR`, and `CRITICAL`. Error categories are:

- `validation`, `authentication`, `authorization`, and `configuration`
- `provider_transient`, `provider_permanent`, `timeout`, and `rate_limit`
- `database`, `storage`, `dependency`, and `internal`

The logger uses a runtime allowlist. It never accepts arbitrary metadata and never serializes an error object or message. Do not log prompts, provider request/response bodies, retrieved chunks, Knowledge document text, vectors, filenames, cookies, authorization headers, signed URLs, connection strings, credentials, Secret Manager payloads, or internal reasoning. Use IDs, counts, durations, safe error codes, and token counts.

## Correlation

The durable path is correlated without deriving identifiers from content:

```text
AiRun.run_id
  -> AiRun.orchestration_id
  -> BackgroundJob.domain_job_id == orchestration_id
  -> BackgroundJob.background_job_id
```

Knowledge uses `document_id`, `domain_job_id`, and `background_job_id`. A Google trace identifier is accepted only when it is a valid 128-bit `X-Cloud-Trace-Context` or W3C `traceparent` trace ID. Full tracing is deliberately deferred: durable IDs already cross the database-backed boundary, and adding an SDK and sampling policy is not justified for this non-production phase.

High-cardinality IDs belong only in logs. Terraform metric labels are restricted to bounded status, operation, job kind, mode, provider, and error-category values. Never add user, request, run, document, object key, filename, URL, or prompt values as metric labels.

## Signals and ownership

| Area           | Primary signals                                                                                            | Source                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Web/API        | request count, response class, p95 latency, instances, CPU, memory, probe outcomes                         | native `run.googleapis.com` metrics                 |
| Durable worker | completed, failed, retry, lease expiry, queue count and oldest age                                         | structured logs and log-based metrics               |
| AI             | terminal outcome, provider/model, error category, tokens, duration; orchestration mode/status/cancellation | structured logs and log-based metrics               |
| Knowledge      | embedding outcome, provider/model, dimensions, processed chunks, duration, retries                         | structured logs and log-based metrics               |
| Reconciliation | start, terminal result, duration, actionable drift and repair counts; missing success                      | structured logs, log-based metrics, PromQL alert    |
| Cloud SQL      | instance state, CPU, memory, disk utilization/bytes, PostgreSQL backends                                   | native `cloudsql.googleapis.com` metrics            |
| GCS            | request errors, object/byte growth, reconciliation drift                                                   | native `storage.googleapis.com` plus reconciliation |

The worker emits one backlog snapshot per minute. Queue age of five minutes is degraded: it is five times the default one-minute lease and far beyond the one-second poll interval. An AI orchestration still `RUNNING` after 30 minutes is stuck; this accommodates the sequential CRITICAL path while remaining bounded. An active Knowledge attachment unchanged in `PROCESSING`, `CHUNKING`, or `EMBEDDING` for 15 minutes is stuck. Five degraded snapshots within ten minutes open the durable-domain alert. Reconciliation also reports incomplete domain state. The reconciliation schedule remains daily at 03:17 UTC, with direct Cloud Run Job failure, Scheduler error, and no-success-within-26-hours signals.

Reconciliation logs counts only. Archived attachments are an expected lifecycle state and do not contribute to actionable drift. Historical failed background jobs are reported separately and do not make a clean reconciliation run drift-positive.

## Initial SLIs and SLOs

Measurement windows are rolling 30 days unless stated otherwise. Eligible web requests exclude the liveness endpoint and intentional client errors for the availability ratio. Scheduled maintenance explicitly announced before the window can be annotated but is not silently removed.

| SLI                                                                   |                  Nonprod initial target |      Production-oriented initial target | Measurement                                         |
| --------------------------------------------------------------------- | --------------------------------------: | --------------------------------------: | --------------------------------------------------- |
| Web/API availability: non-5xx eligible requests / eligible requests   |                                   99.5% |                                   99.9% | Cloud Run request count by response class           |
| Web/API latency                                                       | p95 <= 3 s for 95% of 10-minute windows | p95 <= 2 s for 99% of 10-minute windows | Cloud Run request latency                           |
| Durable AI success: successful terminal runs / eligible terminal runs |                                     97% |                                     99% | `skyos_ai_run_events`                               |
| Durable AI latency                                                    |                            p95 <= 180 s |                            p95 <= 120 s | `skyos_ai_run_latency_ms`                           |
| Knowledge processing success: READY outcomes / eligible ingests       |                                     97% |                                     99% | durable job and embedding outcomes; lifecycle query |
| Knowledge processing latency: ingest to READY                         |                           p95 <= 15 min |                           p95 <= 10 min | durable timestamps and job duration                 |
| Reconciliation reliability                                            |   29 successful expected runs / 30 days |                                 30 / 30 | `skyos_reconciliation_events` and schedule          |

The 26-hour missing-success rule uses a PromQL rolling window. The metric-absence API cannot represent this daily-job grace period because its maximum duration is 23 hours 30 minutes; shortening the rule would create a false incident before every daily run.

The initial web availability error budget is:

- Nonprod 99.5% over 30 days: 0.5% bad eligible requests, or 3 hours 36 minutes of equivalent full unavailability.
- Production-oriented 99.9% over 30 days: 0.1% bad eligible requests, or 43 minutes 12 seconds of equivalent full unavailability.

For event-ratio SLOs, the budget is `eligible events × (1 - target)`. Example: a 99% AI success target permits 10 failed eligible terminal runs per 1,000. This operational error budget is unrelated to Task 10 financial AI budgets. Freeze risky releases when the 30-day budget is exhausted; prioritize reliability until burn returns below target.

## Alert philosophy

An alert means human attention is probably required. A single provider or worker error is a log event, not an incident. Terraform uses aggregation windows, threshold counts, and auto-close windows to reduce storms.

The daily reconciliation absence policy uses a 25-hour PromQL lookback, which is the maximum accepted for a log-based metric and leaves one hour of schedule tolerance. Alert auto-close windows are at least 30 minutes. XyChart threshold lines use only the supported value and label fields. Dashboard JSON explicitly sets each dataset to the `Y1` axis and omits zero-valued tile coordinates so the configuration matches the API's canonical response without ignoring dashboard drift.

- Page/urgent: confirmed uptime loss, sustained web 5xx ratio, repeated runtime probes, critical reconciliation/storage drift.
- Ticket/non-urgent: sustained latency, worker backlog/failures, provider/rate-limit clusters, Knowledge failures, Cloud SQL pressure, repeated security denials.
- Dashboard only: 4xx trends, individual retries, token counts, normal CPU/memory variation, bucket growth, clean reconciliation.

Policies are created even when `observability_notification_channels` is empty, so incidents remain visible without inventing an email or chat destination. Attach only reviewed existing channel resource names.

## Dashboard

Terraform manages `SkyOS nonprod operations` with Web, AI, worker, Knowledge, reconciliation, Cloud SQL, GCS, and runtime panels. Empty panels immediately after creation are expected until matching events arrive. A live verification requires recent Web traffic, one AI/Knowledge test flow if configured, a successful reconciliation execution, and visible Cloud SQL native metrics.

## Health and cost controls

`/api/health/live` is deterministic and performs no dependency call. `/api/health/ready` runs exactly one bounded database query with a one-second default timeout. Both responses disable caching. The public uptime check is created only when the web service is deliberately public and calls only liveness every five minutes; it needs no URL secret and cannot generate AI cost.

Native platform metrics are preferred. Custom metrics exist only for application semantics, emit low-cardinality labels, and avoid per-object GCS Data Access log metrics. Admin Activity audit logs should remain available for IAM, Secret Manager, Cloud Run configuration/deployments, Cloud SQL administration, and GCS administration. Do not globally enable GCS Data Access logs until retention, expected volume, and cost have been reviewed.

## Verification gates

Task 8 is complete only after all repository tests, Terraform validation/apply/convergence, live dashboard inspection, a controlled alert open and close, a correlated durable flow, and a safe failure test pass. Store only command output with secrets removed; never commit runtime logs, plans, state, provider payloads, or incident-test payloads.

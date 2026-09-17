# SkyOS incident response runbook

## Purpose

Use this runbook to triage, contain, recover, and verify SkyOS incidents without weakening authorization, deleting durable evidence, or exposing sensitive data.

Scope: `skyos-np-web`, `skyos-np-worker`, `skyos-np-reconcile`, Cloud SQL PostgreSQL, the private Knowledge bucket, AI providers, Secret Manager, and supporting IAM/networking.

## Severity and roles

- SEV-1: broad unavailability, confirmed data exposure, destructive corruption, or active credential compromise. Page immediately, stop risky mutation, and designate incident commander and communications owner.
- SEV-2: sustained major degradation, growing stuck backlog, provider outage without adequate fallback, repeated reconciliation failure, or database saturation. Respond promptly and create a work log.
- SEV-3: limited nonprod defect or threshold warning with no material impact. Create a ticket and monitor.

The first responder becomes incident commander until explicitly handed off. Record UTC start time, detected signal, affected services, last known good revision/image digest, actions, and evidence. Do not paste secrets, cookies, prompts, Knowledge content, signed URLs, connection strings, or full provider responses into the incident record.

## First ten minutes

1. Confirm the alert is current and identify the exact policy/condition.
2. Open `SkyOS nonprod operations`; set the time range to include at least 15 minutes before the alert.
3. Establish scope: web, worker, AI, Knowledge, reconciliation, database, storage, or security.
4. Compare the failing revision and immutable image digest with the last known good deployment.
5. Query structured logs by `operation`, `service`, `error_category`, and safe correlation IDs. Never broaden the query to dump payloads.
6. Choose containment before repair. Stop repeated harmful work, but preserve durable records and forensic evidence.
7. Escalate severity if impact expands, data integrity is uncertain, or compromise is plausible.

## Containment options

- Roll web traffic back to a known-good immutable revision.
- Pause or scale down a repeatedly failing worker only after confirming queued work remains durable.
- Temporarily reduce producer traffic or AI retry pressure when backlog is growing.
- Disable a compromised credential or secret version and deploy a replacement version.
- Keep reconciliation report-only until its proposed repairs and dependencies are understood.

Record every containment action, owner, UTC timestamp, and rollback condition.

## Diagnostic order

Use this order to avoid changing multiple layers at once:

1. Cloud Monitoring alert condition and dashboard.
2. Cloud Run service/worker/job revision health, instances, probes, CPU, and memory.
3. Structured lifecycle logs and correlation IDs.
4. Background queue counts, oldest queued age, retries, failures, and expired leases.
5. Cloud SQL state, CPU, memory, disk, PostgreSQL backends, and recent admin changes.
6. AI provider status/quota and error category.
7. Knowledge embedding/lifecycle and report-only reconciliation.
8. GCS request errors, object metadata drift, IAM, and recent admin activity.

## Web or runtime incident

- Confirm whether 5xx ratio, latency, uptime, or probes are failing.
- Compare current Cloud Run revision environment and image digest with the last known good revision.
- If one revision introduced the issue, route traffic back to the previous known-good immutable revision. Do not rebuild an old tag.
- If readiness fails but liveness succeeds, investigate Cloud SQL/network/secret access; do not turn readiness into liveness.
- If both fail, inspect startup logs and runtime configuration. Never print secret environment values.

Rollback is complete only when traffic is on the known-good revision, liveness/readiness are healthy, 5xx and latency return to baseline, and a short end-to-end request succeeds. Keep the failed revision for evidence until the incident is closed.

## Durable worker or stuck work

- Check `background_job.backlog_snapshot`, oldest queued age, active count, terminal failures, retries, and `background_job.lease_expired`.
- A five-minute queue age is degraded. Repeated lease expiry suggests crash, timeout, database loss, or undersized capacity.
- Do not directly edit durable status rows. First restore worker health; let lease recovery and idempotent handlers act.
- Run reconciliation report-only before either repair flag. Use repair only after reviewing counts and confirming dependencies are healthy.
- Verify the same orchestration/domain ID across orchestration and job events and confirm one terminal state.

## AI provider outage or rate limiting

- Group terminal runs by provider, model, error category, mode, and revision.
- Check provider status and project quota through approved consoles. Do not log or paste provider request bodies.
- Prefer a configured mode/provider control already supported by SkyOS. Do not add an unreviewed provider or silently weaken grounding.
- Reduce retry pressure if rate limits are worsening backlog. Preserve durable idempotency.
- Recovery requires successful representative runs, falling backlog, no repeated rate-limit alert, and reconciled budget records.

## Cloud SQL incident

- Confirm instance state, CPU, memory, disk, PostgreSQL backends, and recent Cloud SQL/IAM/network changes.
- For connection pressure, stop retry storms before raising a connection limit. Inspect worker/web instance counts and pool configuration.
- For saturation, reduce nonessential work and protect reconciliation/migrations from concurrent mutation.
- For a migration-related failure, stop further migrations, preserve the failed migrator logs and schema state, and use only the reviewed forward-recovery procedure for that migration. Do not edit the production migration history manually.
- For suspected corruption or restore need, stop application writes and escalate. Disaster recovery execution and load qualification belong to Task 9; do not improvise a restore during Task 8.
- If disaster-recovery activation becomes necessary, hand off under the Task 9 recovery plan and keep the incident commander responsible for the transition record.
- Recovery requires stable resource signals, successful readiness, worker progress, and no unexplained reconciliation drift.

## Knowledge or storage incident

- Identify the lifecycle stage and correlate `document_id`, domain job, and background job IDs.
- Check GCS request errors, metadata/generation mismatch categories, worker backlog, embedding provider health, and reconciliation counts.
- For retrieval degradation, compare ready source counts, citation-bearing results, embedding failures, and recent revision/model changes without logging retrieved content.
- Run report-only reconciliation first. Archived attachments alone are not drift.
- Do not delete orphaned objects or rows manually. Repair flags only recreate missing durable pipeline requests or recover expired leases; they are not destructive cleanup.
- Recovery requires the document reaching the expected terminal lifecycle, a clean repeated reconciliation report, and no new storage errors.

## Secret or identity compromise

Treat credible credential exposure as SEV-1.

1. Contain access: disable or revoke the affected credential/version and restrict the compromised principal without deleting audit evidence.
2. Identify scope using Secret Manager, IAM, Cloud Run configuration, Cloud SQL admin, and GCS admin audit logs.
3. Rotate the secret using the established write-only flow; deploy a new revision pinned to the new numeric version.
4. Revoke sessions or downstream tokens where applicable.
5. Verify no secret value entered source control, Terraform state/plan, logs, command history, or incident notes. If it did, treat every copy as compromised.
6. Restore only the minimum required access and monitor for recurrence.

Never solve a secret-access failure by granting project Owner/Editor or broad secret access.

## Communication

Use a neutral factual update: severity, start time in UTC, user-visible impact, affected components, current containment, next update time, and owner role. Do not speculate about cause. Use placeholders until actual owners/channels are confirmed; Terraform intentionally does not guess a destination.

## Recovery and closure

Before closure, verify:

- current and last-known-good revision/image are recorded;
- health, error ratio, latency, backlog, provider, database, and reconciliation signals are stable;
- a representative correlated flow reached one expected terminal result;
- repair did not create duplicate work;
- temporary containment is either removed or tracked;
- the controlled alert test is not confused with a real incident;
- follow-up owners and dates exist.

For SEV-1/2, create a blameless post-incident review covering timeline, detection gap, root cause, contributing conditions, customer/data impact, containment, recovery, what worked, and concrete preventive actions. Revisit SLOs and alert thresholds using evidence rather than one spike.

# ADR 0009: Primary GCP region and data-residency boundary

- Status: Accepted
- Date: 2026-08-22
- Complements: [ADR 0007](./0007-production-hosting-runtime-architecture.md)

## Context

ADR 0007 selects Google Cloud Run, Cloud SQL for PostgreSQL, and Google Cloud
Storage as the intended production platform, but deliberately did not select a
region. The first infrastructure resources have not been created. That leaves a
material deployment decision open: Google services can use defaults, and Cloud
Storage creates a US bucket when a location is not explicitly supplied.

SkyOS needs one explicit initial region so that its application workloads, primary
database, and Knowledge-object storage can be colocated. Repository review found
no accepted requirement requiring Czech, Central-European, or another specific
location. Existing provider ADRs instead require provider-processing and
data-residency commitments to be evaluated separately from SkyOS-controlled
infrastructure.

## Decision

Set the initial primary Google Cloud Platform region configuration to:

```text
SKYOS_PRIMARY_GCP_REGION=europe-west1
```

`europe-west1` is Belgium and is the primary region for both the first
non-production environment and production. The initial topology is single-region:

| Resource                                     | Required initial location |
| -------------------------------------------- | ------------------------- |
| Cloud Run web service                        | `europe-west1`            |
| Cloud Run worker pool                        | `europe-west1`            |
| Cloud Run Jobs (migrator and reconciliation) | `europe-west1`            |
| Cloud SQL for PostgreSQL                     | `europe-west1`            |
| Knowledge Google Cloud Storage bucket        | regional `europe-west1`   |

The initial Knowledge bucket must be a **regional** bucket in `europe-west1`; do
not select a multi-region or dual-region bucket for the first launch.

### Colocation invariant

Initial production and non-production Cloud Run services, worker pools, Cloud Run
Jobs, Cloud SQL instances, and regional GCS buckets must explicitly use
`SKYOS_PRIMARY_GCP_REGION` unless a later accepted ADR approves an exception.
Infrastructure creation commands, manifests, and IaC must always provide the
region explicitly. They must never rely on Google Cloud defaults. This avoids
unintended cross-region Cloud SQL/GCS traffic and the default-US Cloud Storage
location.

`GOOGLE_CLOUD_LOCATION=global` or another Vertex endpoint selection is an outbound
provider-service decision. It does not redefine SkyOS's primary application and
data region, and remains subject to its own model, provider, and residency review.

## Rationale

`europe-west1` supports the required initial Cloud Run service, worker-pool, and
job deployment models; Cloud SQL for PostgreSQL; and a regional Cloud Storage
bucket. It is an EU location and is subject to Cloud Run Tier 1 pricing, whereas
`europe-central2` (Warsaw) is subject to Tier 2 pricing. A single selected region
also provides the simplest initial topology while keeping the web, worker,
database, and Knowledge binary store colocated.

This is a location and topology decision, not a latency guarantee, capacity
reservation, availability guarantee, or model-availability assertion. Exact
service availability, quotas, pricing, and Cloud SQL extension qualification must
still be re-verified for the selected project immediately before provisioning.

## Data-residency boundary

This decision expresses the intended EU-region location for **SkyOS-controlled
primary application data** in:

- Cloud SQL PostgreSQL; and
- Knowledge binary objects in the regional GCS bucket.

It does not establish universal EU-only processing or make a legal/compliance
claim. In particular, AI-provider processing follows each provider's separately
configured endpoint, contract, and policy; external identity-provider processing
is separate; telemetry and logging location require separate review; and backups
or disaster-recovery design may introduce additional locations. SkyOS must not
claim GDPR compliance solely because primary infrastructure is located in Europe.

## Consequences and future change

The selected region is an explicit infrastructure configuration contract, not a
routine runtime toggle. Changing it is a migration project requiring a reviewed
plan for a new Cloud SQL instance, replication and cutover; GCS object migration
or bucket-relocation workflow; Cloud Run redeployment; DNS/traffic cutover;
backup/restore changes; and a renewed provider and data-residency review.

No Google Cloud resource, IAM policy, secret, `.env` value, or deployment is
created by this decision.

## External verification record

The regional platform facts were checked on 2026-08-22 against official Google
Cloud documentation:

- [Cloud Run locations and worker-pool deployment](https://cloud.google.com/run/docs/deploy-worker-pools)
- [Cloud Run regional pricing tiers](https://cloud.google.com/run/pricing)
- [Cloud SQL for PostgreSQL region availability](https://cloud.google.com/sql/docs/postgres/region-availability-overview)
- [Cloud Storage bucket locations](https://cloud.google.com/storage/docs/bucket-locations)

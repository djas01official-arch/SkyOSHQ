# SkyOS GCP Terraform foundation

Terraform is the selected infrastructure-as-code contract for the SkyOS Google
Cloud platform. The non-production root defines the regional data plane and the
reviewed runtime foundation needed by Cloud Run, Cloud SQL, private Knowledge
storage, Artifact Registry, Secret Manager, and workload identities.

The authoritative initial region is `europe-west1` (Belgium), as locked by
[ADR 0009](../../architecture/decisions/0009-primary-gcp-region-data-residency.md).
The non-production configuration keeps this value in Terraform locals rather than
accepting a region variable, so a `.tfvars` override cannot deploy it elsewhere.

## State boundary

The [bootstrap state root](./bootstrap/state/README.md) defines the separately
reviewed Terraform-state bucket. The bucket must first be created by the explicit
operator bootstrap flow, then imported directly into the initialized GCS backend.
This deliberately avoids a local-state migration. Terraform state is sensitive
operational data and must never be committed. Do not commit local state,
`terraform.tfvars`, `backend.hcl`, credentials, or service-account keys.

Use a temporary local backend only for offline validation:

```sh
cd infrastructure/terraform/environments/nonprod
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

After the state bootstrap is complete, copy
`environments/nonprod/backend.hcl.example` to ignored `backend.hcl`, fill in the
reviewed state-bucket name, and initialize with
`terraform init -backend-config=backend.hcl`. The non-production root uses the
distinct `environments/nonprod` state prefix; it must never share the bootstrap
root's `bootstrap/state` prefix.

Terraform provider authentication is intentionally absent from committed files.
A future apply identity must use Application Default Credentials or Workload
Identity Federation, never a JSON key. Real `terraform.tfvars` files remain
ignored.

## Current resource boundary

The reviewed root defines:

- one private, regional, Standard Knowledge bucket in `europe-west1`;
- four separate user-managed service-account identities: web, worker, migrator,
  and reconciliation;
- one exact project custom role containing only `storage.objects.create`,
  `storage.objects.get`, and `storage.objects.delete`;
- bucket-scoped grants of that role to web, worker, and reconciliation only;
- a dedicated VPC, runtime subnet, and Private Services Access path for Cloud SQL;
- a PostgreSQL Cloud SQL instance and the reviewed migration identity foundation;
- one immutable-tag Artifact Registry repository for the shared SkyOS runtime image;
- the Cloud Run migration role-bootstrap job;
- a protected Secret Manager container plus gated restricted application database
  login foundation; and
- Secret Manager containers plus an opt-in Cloud Run web service definition.

The migrator intentionally has no Knowledge storage grant. Runtime identities are
separate so future worker and reconciliation slices can receive only their exact
permissions.

## Application database activation

The application login is deliberately disabled by default with
`enable_application_database_user = false`. The intended rollout is two-stage
because `skyos_application_role` is a PostgreSQL custom role created by the
separately executed migrator role-bootstrap job.

1. Apply the base foundation with the application login disabled.
2. Execute and verify the `skyos-np-migrator-role-bootstrap` Cloud Run job so
   `skyos_application_role` exists in Cloud SQL.
3. Set `application_database_roles_bootstrapped = true`, increment
   `application_database_password_version`, and enable the application login.
4. Supply `TF_VAR_application_database_password` only for that controlled apply.
   The value must never be written to `terraform.tfvars`, committed, logged, or
   copied to Drive in plaintext.
5. Terraform writes the password through write-only provider arguments to both
   the Cloud SQL login and its protected Secret Manager version. The login is
   assigned only `skyos_application_role`, never `cloudsqlsuperuser`.

The password variable is `sensitive` and `ephemeral`; the write-only Cloud SQL and
Secret Manager arguments require Terraform 1.11 or newer. Rotation increments
`application_database_password_version` and supplies a fresh ephemeral password.
The Secret Manager container itself exists even while the login is disabled so the
recovery boundary can be established before activation.

The web runtime receives `DATABASE_URL` from its separately controlled Secret
Manager runtime secret. After the restricted login exists, use the reviewed
[database runtime secret publication runbook](../../docs/operations/database-runtime-secret.md)
to create a new `DATABASE_URL` version without writing the password or URL to a
plaintext file. Pin only the resulting numeric version in Terraform.

## Web runtime activation

The Cloud Run web service is deliberately disabled by default with
`enable_web_service = false`. Committing the Terraform definition does not deploy
or expose the application.

Secret Manager containers are defined for:

- `DATABASE_URL`;
- `AUTH_SECRET`;
- `AUTH_GOOGLE_SECRET`;
- `OPENAI_API_KEY`;
- `ANTHROPIC_API_KEY`; and
- `GEMINI_API_KEY`.

Terraform creates only the web runtime secret containers. It does not create
versions for these runtime secrets and does not accept their values as ordinary
Terraform variables. Secret values must be populated through a separately
controlled operator or deployment path. The web service accepts only pinned
positive numeric Secret Manager version IDs through `web_secret_versions`.

Before `enable_web_service` may be set to true, the configuration requires pinned
versions for `DATABASE_URL`, `AUTH_SECRET`, and `AUTH_GOOGLE_SECRET`, plus the
non-secret Google OAuth client ID. Optional AI provider key versions may be pinned
without changing the service definition; the initial runtime remains configured
with local AI and embedding providers until a separately reviewed provider switch.

The web revision uses the dedicated web service account, Direct VPC egress to the
runtime subnet, the private Knowledge bucket, and the immutable `runtime_image`
digest. Unauthenticated invocation is also disabled by default and requires the
separate explicit `web_allow_unauthenticated = true` decision.

No Terraform change in this root should populate plaintext runtime secrets, upload
service-account keys, or perform an application deployment as a side effect of
source review.

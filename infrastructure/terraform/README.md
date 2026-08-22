# SkyOS GCP Terraform foundation

Terraform is the selected infrastructure-as-code contract for the initial SkyOS
Google Cloud platform. This foundation defines only the non-production regional
Knowledge bucket, workload service-account identities, and exact bucket-scoped
runtime IAM. It does not define Cloud Run, Cloud SQL, networking, Artifact
Registry, OAuth, secrets, or deployment resources.

The authoritative initial region is `europe-west1` (Belgium), as locked by
[ADR 0009](../../architecture/decisions/0009-primary-gcp-region-data-residency.md).
The non-production configuration keeps this value in Terraform locals rather than
accepting a region variable, so a `.tfvars` override cannot deploy it elsewhere.

## State boundary

The checked-in root includes an empty partial GCS backend declaration, but no
state bucket name. **The first real apply is blocked** until a separately reviewed
state-backend bootstrap task creates and secures a private remote backend. Terraform
state is sensitive operational data and must never be committed. This task does not
authorize `terraform apply`. Do not commit local state, `terraform.tfvars`,
credentials, or service-account keys.

Use a temporary local backend only for offline validation:

```sh
cd infrastructure/terraform/environments/nonprod
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

Terraform provider authentication is intentionally absent from committed files.
A future apply identity must use Application Default Credentials or Workload
Identity Federation, never a JSON key. `terraform.tfvars.example` contains only
non-secret placeholders for a project ID and globally unique bucket name.

## Current resource boundary

- one private, regional, Standard Knowledge bucket in `europe-west1`;
- four separate user-managed service-account identities: web, worker, migrator,
  and reconciliation;
- one exact project custom role containing only `storage.objects.create`,
  `storage.objects.get`, and `storage.objects.delete`; and
- bucket-scoped grants of that role to web, worker, and reconciliation only.

The migrator intentionally has no storage grant. The runtime does not need object
listing, direct browser bucket access, public ACLs, signed URLs, CORS, or a bucket
website configuration. A future Cloud Run/Cloud SQL slice must attach these
identities and add only separately reviewed permissions.

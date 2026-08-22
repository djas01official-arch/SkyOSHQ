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

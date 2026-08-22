# SkyOS Terraform remote-state bootstrap

This root manages exactly one private Google Cloud Storage bucket that holds
SkyOS Terraform state. It is separate from the application-data Knowledge bucket.
The state bucket is in `europe-west1`, has Standard storage, uniform bucket-level
access, enforced public-access prevention, seven-day soft delete, and Object
Versioning. Terraform is prevented from destroying it, and `force_destroy` remains
false. State must remain mutable by Terraform; Bucket Lock and object-retention
locks are intentionally absent.

## Bootstrap lifecycle

The GCS backend bucket must exist before Terraform can initialize it. The reviewed
PowerShell operator script creates or verifies that bucket under an already
authorized bootstrap operator identity. It does not embed credentials or use a
service-account key.

1. Run the script's `-WhatIf` mode with the intended project ID and globally
   unique state-bucket name. Review its output.
2. In a separately approved operator session, ensure `storage.googleapis.com` and
   `iam.googleapis.com` are enabled, then run the script without `-WhatIf`.
3. Copy `backend.hcl.example` to ignored `backend.hcl` and fill in only the
   reviewed bucket name.
4. Run `terraform init -backend-config=backend.hcl` from this directory.
5. Import the bucket directly into the initialized remote backend:

   ```sh
   terraform import google_storage_bucket.terraform_state <bucket-name>
   terraform plan
   ```

The first Terraform-managed state is therefore remote at `bootstrap/state`; no
local `terraform.tfstate` is created and later migrated. The initial post-import
plan should contain only resources that did not exist before Terraform took
control: the `skyos-np-terraform` service account, its bucket-scoped state IAM
grant, and the two managed API declarations. Stop if the imported bucket would be
replaced, moved, or weakened (including PAP, UBLA, or versioning changes). Do not
apply automatically.

## Existing-bucket safety

Bucket names are global. The operator script never silently reuses a bucket: if a
bucket already exists, it verifies the requested project's ownership plus its
location, Standard storage class, UBLA, PAP, versioning, soft delete, and expected
labels. A mismatch or unverifiable ownership fails. The script never changes an
arbitrary existing bucket and never deletes one.

## Identity and IAM boundary

The bootstrap root models the dedicated `skyos-np-terraform` user-managed service
account. It has no key and no Owner, Editor, project-wide storage, Knowledge-bucket,
or application-runtime grant. Its sole initial grant is
`roles/storage.objectAdmin` at the **state bucket only**, which is the broader
backend-specific access required to manage Terraform state and lock objects.
Future execution authentication must use ADC, controlled service-account
impersonation, or Workload Identity Federation; no credential configuration belongs
in Terraform files or `backend.hcl`.

The bootstrap operator is trusted only for the transition:

```text
authorized operator ADC
  -> creates/verifies private state bucket
  -> Terraform init against the new bucket
  -> Terraform import into remote state
  -> Terraform manages the execution identity and state-bucket IAM
```

Normal future operation uses the controlled Terraform execution identity and the
remote backend. Its additional project permissions are intentionally deferred to
the infrastructure slices that require them.

## State security, locking, and recovery

Terraform state can contain resource identifiers, service-account emails,
configuration, generated attributes, and future sensitive values. Treat it as
infrastructure-security data: never commit it, paste full state into tickets/chat
or logs, expose it through SkyOS, or grant public access to the bucket.

The GCS backend supports state locking. Do not use `-lock=false`. `force-unlock`
is emergency-only: it requires the lock ID reported by Terraform and explicit
operator review. Recovery is manual and ordered: current remote state first, then
a historical GCS generation through Object Versioning, then soft-delete recovery
when applicable. Any restoration is an incident action followed by a reviewed
Terraform plan; no automated state rollback is provided.

## Offline validation

No backend bucket is configured in Git. For syntax/provider validation only:

```sh
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

The backend configuration file contains no credentials:

```sh
cp backend.hcl.example backend.hcl
```

`backend.hcl` is ignored. The actual backend uses ambient authorized ADC or
approved impersonation, not a JSON key.

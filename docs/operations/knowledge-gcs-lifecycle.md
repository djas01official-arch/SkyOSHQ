# Knowledge / GCS lifecycle operations

This runbook covers the private non-production Knowledge object lifecycle. It does not
authorize destructive storage changes or disclose document content, vectors, credentials,
signed URLs, or authentication headers.

## Runtime contract

| Concern     | Contract                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Ownership   | PostgreSQL `workspaceId`, `documentId`, and attachment ID; never inferred from a client path |
| Object key  | Server-generated `<workspace>/<document>/<attachment>.<validated extension>`                 |
| Upload      | Authenticated application proxy, workspace `knowledge.write`, 10 MiB deployment limit        |
| Types       | PDF and DOCX are ingested; JPEG and PNG are stored/downloadable only                         |
| Integrity   | GCS CRC32C plus stored GCS generation/ETag/size; application SHA-256 checked on download     |
| Concurrency | Create-only `ifGenerationMatch=0`; reads and compensation target the recorded generation     |
| Processing  | `UPLOADED → QUEUED → PROCESSING → PROCESSED → CHUNKING → EMBEDDING → READY`, or `FAILED`     |
| Retrieval   | Active workspace-scoped sources only; embedding provider/model/version/dimensions must match |
| Download    | Authorized app proxy, private/no-store, attachment disposition, CSP sandbox, `nosniff`       |
| Delete      | Logical `ARCHIVED` tombstone; search and download exclude it; physical object remains        |
| Repair      | Scheduled report-only reconciliation; explicit safe enqueue repair only                      |

The durable worker runs extraction, chunking, and embedding. It never falls back to fake
embeddings in production. Parser text and embedding vectors are not logged. Work attempts,
chunk count, extracted text, and reconciliation report arrays are bounded.

## Failure matrix

| Failure                                 | Safe result and recovery                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GCS create fails                        | No database attachment is committed; retry the upload                                                     |
| GCS create succeeds, DB commit fails    | Exact-generation delete is attempted; reconciliation reports an orphan if compensation fails              |
| Metadata exists, object is missing      | Download fails closed; reconciliation reports `attachmentsWithoutBinaries` for operator investigation     |
| Upload exists, enqueue did not complete | Reconciliation reports `unprocessedAttachments`; explicit repair idempotently enqueues extraction         |
| Extraction succeeds, chunking is absent | Reconciliation reports `unchunkedExtractions`; explicit repair enqueues chunking                          |
| Chunking succeeds, embedding is absent  | Reconciliation reports `unembeddedChunkSets`; explicit repair enqueues the configured production provider |
| Worker/provider retryable failure       | Existing bounded background retry applies; domain uniqueness prevents duplicate outputs                   |
| Terminal processing failure             | Attachment is `FAILED`; operator may use the existing authenticated retry path                            |
| Archive requested during active work    | Archive is rejected; retry only after the work reaches a terminal state                                   |

Integrity mismatches and missing binaries are detection-only. Do not automatically rewrite
or delete them; determine the authoritative generation and incident scope first.

## Retention and storage posture

- Bucket: `skyos-np-knowledge-70s14ngb5z` in `europe-west1`, `STANDARD`.
- Uniform Bucket-Level Access is enabled and Public Access Prevention is enforced.
- Object versioning is disabled; application object keys are immutable.
- GCS soft delete is seven days after a physical deletion.
- No lifecycle deletion rule and no retention lock are configured.
- Active and archived live objects have no automated expiry. Archive is recoverable through
  the product restore path. A future physical-erasure policy requires product, security,
  recovery, and legal approval before Terraform changes.

## Read-only live GCS audit

This block only reads GCP resource configuration and IAM.

```powershell
$ErrorActionPreference = "Stop"
$ProjectId = "gen-lang-client-0485875193"
$Bucket = "skyos-np-knowledge-70s14ngb5z"
$Region = "europe-west1"

gcloud storage buckets describe "gs://$Bucket" `
  --project="$ProjectId" `
  --format="json(name,location,storageClass,uniformBucketLevelAccess,publicAccessPrevention,versioning,softDeletePolicy,lifecycle,labels)"

gcloud storage buckets get-iam-policy "gs://$Bucket" `
  --project="$ProjectId" `
  --format=json

gcloud run services describe "skyos-np-web" `
  --project="$ProjectId" `
  --region="$Region" `
  --format="json(spec.template.spec.serviceAccountName,spec.template.spec.containers.image,spec.template.spec.containers.env,status.url)"

gcloud beta run worker-pools describe "skyos-np-worker" `
  --project="$ProjectId" `
  --region="$Region" `
  --format="json(spec.template.spec.serviceAccountName,spec.template.spec.containers.image,spec.template.spec.containers.env)"

gcloud run jobs describe "skyos-np-reconcile" `
  --project="$ProjectId" `
  --region="$Region" `
  --format="json(spec.template.template.spec.serviceAccountName,spec.template.template.spec.containers.image,spec.template.template.spec.containers.env)"
```

Confirm the bucket has no `allUsers` or `allAuthenticatedUsers` binding and the four runtime
service accounts have only the documented bucket roles. The migrator must have no Knowledge
bucket binding. Do not paste environment values or document metadata into an issue or log.

## Terraform pre-deployment gate

This block is read-only except for writing an ignored local plan file. Inspect the complete
saved plan. Any unexpected destroy or replacement is a stop condition.

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS\infrastructure\terraform\environments\nonprod"

terraform fmt -check
terraform validate

$planPath = Join-Path $PWD "skyos-knowledge-lifecycle.tfplan"
$terraformArgs = @(
    "plan",
    "-out",
    $planPath
)

terraform @terraformArgs
terraform show -no-color $planPath
```

Expected changes are limited to Knowledge schema/runtime configuration, bucket-scoped custom
roles/bindings, the durable worker mode, and reconciliation environment. The plan must not
replace or destroy the bucket, Cloud SQL, Cloud Run service, worker pool, reconciliation job,
network, or service accounts.

## Report-only reconciliation

This is a read-only cloud operation. The application job reads database/GCS state and prints
identifier-only drift categories.

```powershell
$ErrorActionPreference = "Stop"
$ProjectId = "gen-lang-client-0485875193"
$Region = "europe-west1"
$Job = "skyos-np-reconcile"

gcloud run jobs execute $Job `
  --project="$ProjectId" `
  --region="$Region" `
  --wait
```

## Explicit safe pipeline repair

This is a mutation. Use it only after reviewing a report. It can enqueue missing Knowledge
work and adjust the attachment processing state; it cannot delete objects, metadata, chunks,
or embeddings.

```powershell
$ErrorActionPreference = "Stop"
$ProjectId = "gen-lang-client-0485875193"
$Region = "europe-west1"
$Job = "skyos-np-reconcile"

gcloud run jobs execute $Job `
  --project="$ProjectId" `
  --region="$Region" `
  --args="jobs:reconcile,--,--repair-knowledge-pipeline" `
  --wait
```

Run the report-only block again. The repaired pipeline categories must converge without
duplicate domain outputs. Missing binaries and integrity mismatches require investigation,
not this repair switch.

## Live lifecycle evidence gate

Use two ordinary, isolated test workspaces/identities and a harmless small PDF with a unique,
non-sensitive marker. Through the deployed UI/API and normal authorization paths, capture
only IDs and counts:

1. Upload in workspace A. Confirm the database attachment and the exact GCS generation,
   CRC32C, ETag, and size exist; confirm the object is not public.
2. Observe durable extraction, chunking, and production Vertex embedding work reach
   `READY`. Record attachment ID, safe object key, generation, chunk count, provider,
   model/version, and dimensions—never vector values or document text.
3. Run semantic search in A and prove the expected chunk from the new attachment is returned.
4. Download in A and compare SHA-256 with the original file.
5. From workspace B, prove search cannot expose A, download returns forbidden/not-found, and
   archive is denied. Prove the symmetric A/B case.
6. Verify malformed IDs, nonexistent IDs, invalid MIME/signature, unsupported types, duplicate
   content, and the configured size boundary fail closed.
7. Archive in A after processing is terminal. Prove search and download no longer expose the
   attachment while GCS behavior matches the logical-tombstone contract.
8. Exercise one controlled retryable parser/provider failure. After retry, prove `READY` and
   exactly one current chunk set and embedding set.
9. Create a supported missing-enqueue drift in non-production, run report → explicit repair →
   worker → report, and prove the second report converges.

Database-row existence alone is not retrieval evidence. A local deterministic provider is
test evidence, not production-embedding evidence.

## Terraform convergence and Git evidence

After deployment and runtime evidence, this read-only plan must say `No changes. Your
infrastructure matches the configuration.`

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS\infrastructure\terraform\environments\nonprod"

terraform fmt -check
terraform validate
terraform plan
```

Then run the complete Git verification gate:

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS"

git status --short
git status
git diff
git diff --cached
git rev-parse HEAD
git log -1 --oneline
git show --stat --oneline HEAD
git show --name-status --oneline HEAD
```

Do not commit `.tfplan`, `.tfstate`, test uploads, GCS dumps, logs, secrets, credentials, or
signed URLs.

# ADR 0011: Knowledge object lifecycle

- Status: Accepted
- Date: 2026-09-12
- Complements: [ADR 0007](./0007-production-hosting-runtime-architecture.md) and [ADR 0009](./0009-primary-gcp-region-data-residency.md)

## Context

SkyOS already stored private Knowledge binaries behind an application-owned `ObjectStorage`
port and kept authorization metadata in PostgreSQL. The previous implementation did not
persist GCS generation metadata, did not automatically connect upload to the durable
parse/chunk/embed pipeline, and could not enumerate GCS objects during reconciliation.

## Decision

PostgreSQL remains the canonical ownership and lifecycle boundary. One attachment belongs
to one workspace and document and has one immutable, server-generated object key:

```text
<workspace UUID>/<document UUID>/<attachment UUID>.<validated extension>
```

The client cannot provide the key. An object path is never sufficient authorization.
Attachment metadata records the original sanitized filename, verified MIME type, byte
length, application SHA-256, GCS CRC32C, ETag, generation, logical status, processing
status, version, uploader, and timestamps. GCS contains the binary body and its content
type; it is not the source of ownership truth.

Uploads are application-proxied and bounded to 10 MiB in the deployed environment. The
server validates authentication, workspace capability, filename, extension, MIME type,
magic bytes, non-empty content, and size before persistence. GCS creation uses
`ifGenerationMatch=0` and CRC32C validation, so it cannot overwrite an existing object.
Reads and compensating deletes target the recorded generation. Downloads recheck byte
length and SHA-256.

Supported ingest formats are PDF and DOCX. PNG and JPEG are accepted as private
attachments but are not described as parseable or searchable. Uploading a parseable file
creates durable extraction work. Successful extraction creates durable chunking work;
successful chunking creates durable production embedding work. The attachment can become
`READY` only after the compatible embedding set succeeds. Work is idempotent through the
existing domain-job and background-job uniqueness constraints and bounded retry policy.

Search uses the same configured embedding provider identity, model version, and dimensions
for stored and query vectors. SQL constructs eligible sources inside the requested
workspace and only includes active documents and active attachments before ranking.

Archive is the current delete contract. It is an optimistic-concurrency tombstone, not a
physical erase: archived attachments disappear from normal list, search, and download
paths while their metadata, chunks, embeddings, and GCS body remain for restoration and
audit. Archive is rejected while extraction, chunking, or embedding is active. Restore is
explicit. Replacement means uploading a new immutable attachment and archiving the old
one after the new attachment is ready; no object overwrite or mixed-version mutation is
introduced.

## Storage policy

The non-production bucket is regional `europe-west1`, `STANDARD`, Uniform Bucket-Level
Access enabled, Public Access Prevention enforced, object versioning disabled, and soft
delete set to seven days. No GCS lifecycle deletion rule or bucket retention lock is added.
Active and archived live objects therefore remain until an explicit, separately approved
physical-deletion policy exists. The seven-day window applies only after a future physical
deletion. This is an operational statement, not a legal/compliance retention promise.

## IAM

- web: object create/get/delete at this bucket only; delete is needed only for upload
  compensation;
- worker: object get at this bucket only;
- reconciliation: object get/list at this bucket only;
- migrator: no Knowledge bucket role.

No runtime identity receives `roles/storage.admin`, public ACL management, bucket policy
mutation, or Terraform-state access from this design.

## Recovery and reconciliation

Cross-system upload cannot be atomic. A database failure after object creation attempts an
exact-generation compensating delete. If that cleanup fails, paginated reconciliation
reports the object without metadata. It also reports metadata without objects, integrity
metadata drift, incomplete domain outputs, unprocessed attachments, unchunked extractions,
unembedded chunk sets, failed background jobs, archived records, and impossible orphan
chunk/embedding references.

Scheduled reconciliation remains report-only. The explicit
`--repair-knowledge-pipeline` mode performs only safe idempotent enqueue repair for missing
extraction, chunking, or embedding work. It never deletes data or silently repairs binary
integrity. A second run converges because the normal uniqueness and active-job checks are
authoritative.

## Consequences

- Object races and accidental overwrite are fail-closed.
- Logical deletion is immediately enforced by normal application reads but does not claim
  physical erasure.
- Reconciliation can detect GCS/DB and pipeline drift without unbounded in-memory object
  listing or destructive scheduled cleanup.
- The current proxy download buffers at most the configured 10 MiB limit; raising that
  limit requires a separately reviewed streaming/resumable design.
- Uploaded document content is treated only as untrusted parser input and retrieval data;
  it is never executed or used as a shell command.

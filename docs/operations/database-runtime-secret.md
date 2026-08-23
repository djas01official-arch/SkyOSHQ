# SkyOS database runtime secret publication

## Purpose

The Cloud Run web runtime consumes `DATABASE_URL` from GCP Secret Manager. The
restricted Cloud SQL application password is stored separately in
`skyos-np-db-application-password`.

The publisher script creates a new version of `skyos-np-database-url` without
placing the database password or resulting URL in GitHub, Google Drive,
`terraform.tfvars`, Terraform outputs, command-line arguments, or a plaintext
staging file.

This is an explicit operator mutation. Do not run it merely while reviewing or
preparing infrastructure source.

## Preconditions

Before publishing a runtime URL:

1. the non-production Terraform foundation has been applied;
2. the `skyos_application` login exists and uses `skyos_application_role`;
3. `skyos-np-db-application-password` has a current Secret Manager version;
4. `skyos-np-database-url` exists as the web runtime Secret Manager container;
5. the operator is authenticated to the reviewed GCP project with only the
   permissions required to access the source secret and add a version to the
   target secret; and
6. the private Cloud SQL IPv4 address has been read from reviewed Terraform
   output or equivalent trusted GCP metadata.

## Publish

From the repository root, run only during a controlled activation or rotation:

```powershell
pnpm gcp:database-url:publish -- `
  --project-id <gcp-project-id> `
  --database-host <private-cloud-sql-ip>
```

Optional flags exist for a reviewed non-default database name, database user,
port, source password secret ID, or target runtime secret ID. Normal SkyOS
non-production operation should use the committed defaults.

The script:

1. verifies both Secret Manager containers exist;
2. reads the latest application database password into process memory;
3. percent-encodes credentials while constructing the PostgreSQL URL in memory;
4. sends the URL to `gcloud secrets versions add --data-file=-` through stdin;
5. never prints the password or `DATABASE_URL`; and
6. prints only the new numeric Secret Manager version.

## Pin the new version

After publication, record only the returned numeric version in the ignored
non-production Terraform configuration:

```hcl
web_secret_versions = {
  DATABASE_URL       = "<new-version>"
  AUTH_SECRET        = "<reviewed-version>"
  AUTH_GOOGLE_SECRET = "<reviewed-version>"
}
```

Version numbers are not secrets. Secret values remain in GCP Secret Manager.
Do not copy the database URL or application database password into the Drive
recovery bundle; database credentials follow the GCP Secret Manager versioning
and controlled-rotation recovery policy.

## Failure handling

The publisher intentionally emits only a generic failure message for gcloud or
validation errors so secret material cannot be copied into logs by the wrapper.
Investigate authentication, project selection, secret existence, and the private
Cloud SQL endpoint without printing secret values.

If a new runtime secret version was created but activation is abandoned, leave the
old pinned version in Terraform until the new version is reviewed. Unused secret
versions may be disabled later through the controlled credential-rotation process.

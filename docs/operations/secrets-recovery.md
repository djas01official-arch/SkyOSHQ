# SkyOS secrets recovery

## Purpose

SkyOS source backups and secret recovery are deliberately separate systems.

- GitHub and `SkyOS Backups` contain source code only.
- Production secrets belong in GCP Secret Manager.
- `SkyOS Secret Recovery` on Google Drive may contain only encrypted recovery bundles and non-secret checksums.
- The private recovery identity must never be stored in GitHub, Google Drive, email, chat, CI variables, or the SkyOS backup folders.

## Recovery storage layout

```text
SkyOS Secret Recovery/
├── current/
│   └── skyos-secrets-recovery-latest.age
└── snapshots/
    ├── skyos-secrets-recovery-<timestamp>.age
    └── skyos-secrets-recovery-<timestamp>.age.sha256
```

The Drive copy is an additional disaster-recovery layer. It does not replace GCP Secret Manager versioning or credential rotation.

## Encryption model

SkyOS uses `age` recipient encryption for recovery bundles.

- The public recipient is safe to use on the machine that creates backups.
- The private identity decrypts the bundle and is therefore the recovery root of trust.
- The bundle creator pipes plaintext directly to `age`; it does not create a plaintext staging file.
- Encrypted output is written under `.skyos/recovery/`, which is already ignored by Git.

A current `age` installation and PowerShell 7 are expected for these scripts.

## One-time key initialization

Run this on a trusted local machine:

```powershell
pwsh ./scripts/security/initialize-secret-recovery-key.ps1
```

By default this creates the private identity outside the repository under the user's home directory. The script prints only the public recipient for normal use.

After generation:

1. Keep the private identity outside the SkyOS repository.
2. Make at least one separate offline recovery copy of the private identity.
3. Do not put that private identity in Google Drive or GitHub.
4. Set the public recipient only for the session that creates a bundle:

```powershell
$env:SKYOS_RECOVERY_AGE_RECIPIENT="<public age recipient>"
```

## Create an encrypted recovery bundle

The recovery manifest is an allowlist. Only secret names explicitly marked with `includeInLocalEnvBundle: true` can be read from the local `.env` file.

```powershell
pwsh ./scripts/security/new-secret-recovery-bundle.ps1
```

The script:

1. reads the allowlist from `security/secrets-recovery.manifest.json`;
2. reads only those names from local `.env`;
3. constructs the recovery payload in memory;
4. pipes it directly to `age`;
5. writes an armored `.age` file and SHA-256 checksum under `.skyos/recovery/encrypted/`;
6. prints secret names only, never values.

Upload only the encrypted `.age` file and optionally its `.sha256` file to `SkyOS Secret Recovery/snapshots`. The newest encrypted bundle may also be copied to `SkyOS Secret Recovery/current` as `skyos-secrets-recovery-latest.age`.

## Restore

Download the desired encrypted `.age` bundle locally and run:

```powershell
pwsh ./scripts/security/restore-secret-recovery-bundle.ps1 `
  -InputFile "<downloaded .age file>" `
  -IdentityFile "<offline private identity path>"
```

The restore script does not print secret values. It writes plaintext JSON only to `.skyos/recovery/restored/`, an ignored local path.

After an emergency restore:

1. restore only the systems that need the credentials;
2. rotate credentials when the manifest says to rotate them;
3. verify applications use the new values;
4. delete the temporary plaintext restored JSON when recovery is complete.

## Current recovery policy

The manifest currently covers:

- `AUTH_SECRET`
- `AUTH_GOOGLE_SECRET`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

Cloud SQL credentials are deliberately outside the local `.env` recovery bundle:

- the nonprod migrator password is recovered through GCP Secret Manager versioning or a controlled password reset/rotation;
- the restricted nonprod application database password is likewise stored in GCP Secret Manager and recovered through versioning or controlled rotation;
- neither database password should be copied into `SkyOS Secret Recovery` merely to duplicate GCP Secret Manager.

If an application database credential must be rotated, use the controlled Terraform/operator path with a fresh ephemeral password and incremented write-only rotation version, then update the dependent runtime secret version before enabling or rolling the web service.

Local development-only credentials such as test PostgreSQL passwords are not part of the disaster-recovery bundle.

## Rules that must not be relaxed

- Never commit plaintext secrets.
- Never commit or upload the private `age` identity.
- Never copy `.env` directly to Drive.
- Never include Terraform state or real `terraform.tfvars` in secret recovery.
- Never print recovered secret values in logs, CI output, issues, or chat.
- A leaked encrypted bundle is treated as sensitive, but a leaked private recovery identity is treated as a credential incident.

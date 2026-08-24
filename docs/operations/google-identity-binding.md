# Google OIDC closed-enrollment binding

## Purpose

Production Google OIDC is closed enrollment. A Google identity is admitted only when its exact
OIDC `sub` is already bound to an active SkyOS `User` through the application-owned binding
logic. Email is never a binding key.

The normal trusted-terminal command remains:

```sh
pnpm auth:google:bind
```

That command is interactive and requires direct access to the private production database. For
the initial non-production bootstrap, when there is exactly one active non-deleted SkyOS user,
use the one-shot Cloud Run operator command below instead.

## Safety boundary

`pnpm gcp:auth:google:bind-bootstrap`:

- uses the currently authenticated `gcloud` Google account and decodes its ID token only in local
  process memory;
- never prints the raw Google `sub`, ID token, database password, or `DATABASE_URL`;
- copies only the raw `sub` into a temporary Secret Manager version through stdin;
- reuses the latest ready web image so the binder executes the exact deployed
  `bindGoogleIdentity()` implementation;
- reuses the reviewed migrator database bootstrap identity and private VPC path;
- requires exactly one active, non-deleted SkyOS user and uses that same user as trusted operator
  and binding target;
- fails closed when there are zero or multiple active users;
- writes the normal append-only identity audit event through `bindGoogleIdentity()`; and
- destroys the temporary binding-request Secret Manager version after the Cloud Run execution.

The created Cloud Run Job remains as execution metadata, but its request secret version is
destroyed, so it cannot be replayed with the original subject.

This bootstrap command is not a public enrollment mechanism and must not be changed to match by
email, automatically select among multiple users, or write directly to the `accounts` table.

## Preconditions

1. Google OIDC has reached the SkyOS callback successfully.
2. The latest identity audit result is `google_identity.sign_in_rejected_unknown`.
3. Reviewed Prisma migrations are already applied.
4. The application database role has its reviewed runtime object privileges.
5. `skyos-np-migrator-role-bootstrap` exists and targets the same private SkyOS database.
6. The operator has authenticated `gcloud` with the same Google account that should sign in to
   SkyOS.
7. Exactly one active, non-deleted SkyOS user exists. If there are multiple users, stop and use
   the interactive trusted-terminal binding workflow instead.

Inspect the active `gcloud` account locally before running the mutation. Do not paste the account
identifier, token, or decoded subject into tickets, chat, logs, or documentation.

## Execute

From the repository root:

```powershell
pnpm gcp:auth:google:bind-bootstrap -- `
  --project-id <gcp-project-id> `
  --confirm-current-google-account
```

The region defaults to `europe-west1`. Optional reviewed overrides are available for the web
service, role-bootstrap job, region, and temporary request-secret container.

A successful run prints only a result similar to:

```text
Google identity binding: PASS (skyos-np-google-bind-...)
```

It does not print the Google subject.

## Verify

Start a completely fresh browser sign-in against the deployed `/login` page. A successful login
must reach the authenticated application and the identity audit history must record
`google_identity.sign_in_succeeded`.

Do not disable rollback authentication secret versions until this fresh browser verification has
succeeded.

## Failure handling

- `Google identity binding: FAIL` means no success should be assumed. Inspect Cloud Run execution
  status and generic binder logs, but do not print secret environment values.
- If the job reports a single-user bootstrap guard failure, do not weaken the guard. Use
  `pnpm auth:google:bind` from an approved trusted terminal with private database access and supply
  explicit operator and target `User.id` values.
- Do not repair binding failures with manual SQL inserts or updates.
- Do not copy Google ID tokens or OAuth tokens into Secret Manager, shell history, logs, or chat.

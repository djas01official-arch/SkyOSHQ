# ADR 0002: Auth.js with stable SkyOS user identities

- Status: accepted
- Date: 2026-08-10

## Context

SkyOS needs a provider-neutral authentication boundary that works with the existing Next.js App Router, Prisma schema, and application-owned authorization policy. Authentication must establish one stable internal actor without treating an email address, browser-supplied tenant identifier, role, or permission as authority. The MVP also needs a safe development sign-in path while leaving external identity providers, enrollment flows, and enterprise identity lifecycle automation for later decisions.

The repository already uses Auth.js, its Prisma adapter, a development-only credentials provider, Argon2id password hashes, and signed JWT sessions. Replacing that working foundation would add migration and operational risk without improving the current scope.

## Decision

### Identity

`User.id` is the stable SkyOS actor identifier and the JWT subject. Email is only a mutable sign-in identifier for the development credentials provider; it is never used for authorization or historical attribution. A provider identity is represented by one `Account` row whose `(provider, providerAccountId)` pair is unique and whose `userId` references exactly one SkyOS `User`. The development seed uses the unique `User.identitySubject` to retain the same internal user across seed runs.

Deactivation, suspension, and soft deletion update the existing `User` instead of deleting attribution records. Provider unlinking or a future email change must not create a replacement actor implicitly.

### Sessions and cookies

Auth.js issues an encrypted and signed JWT session with `User.id` as its subject. The maximum session lifetime is eight hours. The session token cookie is:

- `HttpOnly` so client-side JavaScript cannot read it;
- `SameSite=Lax` to reduce cross-site request risk while preserving normal top-level navigation;
- scoped to `/`;
- `Secure` and `__Secure-` prefixed in production.

`AUTH_SECRET` must be an environment-provided, non-placeholder value of at least 32 characters. It is never sent to the browser or logged. Rotating it invalidates all outstanding JWT sessions.

Auth.js owns token encryption, signature and expiry validation, auth-endpoint CSRF checks, and cookie creation/removal. Login and logout remain server actions. SameSite cookies supplement rather than replace Auth.js request validation.

### Session validation and invalidation

Every successful session resolution re-resolves the signed JWT subject against PostgreSQL. A missing, suspended, deactivated, or soft-deleted user produces no effective authenticated session. This means an account-status change takes effect on the next request even when a previously valid JWT still exists.

Logout calls Auth.js `signOut`, which expires the active browser cookie. Because sessions are stateless, there is no per-token server-side revocation record: a copied token remains cryptographically valid until its eight-hour expiry unless the user is made inactive or `AUTH_SECRET` is rotated. Server-side session registries, device management, and selective revocation require a future ADR if product requirements demand them.

### Route and tenant authorization

Next.js `proxy.ts` protects `/dashboard`, `/ai`, `/knowledge`, `/tasks`, and `/settings`, including nested routes. Protected pages and server actions also resolve the current active user server-side; proxy enforcement is not the sole control.

Organization and workspace identifiers stored in a session are selection preferences only. Services re-resolve memberships and resource scope from PostgreSQL and evaluate permissions through `@skyos/domain`. Browser-supplied IDs, roles, and permissions never grant access. Authentication answers who the actor is; domain services answer what that actor may do.

Login accepts only sanitized same-origin paths and falls back to `/dashboard`, preventing protocol-relative, absolute, backslash, control-character, and login-loop destinations. Authentication failures are intentionally generic.

## Consequences

- Credential sign-in remains a local-development mechanism, not a production user-provisioning solution.
- Session reads perform an active-user database lookup, trading one indexed query for prompt account-status enforcement.
- Changing a user's email does not change their SkyOS identity, memberships, ownership, authorship, or audit attribution.
- Existing Prisma `Account` rows can support future OAuth or OIDC providers without changing the authorization identity.
- CI exercises credential mapping, active-user resolution, cookie configuration, route authorization predicates, and redirect validation through the existing database test job.

## Out of scope

- Registration, invitations, password reset, email verification, MFA, SSO, and SCIM.
- OAuth or OIDC provider selection and provider-specific account-linking policy.
- Recovery codes, trusted-device management, session enumeration, and selective JWT revocation.
- Authorization policy changes, custom roles, service accounts, and browser-managed permissions.

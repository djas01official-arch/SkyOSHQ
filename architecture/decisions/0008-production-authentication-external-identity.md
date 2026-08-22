# ADR 0008: Production Authentication and External Identity

- Status: Proposed
- Date: 2026-08-22
- Supersedes: none
- Complements: [ADR 0002](./0002-authentication.md), [ADR 0007](./0007-production-hosting-runtime-architecture.md)

## Context

ADR 0002 established Auth.js, Prisma, a stable internal `User.id`, Auth.js
`Account` identity mappings, and eight-hour JWT sessions. The Credentials
provider is now deliberately registered only in `development` and `test`.
Production and unknown runtimes expose neither a Credentials callback nor a
credential form, so production sign-in is correctly unavailable until a real
identity provider is selected and implemented.

SkyOS is an organization and workspace application. Its domain model makes
SkyOS, not an identity provider, authoritative for organization membership,
workspace membership, roles, permissions, user status, and audit attribution.
The database already expresses the key external-identity invariant:

```text
(provider, providerAccountId) -> one Account -> one stable User.id
```

`Account(provider, providerAccountId)` is unique and points to one `User`.
`User.id` remains the JWT subject and the attribution identity even when a
contact email, a provider profile, or a provider link changes. A signed session
is re-resolved to an active, non-deleted SkyOS user on every effective request.

The repository contains no public registration, invitation, enrollment, domain
allow-list, SSO, MFA, SCIM, or production administrator-provisioning feature.
It contains no accepted product requirement for consumer-only access, Google
Workspace-only access, or domain-based admission. Organization creation after a
development credential sign-in is local-development bootstrap behavior; it is
not a production enrollment design.

### Product-requirement evidence

| Classification            | Evidence and implication                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed requirement     | A stable internal actor, explicit organization/workspace memberships, deny-by-default authorization, active-user checks, immutable attribution, and Auth.js `Account` mapping are implemented and accepted.                                                                     |
| Likely future requirement | The domain model and hosting ADR explicitly leave invitations, external identity lifecycle, enterprise SSO, MFA, and SCIM to future work. Enterprise federation and lifecycle automation should therefore remain possible without changing `User.id` or SkyOS authorization.    |
| Not currently defined     | Public registration, approved-domain admission, consumer-account policy, Workspace-only policy, invitation UX, self-service account linking, MFA assurance requirements, SAML, SCIM, and IdP-owned organization tenancy. They must not be inferred or enabled by this decision. |

## Decision

### Initial provider strategy

Use **direct Google OpenID Connect through the existing Auth.js and Prisma
adapter boundary** as the single initial production provider. The registered
provider identity is `google`; `providerAccountId` is the Google OIDC `sub`
claim, never an email address. This is Option A: a direct Auth.js OAuth/OIDC
provider integration.

This is the smallest safe launch path because it reuses the existing Auth.js
session lifecycle and `Account` model, leaves organization/workspace tenancy in
SkyOS, and requires only one server-side client configuration. Google documents
that `sub` is unique, never reused, and does not change when a Google Account's
email changes; it also says not to use email as a primary user key. The provider
and Auth.js perform OAuth/OIDC protocol validation, including the configured
client audience. SkyOS additionally requires the resulting profile to contain a
valid issuer, non-empty `sub`, and a verified email before it admits the
pre-provisioned identity.

The initial provider accepts a Google identity only when it has already been
explicitly bound to a SkyOS user. It neither authorizes every Google account nor
uses Google Workspace membership as authorization. Consumer and Google Workspace
accounts are therefore technically compatible with the provider, but actual
access is solely determined by the pre-provisioned subject binding. A product
domain restriction is intentionally **not** selected in this ADR. If a future
launch requires an approved domain, it must validate the signed `hd` claim, not
the email suffix, and still must not grant SkyOS access or membership.

The launch has one provider, one exact provider configuration, and closed
enrollment. Generic OIDC, a second social provider, enterprise SAML, and an IdP
tenant-per-SkyOS-organization mapping are not part of this implementation.

Generic OIDC is feasible later because Auth.js and the existing provider-qualified
`Account` mapping do not make Google an authorization identity. It would require
an independently reviewed issuer/discovery document, client configuration,
profile/subject validation, pre-provisioning/linking contract, callback, and
operational ownership for each issuer. It is not an initial configuration toggle:
accepting an arbitrary issuer would enlarge the authentication boundary without a
defined product requirement.

### Why the alternatives are not selected now

| Option                                                                 | Fit and capability                                                                                                                                                                                                                                                                                                                                                                 | Decision for initial launch                                                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Direct Auth.js Google OAuth/OIDC (selected)                         | Directly fits Auth.js plus the existing Prisma `Account` mapping; keeps SkyOS `User.id`, membership, and authorization authoritative. Google OIDC supplies a durable subject and standard OAuth/OIDC protocol controls. It has the smallest new operational surface.                                                                                                               | Select one Google OIDC provider with closed enrollment. Generic OIDC remains a future provider integration, not a configuration switch.                                   |
| B. Google Cloud Identity Platform                                      | Identity Platform supports OIDC, SAML, MFA, identity tenants, user-management APIs, and enterprise operating controls. It aligns operationally with GCP/Cloud Run, but would introduce an additional user lifecycle, token model, tenant construct, configuration plane, and usage/cost surface. Its identity tenants are not SkyOS organizations and must not be treated as such. | Do not select initially. Re-evaluate when product requirements need provider-managed MFA, enterprise federation, provider lifecycle administration, or multi-IdP tenancy. |
| C. Dedicated external identity platform (Auth0, WorkOS, or equivalent) | This class can provide enterprise OIDC/SAML, MFA, SCIM, lifecycle automation, and enterprise support. It also adds vendor contracts, webhooks/admin APIs, cost complexity, and a second operational control plane.                                                                                                                                                                 | Do not select before a confirmed enterprise SSO/SCIM requirement. Compare concrete vendors in a future ADR rather than adopting feature breadth speculatively.            |

This decision deliberately favors compatibility with the accepted Auth.js model,
stable actor preservation, explicit linking, a small attack surface, Cloud Run
server-side secret handling, and a reversible future migration over maximum
identity feature count. It does not claim MFA enforcement, SAML, or SCIM.

## Enrollment and provisioning

### Initial launch policy: closed enrollment with operator pre-provisioning

Initial production access uses **operator pre-provisioning**. Before a first
Google login, a trusted SkyOS provisioning operator must create or select the
active SkyOS `User` and create the exact Google `Account` binding for the known
Google subject. The operation is a controlled, auditable administrative process;
the implementation details and user-verification procedure are a follow-up.

Authentication is not enrollment:

- A valid Google identity alone must not create a SkyOS `User`.
- It must not create an organization, organization membership, workspace
  membership, role, or permission.
- Provider claims, including `email`, `email_verified`, and `hd`, must not grant
  a SkyOS role, permission, organization, or workspace access.
- An unknown subject, an ambiguous mapping, or an inactive/deleted SkyOS user
  fails closed with the same generic sign-in outcome.

Auth.js adapter automatic user creation is **not acceptable** for this launch.
The implementation must establish an admission guard before any adapter path can
create a `User` or link an `Account`. A callback that only rejects after Auth.js
has performed an adapter write is insufficient. The implementation task must
prove its callback/order behavior with integration tests and prove that an
unknown Google subject leaves zero `User`, `Account`, membership, and audit
success records. It may use a deliberately constrained adapter/provider boundary
or another documented pre-persistence admission mechanism, but must not replace
the stable-identity model.

Invitations with a pending identity binding, approved-domain auto-provisioning,
public just-in-time provisioning, and SCIM provisioning are deferred. An
invitation flow is the preferred future alternative to manual operator
pre-provisioning, but it must be designed separately and must bind a durable
provider subject before it activates access.

## Stable identity and account linking

### Mapping rules

1. `User.id` is the immutable internal SkyOS actor and JWT subject. It never
   changes due to Google profile changes, a provider unlink, or a changed email.
2. `Account.provider` is the canonical configured provider key (`google` for the
   initial provider). `Account.providerAccountId` is the Google `sub` string.
3. One `(provider, providerAccountId)` maps to exactly one `Account` and exactly
   one `User.id`. The database unique constraint remains mandatory.
4. The pre-provisioned account mapping must be found before authentication can
   establish a SkyOS session. An `Account` already linked to another `User` is a
   conflict, not a reason to merge, move, or replace actors.
5. `identitySubject` remains an optional SkyOS field; it must not become a
   competing external-identity authority or replace the provider-qualified
   `Account` invariant.

### Email policy

Google login requires a provider-verified email as a minimum profile-quality
condition for the initial provider. Email is mutable contact/display/discovery
metadata only:

- First Google login must **not** link a pre-existing `User` by matching email.
- A matching email with no matching pre-provisioned `Account` is an unknown
  identity and fails closed.
- A provider email change must not change `User.id`, memberships, ownership,
  author attribution, audit attribution, or the `Account` mapping.
- SkyOS must not silently update `User.email` from a provider response. A future
  controlled contact-email update needs conflict handling and an audit event.
- Two providers may report the same email. They remain separate identities until
  a future authenticated, audited linking process explicitly binds each provider
  subject to the same existing `User.id`.

### Linking and unlinking policy

There is no logged-out browser linking flow and no self-service provider linking
at initial launch. Linking a second provider or repairing a mapping requires an
authenticated existing SkyOS session, recent/appropriate reauthentication as
defined by the future operation, an explicit user intent, server-side identity
verification, conflict checks, and an append-only audit event. It must never be
initiated merely because two provider profiles share an email address.

An account cannot be linked if its provider-qualified subject already belongs to
another `User`. Such a conflict fails closed and is auditable without revealing
which account holds the binding. Provider unlinking is an explicit privileged
operation; it must preserve historical attribution, must never create a
replacement actor, and must not leave a user with no approved login method
unless a future recovery policy explicitly permits it. No unlinking UI is
authorized by this ADR.

## Authorization boundary and lifecycle

The production flow remains:

```text
Google OIDC
  -> Auth.js protocol/provider validation
  -> pre-persistence closed-enrollment admission
  -> Account(google, Google sub)
  -> stable SkyOS User.id
  -> signed SkyOS JWT subject
  -> active-user revalidation
  -> SkyOS organization/workspace membership and permission resolution
```

Google authenticates an external identity. SkyOS databases and application
policy decide whether its stable actor is active and what the actor can do.
Neither an IdP claim, a bearer token, a selected organization/workspace value,
nor a client-supplied role is SkyOS authorization authority.

An IdP account being disabled, consent being revoked, or an upstream session
ending does not automatically change SkyOS authorization unless a future,
reviewed lifecycle integration performs an explicit SkyOS transition. Conversely,
suspending, deactivating, or soft-deleting the SkyOS user immediately eliminates
effective sessions on the next request, regardless of an otherwise valid
upstream identity. Removing or suspending an organization membership similarly
removes its effective access under the existing domain rules.

Future SCIM may create, suspend, deactivate, or pre-bind users through an
application-owned provisioning boundary, but it must never directly assign
authorization from external claims. It must emit SkyOS audit events and preserve
the same stable actor and membership invariants.

## Session, logout, and MFA boundary

SkyOS retains the Auth.js JWT strategy, encrypted/signed session cookie,
eight-hour maximum lifetime, `HttpOnly`, `SameSite=Lax`, path `/`, and
production `Secure`/`__Secure-` cookie settings from ADR 0002. Every effective
session continues to re-check the SkyOS user is active and not soft-deleted.
`AUTH_SECRET` rotation invalidates all SkyOS JWT sessions.

Local logout expires the SkyOS cookie. It is separate from Google logout and
Google token revocation; this initial integration does not promise single logout
or upstream-session termination. Because SkyOS only uses Google to authenticate
and does not call Google APIs on a user's behalf, it should request the minimum
OIDC scopes (`openid`, `profile`, `email`) and should not retain Google access or
refresh tokens. The implementation must configure the provider/adapter so token
fields are absent or discarded rather than treating provider tokens as
application state.

Initial MFA policy is **rely on the upstream Google account's security controls,
without asserting SkyOS-enforced MFA assurance**. Standard OIDC profile claims
do not by themselves establish a SkyOS MFA assurance contract. SkyOS must not
claim MFA compliance, require a factor from a claim it has not designed to
validate, or add application MFA in this slice. A regulated or high-assurance
requirement is a launch blocker until a future IdP/MFA ADR defines verifiable
assurance, step-up behavior, recovery, and tests.

## Secrets, origin, and callback contract

The production implementation requires only abstract, server-side deployment
configuration:

- a Google OAuth/OIDC client ID and client secret stored as separate web-service
  Secret Manager values (or an equivalent controlled secret facility);
- one explicit canonical HTTPS SkyOS production origin and its exact registered
  Auth.js callback URL;
- TLS termination and an explicitly trusted Cloud Run proxy/host configuration;
- a valid server-only `AUTH_SECRET` with the existing rotation runbook; and
- a deployment-time provider enablement switch that fails closed when the
  provider ID, client configuration, trusted host/origin, callback, or secret is
  missing, malformed, or placeholder.

No production callback may use localhost, a LAN address, a host-derived URL, or
an untrusted forwarded host. Final SkyOS redirects remain validated relative
application paths under the existing same-origin redirect boundary. Production
images, client bundles, logs, and source must contain no OAuth secret, auth code,
provider token, session JWT, or development credential.

## Failure behavior

All identity failures are generic to the browser and fail closed. The
implementation may record only an allowlisted internal category, never raw
provider payloads or tokens.

| Condition                                                                       | Required SkyOS behavior                                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Provider unavailable or disabled                                                | No session; generic sign-in failure; no Credentials fallback.                |
| OAuth state/CSRF, nonce, issuer, audience, or callback validation failure       | No session or account/user mutation; generic failure.                        |
| Missing or malformed Google `sub`                                               | No session or mapping mutation; generic failure.                             |
| Unverified or missing email                                                     | No session; no linking or profile update; generic failure.                   |
| Unknown or unprovisioned subject                                                | No session and no automatic user/account/membership creation.                |
| Conflicting existing account link                                               | No session change, actor merge, or reassignment; generic failure.            |
| Suspended, deactivated, or deleted SkyOS user                                   | No effective session, even if Google authentication succeeds.                |
| Missing production secret, exact origin, trusted host, or callback registration | Provider remains unavailable; startup/configuration validation fails closed. |

## Audit requirements

The existing append-only audit discipline must extend to production identity
operations. Exact event names are an implementation decision, but the following
events must carry a timestamp, applicable actor/target IDs, provider identifier,
and only non-sensitive structured metadata:

- external sign-in success and allowlisted failure category;
- rejected unknown/unprovisioned identity;
- first provider-account binding and any rejected conflicting binding;
- privileged provider unlink and any controlled re-link;
- operator provisioning and future invitation creation/acceptance;
- SkyOS user suspension, deactivation, restoration where supported, and relevant
  organization/workspace membership removal; and
- future SCIM provisioning, suspension, and deprovisioning.

Audit data must never contain OAuth authorization codes, ID/access/refresh
tokens, client secrets, session JWTs, raw provider error text, or full provider
profiles. Failed unknown identity attempts must not disclose account existence.

## Enterprise SSO and SCIM evolution

Direct Google OIDC is a launch boundary, not a claim that it fulfills enterprise
federation. A future enterprise identity ADR may add a generic OIDC provider,
SAML through an evaluated external platform, or a dedicated identity platform
when a customer requirement justifies the operational complexity. It must add
each provider as a distinct `Account.provider` namespace, preserve all existing
provider-qualified bindings, and use an explicit authenticated linking flow.

SCIM is deferred until its lifecycle contract is defined. Future SCIM records
must resolve to stable SkyOS users through an idempotent external subject mapping,
apply only permitted user-lifecycle and pre-provisioning operations, retain
historical attribution, and leave organization/workspace roles to SkyOS-owned
authorization services. IdP tenants and SkyOS organizations must remain separate
models unless a later product decision defines their relationship.

## Consequences

- Production sign-in can be implemented without reworking sessions, tenancy, or
  the Prisma external-account invariant.
- Launch access is intentionally operationally constrained: an operator needs a
  trusted way to obtain and pre-bind a user's Google subject before first login.
- Public onboarding, invitations, self-service linking, MFA assurance, SSO, and
  SCIM stay unavailable rather than being accidentally implied by Google sign-in.
- Google is a concrete vendor dependency for launch, but its use remains behind
  Auth.js and provider-qualified `Account` records. A later provider can coexist
  without changing `User.id` or authorization data.
- Identity Platform and dedicated identity platforms remain viable only after a
  product need outweighs their additional lifecycle, operational, and cost
  complexity.

## Follow-up implementation slice

Implement **one production Google OIDC provider with operator pre-provisioned
subject bindings and closed-enrollment admission**. Do not combine it with
invitations, multiple IdPs, SAML, SCIM, public sign-up, or application MFA.

Expected code areas, subject to an implementation-time Auth.js ordering proof:

1. `apps/web/auth.ts` and a new small server-only provider/admission module to
   register Google only in production, validate the required profile properties,
   and reject unknown subjects before adapter writes.
2. `apps/web/app/login/page.tsx` and the login presentation component to render
   a provider sign-in affordance only when production configuration is valid;
   development Credentials behavior stays isolated and unchanged.
3. A narrowly scoped application-owned provisioning/linking service over
   `User`/`Account`, with transactional uniqueness/conflict handling and
   append-only identity audit events. It must not grant membership or roles.
4. Auth, database, and black-box tests proving pre-provisioned login, no
   auto-provisioning, verified-email rejection, conflicting-link denial,
   suspended-user denial, safe relative redirects, no persisted provider tokens,
   and unchanged development/test Credentials behavior.
5. Deployment documentation for server-only secrets, exact HTTPS callback,
   trusted host/proxy configuration, key rotation, and a rollback procedure that
   disables the provider without falling back to Credentials.

## Official sources

Sources were reviewed on 2026-08-22:

- [Google OpenID Connect API reference](https://developers.google.com/identity/openid-connect/reference) — durable `sub`, mutable email, `email_verified`, and `hd` semantics.
- [Google OIDC integration and token-validation guidance](https://developers.google.com/identity/openid-connect/openid-connect) — issuer, audience, signature, expiry, and hosted-domain validation.
- [Google Cloud Identity Platform overview](https://docs.cloud.google.com/identity-platform/docs) — OIDC, SAML, MFA, and multi-tenancy capability surface.
- [Google Cloud Identity Platform multi-tenancy](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy) — provider identity tenants are separate user/configuration silos.
- [Google Cloud Identity Platform MFA guide](https://docs.cloud.google.com/identity-platform/docs/web/mfa) — MFA requires explicit identity-platform configuration and verified email.
- [Auth.js provider configuration overview](https://authjs.dev/) — Auth.js provider integration shape used by the existing application.

---
title: RFC — @papercusp/tooldef auth & security model (research-backed redesign)
slug: tooldef-auth-rfc-2026-05-31
status: draft
created: 2026-05-31
owner: avi@storewolf.com
related: [papercusp-tooldef-extraction-2026-05-29, BRIEF-tooldef-shared-repo-2026-05-30]
---

# RFC — `@papercusp/tooldef` auth & security model

## Now

**State:** Proposal / draft, `needs-human` ratification. `@papercusp/tooldef` (now a
shared repo consumed by papercup + Restart) has never had a dedicated security pass.
Consumers have papered over the gaps with imperative, app-specific guards
(`requireAdminKey`, `requireStaff` in Restart; ad-hoc checks in papercup) — scattered,
un-testable, easy to omit, and coupled to one app. This RFC surveys how established
transport/tool frameworks handle auth, then proposes a **general, host-agnostic**
model: pluggable authN → declarative coarse authZ gate → pluggable fine-grained PDP,
with framework-enforced security invariants. Grounded in a 2026-05-31 web survey
(sources at the end).

**Next:** ratify the design (esp. the four open decisions at the bottom), then
implement additively in `@papercusp/tooldef` — coordinated with the agent currently
developing tooldef (this RFC is intentionally NOT committed into `Papercusp/tooldef`).

## 1. Problem

- **Imperative authZ doesn't scale.** `requireAdminKey(req)` / `requireStaff(req)` live
  in handler bodies → logic repeats, can't be tested in isolation, is silently
  omittable (a new endpoint with no call = wide open — exactly the 15 unauthenticated
  endpoints the Restart audit found), and is app-coupled.
- **No first-class roles.** tooldef's `Principal` carries flat `capabilities` only; the
  "staff/admin should be roles + a require-role mechanism" need has no home.
- **No resource/ownership authZ.** The current `PrincipalRequirements` is a static
  `kind/trust/capabilities` match — it cannot express "owner of *this* order", which is
  why own-data-scoping got hand-rolled imperatively.
- **App tie-in in the core.** `PrincipalKind` bakes papercusp-specific values
  (`harness | pi | spawn-url | loopback`). A framework used by many projects must not.
- **No security invariants owned by the framework.** Default-deny, authN≠authZ,
  audited decisions, fail-closed — currently incidental, not guaranteed.

**Constraint:** tooldef is general-purpose. The model must serve an RBAC-only app *and*
a Zanzibar-scale app **through the same seams**, without baking a policy language (the
lowest-common-denominator trap).

## 2. How the established frameworks do it (survey)

| System | AuthN | AuthZ | Lesson |
|---|---|---|---|
| **MCP** 2025-11 | server = OAuth 2.1 **resource server**; validates externally-issued tokens (RFC 9728 metadata, RFC 8707 resource indicators) | token scopes | Don't *be* the IdP — **accept + validate** a resolved identity. Resource indicators stop the **confused-deputy/token-passthrough** attack (critical for agent tools calling downstream). |
| **gRPC** | channel creds (TLS, connection) + per-call creds (token in metadata) via **server interceptor** | interceptor chain | Separate *connection trust* from *per-call identity*; auth is an interceptor, not in the method. |
| **tRPC** | `context` factory | **middleware** → `protectedProcedure`/`adminProcedure`, type-narrowing | The **protected/role-procedure** pattern = declarative, composable. The clean version of `requireStaff`. |
| **GraphQL** (oso, graphql.org) | external | resolver vs **directive** vs middleware vs **external PDP** | Consensus: in-handler authz "doesn't scale, repeats, is easy to omit, hard to test"; prefer declarative; put resource-level authz **close to the data or in an external PDP**. |
| **NestJS** | guards | `@Roles()` + `RolesGuard` (declarative metadata) | Declarative RBAC as an annotation = the "require-role" mechanism, done right. |
| **Policy engines** (OPA/Rego, Casbin, Cedar, OpenFGA/Zanzibar, Cerbos) | n/a | externalized RBAC/ABAC/**ReBAC** | Resource/relationship rules need ABAC/ReBAC; **expose a seam to any engine** — migrating off a baked RBAC-only model "grows exponentially with time". |
| **Capability security** | unforgeable capability tokens | least-privilege by construction | Capabilities/scopes are the cleanest least-privilege primitive (vs ACL/RBAC "ambient authority"); hard parts = **revocation + token theft** → short TTL + revocation seam + audit. |
| **AuthZEN** (OpenID, std 2026-03) | n/a | standardizes the **PEP↔PDP** wire contract ("can who do what on which resource?") | There's now a *standard* externalized-authz seam — shape tooldef's PDP hook so an AuthZEN/OPA/Cedar engine drops in without code changes. |

**Design axes that fall out of the survey:** (1) authN ≠ authZ; (2) declarative vs
imperative vs externalized; (3) RBAC vs ABAC vs ReBAC vs capabilities (no single winner
→ carry all, decide in the policy layer); (4) **PEP vs PDP** (framework must be the PEP
and stay policy-agnostic); (5) default-deny/fail-closed; (6) resource/ownership level
(where flat RBAC fails and real breaches live).

## 3. What tooldef has today + gaps

tooldef is further along than the `requireAdminKey` hack implies — that's the *app*
layer. The core already has: `Principal { kind, slug, workspaceId, authMethod, trust,
capabilities }`, a declarative `auth: 'public' | PrincipalRequirements` field, a
host-injected `requirePrincipal()` resolver, and a trust ladder. So **authN/authZ
separation + a declarative gate + capabilities + pluggable authN already exist.** Gaps:
baked `PrincipalKind` enum; no roles; no resource/relationship authZ; no PDP seam; no
explicit confused-deputy guard; security invariants not framework-owned.

## 4. Proposed model

Three layers; the framework is the **PEP** (enforces + audits + owns invariants) and
ships **no policy engine**.

### 4.1 AuthN output — a generic `Principal`
```ts
export type PrincipalTrust = 'untrusted' | 'verified' | 'trusted';

export interface Principal {
  subject: string;                              // stable caller id (user/service/agent/device)
  kind: string;                                 // HOST-DEFINED classification (open string)
  roles: ReadonlySet<string>;                   // RBAC (host-defined)
  capabilities: ReadonlySet<string>;            // least-privilege grants / OAuth scopes
  attributes: Readonly<Record<string, unknown>>;// ABAC inputs (orgId, tenant, ownerships…)
  trust: PrincipalTrust;                         // strength of identity proof, orthogonal to role
  authMethod: string;                            // how authN happened (audit) — open string
  scope?: string;                                // tenant/workspace; null ≠ implicit global
  actor?: { subject: string; kind: string };     // on-behalf-of / delegation chain
  label?: string;
}
```
*Why:* drops the papercusp-specific `kind` union; `roles`/`capabilities`/`attributes`
are generic carriers so any host models its own identities without core changes.

### 4.2 AuthN seam — pluggable per-transport resolver
```ts
export interface PrincipalResolver<TTransportCtx = unknown> {
  // Establish identity only. MUST NOT grant authority. null = anonymous.
  resolve(ctx: TTransportCtx): Promise<Principal | null> | Principal | null;
}
```
*Why:* matches gRPC interceptors / tRPC context / MCP "validate an externally-issued
token". The framework ships helpers (Bearer/JWT/cookie/mTLS/OAuth-resource-server/
process-internal) but bakes none — authN is irreducibly transport/deployment-specific.

### 4.3 AuthZ Tier 1 — declarative coarse gate (RBAC + scopes + trust)
```ts
export interface AuthRequirements {
  trust?: ReadonlyArray<PrincipalTrust>;        // min trust, orthogonal to role
  roles?: ReadonlyArray<string>;                // ANY-of (RBAC) — the "require role" mechanism
  capabilities?: ReadonlyArray<string>;         // ALL-of (least-privilege / scopes); '*' wildcard
  tokenIn?: ReadonlyArray<'header' | 'query'>;  // default ['header'] (query leaks to logs)
}
export type ToolAuth = 'public' | AuthRequirements;   // on each defineTool
```
*Why:* the tRPC/NestJS/GraphQL-directive lesson — visible, enforced-by-construction,
testable, can't-forget. **`requireStaff` → `auth: { roles: ['staff','admin'] }`.**
**Default-deny: a tool with no `auth` is denied unless explicitly `'public'`.**

### 4.4 AuthZ Tier 2 — fine-grained decision (pluggable PDP, AuthZEN-shaped)
```ts
export interface AuthzQuery {                    // mirrors AuthZEN subject/action/resource
  principal: Principal;
  action: string;                                // tool name or a verb
  resource?: { type: string; id?: string; attributes?: Record<string, unknown> };
  context?: Record<string, unknown>;
}
export interface AuthDecision {
  allow: boolean;
  reason?: string;                               // for audit
  obligations?: Record<string, unknown>;         // optional (e.g. row filters to apply)
}
export interface PolicyDecisionPoint {
  decide(q: AuthzQuery): Promise<AuthDecision> | AuthDecision;
}

// optional, per-tool — runs only after Tier 1 passes:
authorize?(args: {
  principal: Principal; input: TInput; ctx: ToolContext;
  pdp: PolicyDecisionPoint | null;               // host-wired engine, if any
}): Promise<AuthDecision> | AuthDecision;
```
*Why:* this is where ownership/ReBAC/ABAC lives. Keeping it a **seam** (not a baked
model) is what makes tooldef general without LCD: an in-proc closure
(`resource.ownerId === principal.subject`) for simple apps, or `pdp.decide(q)` to
OPA/Cedar/OpenFGA/Cerbos/an AuthZEN engine for advanced ones. **Own-data-scoping moves
here, out of handler bodies.**

### 4.5 Security invariants the framework enforces (the actual "pass")
```ts
export interface AuthAuditEvent {
  ts: number;
  principal: { subject: string; kind: string; roles: string[]; trust: PrincipalTrust };
  tool: string; action: string; resource?: { type: string; id?: string };
  decision: 'allow' | 'deny';
  tier: 'authn' | 'tier1' | 'tier2';
  reason?: string;
}
```
- **Default-deny / fail-closed** — unconfigured tool, resolver error, or PDP error ⇒ deny.
- **authN ≠ authZ** — the resolver establishes identity+trust only, never authority.
- **Every decision audited** (`AuthAuditEvent`) — allow and deny (capability/PDP research
  flags auditability + revocation as the hard parts).
- **Trust floor independent of role** — money-moving tools can demand `trust: ['trusted']`
  / mTLS regardless of role.
- **Credential hygiene** — accept a *resolved* principal; never log raw tokens; `tokenIn`
  header-only by default; support short TTL + a revocation-check seam.
- **Confused-deputy guard** — downstream calls on behalf of a principal use RFC 8707
  resource-scoping / token-exchange, not blind passthrough.
- **Scope enforced** — `principal.scope` gates tenant data; null is not implicit-global.

## 5. Migration map

| Today | Becomes |
|---|---|
| `PrincipalKind` union (`harness`/`pi`/`spawn-url`/`loopback`) | `kind: string` (host-defined) + `roles`/`attributes`; papercusp maps its values to kind strings + roles |
| `requireAdminKey(req)` | `auth: { roles: ['service'], trust: ['trusted'] }` (or a capability); the admin key is just one `authMethod` the resolver maps to a `service` principal |
| `requireStaff(req)` | `auth: { roles: ['staff','admin'] }` |
| own-data scoping (`order.customerId === principal.subject`, hand-rolled) | the `authorize` hook: `resource:{type:'order',id,attributes:{ownerId}}` ⇒ `allow = ownerId === principal.subject` (or `pdp.decide`) |
| `PrincipalRequirements.kind` match | prefer `roles`; `kind` optional/generic |
| scattered handler checks | declarative `auth` (Tier 1) + `authorize` (Tier 2); handler bodies do no auth |

Phased + additive: add `roles`/`attributes`/`scope`/`actor` to `Principal` and
`roles`/`authorize` to the tool definition **without breaking** existing
`capabilities`/`PrincipalRequirements` consumers (~601 via agent-mcp); deprecate the
baked `PrincipalKind` union over one migration arc.

## 6. Open decisions (needs-human ratification)
- **D-A. Agent-auth transport** — static per-agent bearer (recommended now) vs
  HMAC-signed spawn URLs (papercup's model) vs mTLS. (Same open Q as the Restart plan's D-003.)
- **D-B. Ship a default PDP?** Recommend **no engine** — ship the `PolicyDecisionPoint`
  interface + a tiny in-proc owner-check helper + documented OPA/Cedar/OpenFGA/AuthZEN
  adapters. Keeps the core policy-agnostic.
- **D-C. AuthZEN wire compatibility** — shape `AuthzQuery`/`AuthDecision` to the AuthZEN
  1.0 request/response so a compliant PDP is drop-in. Recommend yes.
- **D-D. Back-compat window** — how long to keep the legacy `PrincipalKind` union + the
  `kind`-based `PrincipalRequirements` before removal.

## Sources (2026-05-31 web survey)
- MCP Authorization spec (2025-11-25) · Auth0 "MCP specs update — all about auth"
- tRPC Authorization + Middlewares docs
- gRPC Authentication + Interceptors guides
- graphql.org Authorization · Oso "Authorization Patterns in GraphQL"
- Permit.io "Policy Engine Showdown: OPA vs OpenFGA vs Cedar" · Auth0 "ReBAC/ABAC via OpenFGA & Cedar" · CIAM Compass "RBAC vs ABAC vs ReBAC"
- Storj "Capability-based access control"
- Cerbos "AuthZEN" · OpenID AuthZEN specifications

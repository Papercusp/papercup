---
title: RFC — @papercusp/tooldef auth & security model (research-backed redesign)
slug: tooldef-auth-rfc-2026-05-31
status: draft
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
related: [papercusp-tooldef-extraction-2026-05-29, BRIEF-tooldef-shared-repo-2026-05-30]
---

# RFC — `@papercusp/tooldef` auth & security model

## Now

**State:** §8 audit done (design vs the field — aligned on every major axis; 2 conditional divergences D1/D2 + 1 gap G1, all with verdicts). Phase 1a contract + Phase 1b enforcement BOTH shipped (commit a96bcd55): the `authorize` dispatch gate runs fail-closed after the coarse gates; `GateBypass.policy` (default off, not implied by the other bypasses) is the only skip and it is audited. tsc 0 new errors, 208/208.

**Next:** (1) Peer syncs authz.ts + the `authorizeStep`/`GateBypass.policy` changes to the shared `Papercusp/tooldef` repo (peer owns that sync). (2) Host wiring: route `deps.auditAuth` → `apps/operator/lib/auth-audit.ts` `recordAuthEvent`. (3) Phase 2: generic `Principal<TKind>` + reconcile principal RBAC roles ↔ agent `tool.roles` (D-E rename). (4) Phase 3 (per §8 D1): committed default-deny migration — audit every capability-only tool → `auth`/`'public'` + telemetry for unguarded tools.

## 1. Framing (honest)

**This is "make tooldef's authZ general enough to serve multiple hosts (incl. Restart)
and fill its one real gap" — NOT "fix papercup's scattered authz."** papercup's authZ is
already mostly *declarative*: routes enforce `PrincipalRequirements`, tool dispatch
enforces agent-role + capability + quota, and `GateBypass` is a shipped policy-agnostic
privilege signal. `requireAdminKey`/`requireStaff` are **Restart-only** (0 hits in
papercup) — rev 1 over-weighted them.

**The one real gap (both hosts hit it):** there is **no resource-level / ownership /
relationship authZ seam**. "Can this principal act on *this* resource (its own order, an
object in its org)?" has nowhere to live but the handler body — which is where Restart's
own-data scoping landed and where papercup's would too. Filling that, generally, is the
core of this RFC.

## 2. Survey (external — how the field does it)

| System | AuthN | AuthZ | Lesson |
|---|---|---|---|
| **MCP** 2025-11 | server = OAuth 2.1 **resource server**; validates externally-issued tokens (RFC 9728 metadata, RFC 8707 resource indicators) | token scopes | Don't *be* the IdP — accept+validate a resolved identity; resource indicators stop confused-deputy/token-passthrough. |
| **gRPC** | channel creds (TLS) + per-call creds (metadata) via server **interceptor** | interceptor chain | Separate connection trust from per-call identity; auth is an interceptor, not in the method. |
| **tRPC** | `context` factory | **middleware** → `protectedProcedure`/`adminProcedure` | The declarative protected/role-procedure pattern. |
| **GraphQL** (oso, graphql.org) | external | resolver vs **directive** vs middleware vs **external PDP** | In-handler authz "doesn't scale, repeats, easy to omit, hard to test"; resource-level authz belongs close to the data or in an external PDP. |
| **NestJS** | guards | `@Roles()` + `RolesGuard` | Declarative RBAC as metadata. |
| **Policy engines** (OPA/Casbin/Cedar/OpenFGA/Cerbos) | n/a | externalized RBAC/ABAC/**ReBAC** | Resource/relationship rules need ABAC/ReBAC; expose a seam to any engine — don't bake one (migrating off a baked RBAC-only model "grows exponentially"). |
| **Capability security** | unforgeable tokens | least-privilege | Capabilities/scopes = cleanest least-privilege primitive; hard parts = revocation + theft → short TTL + revocation seam + audit. |
| **AuthZEN** (OpenID, 2026-03) | n/a | standard **PEP↔PDP** wire contract | A standard externalized-authz seam exists; shape the PDP hook so a compliant engine drops in — but see §6/§7, don't wire-lock prematurely. |

**Axes:** authN≠authZ; declarative vs imperative vs externalized; RBAC/ABAC/ReBAC/
capabilities (carry all, decide in the policy layer); **PEP vs PDP** (framework is the PEP,
ships no engine); default-deny/fail-closed; resource/ownership level.

## 3. What tooldef enforces **today** (corrected — grounded in code)

Two enforcement paths plus a policy-agnostic bypass signal:

1. **Tool-dispatch path** (`DEFAULT_DISPATCH_STACK`, `dispatch-stack.ts`) — gates run
   first, in order: **`roleAllowlist`** (`tool.roles: AgentRole[]` ⊇ `ctx.role` — an
   *agent-persona* allowlist: operator/worker/architect…) → **`capability`**
   (`ctx.principal.capabilities` ⊇ `tool.capabilities`) → **`harness`** (harness:'required')
   → **`quota`** (`rolesQuota`) → … → `invoke`. `trust`/`kind` are already resolved on the
   principal before dispatch.
2. **Route path** (`route-stack.ts:105`) — `requirePrincipal(headers, def.auth)` enforces
   the **full `PrincipalRequirements`** (trust + kind + capabilities + tokenIn); `auth:
   'public'` opts out.
3. **`GateBypass { role, capability, quota, harness }`** (`tool-projection.ts:278`) — the
   engine-neutral "privileged caller" signal. The host maps its auth tiers onto it
   (`papercuspGateBypass` maps superuser/power-user); **the engine deliberately knows
   nothing about *why***. Note `harness` **fails closed even for privileged callers** by
   design (it's a requirement, not a permission) — only an explicit per-call escape hatch
   sets it. This is the shipped expression of "PEP stays policy-agnostic."

**So what already exists:** declarative route auth, an agent-role allowlist, a capability
gate, quota, a policy-agnostic privilege-bypass signal, authN/authZ separation, a trust
ladder. **What's actually missing:** (a) resource-level/ownership/ReBAC authz; (b)
*principal* RBAC roles distinct from the *agent* `tool.roles` axis; (c) a formalized audit
event; (d) a generic `Principal` for hosts other than papercup.

**Consumer surface (corrected):** tools depend on **`capability:`** (~200 `defineTool`
calls set it); essentially **no tools set `PrincipalRequirements`** (only ~8 *routes* use
`auth:`). So any breaking change lands on the **capability gate**, not `PrincipalRequirements`
— rev 1's "601 via agent-mcp / PrincipalRequirements" was wrong.

## 4. Phase 1 (NOW · additive · zero-breakage) — resource-authz seam + audit

The one real gap, shippable alone without touching `Principal` or any existing tool.

```ts
// AuthZEN-shaped query/decision (in-proc today; external PDP later — see §7 D-C)
export interface AuthzQuery {
  principal: Principal;
  action: string;                                  // tool name or a verb
  resource?: { type: string; id?: string; attributes?: Record<string, unknown> };
  context?: Record<string, unknown>;
}
export interface AuthDecision { allow: boolean; reason?: string; obligations?: Record<string, unknown>; }
export interface PolicyDecisionPoint { decide(q: AuthzQuery): Promise<AuthDecision> | AuthDecision; }

// optional, per tool — runs AFTER the existing gates (role/capability/harness/quota):
authorize?(a: {
  principal: Principal; input: TInput; ctx: ToolContext;
  pdp: PolicyDecisionPoint | null;                 // host-wired engine, if any
}): Promise<AuthDecision> | AuthDecision;

export interface AuthAuditEvent {
  ts: number;
  principal: { subject: string; kind: string; trust: PrincipalTrust };
  tool: string; action: string; resource?: { type: string; id?: string };
  decision: 'allow' | 'deny'; gate: 'role' | 'capability' | 'harness' | 'quota' | 'authorize';
  reason?: string;
}
```

- **Compose with `GateBypass`, don't ignore it (the key design point the review surfaced).**
  Add `policy?: boolean` to `GateBypass`; the `authorize` step skips when `ctx.gateBypass?.policy`
  is set — exactly like the existing role/capability/quota gates. The PDP still never learns
  *why*. (Open question: does `authorize` honor `gateBypass.capability`/`role` too, or only its
  own `policy` flag? → D-F.)
- **Fail-closed:** `authorize` throws or PDP errors ⇒ deny. Default unchanged for tools that
  don't declare `authorize` (they keep today's role+capability gating — additive).
- Ship a tiny in-proc **owner-check helper** (`resource.attributes.ownerId === principal.subject`);
  ship the `PolicyDecisionPoint` *interface* but **no engine**.
- **Latency:** in-proc closures are on the existing hot path (fine). An external `pdp.decide()`
  per call is a perf concern (see the performance anti-pattern page) → batching/caching guidance
  is a Phase-3 prerequisite, not Phase 1.

*Why now:* fills the only real gap, breaks nothing, lets Restart drop in a PDP for own-data
scoping immediately, and gives papercup the same seam for its ownership checks.

## 5. Phase 2 (CAREFUL) — generic `Principal` + principal RBAC roles

```ts
// papercup keeps the closed union + exhaustiveness; other hosts widen via TKind.
export interface Principal<TKind extends string = PrincipalKind> {
  kind: TKind;
  slug: string;
  workspaceId: string;                 // STAYS REQUIRED — "no global principals" (do not relax to optional)
  authMethod: PrincipalAuthMethod;
  trust: PrincipalTrust;
  capabilities: ReadonlySet<string>;
  roles?: ReadonlySet<string>;         // NEW: principal RBAC (additive)
  attributes?: Readonly<Record<string, unknown>>; // NEW: ABAC inputs (additive)
  actor?: { subject: string; kind: string };      // NEW: on-behalf-of (additive)
  label?: string;
}
```

- **Generic over `TKind` (default = the existing `PrincipalKind`)** — fixes rev 1's
  `kind: string` regression: papercup keeps its 7-value union + resolver exhaustiveness;
  Restart/others supply their own union. No open-string footgun.
- **`workspaceId` stays required** — fixes rev 1's `scope?` regression (it would invite the
  implicit-global bug rev 1's own text warned about).
- **Reconcile the two "roles" axes (the hazard the review caught):** `tool.roles:
  AgentRole[]` answers *"which agent persona may call this tool"* (an allowlist); the new
  principal `roles` answers *"what privilege does the caller hold"* (RBAC). They're
  different questions — keep them distinct, but **rename for clarity** (e.g. `tool.agentRoles`
  vs `auth.roles`) so two things aren't both "roles." → D-E.
- Declarative principal-role gate: add `roles?` to `PrincipalRequirements` (route path) and a
  role step on the dispatch path, composing with `GateBypass.role`.

## 6. Phase 3 (DEFER) — default-deny + external-PDP wire-compat

- **Default-deny flip** ("no `auth` ⇒ deny") is **not additive** — ~200 tools gate on
  `capability` alone; flipping requires a per-tool migration, not a flag. Defer until that
  migration is scoped (every tool audited + assigned an `auth`/`authorize` or `'public'`).
- **AuthZEN / external-PDP wire-compat** — defer until a real external-PDP consumer exists.
  In-proc closures cover Phase 1; locking the type surface to a 2026-03 draft for a PDP
  nobody's wired is speculative, and the per-call async hop needs batching/caching first.

## 7. Open decisions (`needs-human`)
- **D-A** Agent-auth transport — static per-agent bearer (recommended) vs spawn-url vs mTLS.
- **D-B** Ship a default PDP engine? — **no** (ship interface + owner-check helper + adapter docs). Recommended.
- **D-C** External-PDP / AuthZEN wire-compat — **defer to Phase 3** (not Phase 1).
- **D-D** Back-compat window for any `PrincipalKind`/`PrincipalRequirements` changes (Phase 2).
- **D-E** Reconcile principal RBAC `roles` ↔ agent `tool.roles` — keep-distinct-and-rename (recommended) vs unify.
- **D-F** `GateBypass` ↔ PDP composition — add `gateBypass.policy`; decide whether `authorize` also honors `role`/`capability` bypass.

## 8. Audit — our design vs the field (divergences + verdicts)

Decision-by-decision against MCP / gRPC / tRPC / GraphQL / NestJS / OPA·Cedar·OpenFGA·
Cerbos / AuthZEN / capability-security / break-glass best practice (2026-05-31 survey).

**Aligned with the field:**

| Our choice | Field standard | Verdict |
|---|---|---|
| Framework = PEP, ships no engine | AuthZEN/OPA/Cedar/OpenFGA externalize; framework-as-PEP is standard | ✅ aligned |
| Two-tier: declarative coarse gate + pluggable fine-grained PDP | tRPC protected-procedures / NestJS `@Roles` / GraphQL directives (coarse) + business-logic/PDP (fine) | ✅ aligned |
| `AuthzQuery`/`AuthDecision` + `obligations` | AuthZEN 1.0 subject/action/resource; XACML/AuthZEN obligations | ✅ aligned (forward-compat) |
| Audit every allow + deny | OPA decision logs; break-glass "log everything immutably" | ✅ aligned (and **mandatory** for D2) |
| capabilities↔scopes + separate RBAC roles | OAuth scopes + RBAC | ✅ aligned |
| Generic `Principal<TKind=PrincipalKind>` | generic identity context (gRPC/tRPC) | ✅ aligned (keeps exhaustiveness) |
| `workspaceId` REQUIRED (no global principals) | multi-tenant isolation best practice | ✅ aligned — deliberately *stricter* (good) |
| confused-deputy: inbound=framework / outbound=host | MCP RFC 8707 inbound + OAuth token-exchange outbound | ✅ aligned |

**Divergences + verdicts:**

- **D1 — default-deny deferred (Phase 3).** Field: default-deny/fail-closed is the
  baseline ("forget to add authz ⇒ deny"). We currently *don't* deny a `capability`-only
  tool that sets no `auth`. *Reason:* ~200 existing capability-only tools. **Verdict:
  good but conditional** — the field confirms migrating-to-default-deny is "much more
  involved than building it right" and needs telemetry + per-tool work. Legitimate ONLY
  as a *committed* migration (audit every tool → `auth`/`'public'`; telemetry to surface
  unguarded tools), targeting the ASP.NET "require-auth-globally + explicit
  `[AllowAnonymous]`" shape (= our `'public'`). **Not an indefinite punt** → Phase 3 gets
  a concrete default-deny migration, not just "defer."
- **D2 — `GateBypass` is a framework-level PDP bypass (D-F).** Field: break-glass /
  privileged-bypass must be **policy-governed + MANDATORILY audited** — *"not an
  uncontrolled framework override"* (immutable logging of every privileged op). *Reason
  for the divergence:* `GateBypass` is papercup's pre-existing policy-agnostic privilege
  primitive (it already bypasses role/capability/quota); routing superuser through every
  host's PDP would push superuser-knowledge into every policy. **Verdict: acceptable
  ONLY if audited + explicit + opt-in.** My D-F choice (default-off, per-call) gives
  explicit+opt-in; **the audit adds the missing requirement — every `gateBypass.policy`
  skip MUST emit an `AuthAuditEvent` (the bypass is logged, never silent), or it becomes
  the "uncontrolled override" the standard forbids.** Note: the *purer* path stays open —
  a host preferring "admin access is a policy" simply doesn't set `gateBypass.policy` and
  returns allow for superuser in its PDP. We offer the audited bypass as a convenience;
  we don't force it.
- **D3 — ship an `ownerOnly` in-proc helper.** Field: most engines ship no policy
  (Casbin *is* the engine). **Verdict: fine** — opt-in, not an engine, and ownership is
  the single most common rule (a reasonable floor).
- **D4 — AuthZEN shape adopted, engine wiring deferred.** **Verdict: fine** — shaping ≠
  wiring; cheap forward-compat to avoid reshaping later.
- **D5 — two roles axes (agent `tool.roles` vs principal RBAC `roles`).** Field: usually
  one roles concept. *Reason:* genuinely different layers (orchestration allowlist vs
  authz RBAC), cf. K8s RBAC vs admission control. **Verdict: defensible; mitigate via the
  D-E rename.**

**Gap the audit surfaces (under-specified, not wrong):**

- **G1 — how `AuthzQuery.resource` gets its data (the "authz needs data" problem).** Oso:
  "you often need data not on the object"; the two patterns are *fetch* (per-request
  lookup) and *data-filtering* (return a filter for list endpoints). The RFC doesn't say
  who populates `resource.attributes` (e.g. `ownerId`). **This is where our in-proc
  `authorize` hook BEATS an external PDP** (the GraphQL/Oso "authorize close to the data"
  lesson): the hook has `input` + `ctx`, so it loads/derives the resource itself, and
  `obligations` carries the data-filter pattern for lists. **Action (Phase 1b/docs):**
  the hook loads the resource (or the host pre-loads into `ctx`, shared with the handler
  to avoid a double-load); for list endpoints, return `obligations` (a filter) rather
  than per-row checks.
- **G2 — decision caching/batching** for an external PDP: already a Phase-3 prereq. OK.
- **G3 — role hierarchy:** our roles are flat any-of; RBAC often supports hierarchy.
  Hosts model hierarchy in role-assignment or their PDP. Minor; noted.

**Bottom line:** the design is well-aligned with the field on every major axis. The two
real divergences are *justified but conditional* — default-deny deferral demands a
committed migration (D1), and the `GateBypass` PDP-bypass demands **mandatory auditing of
the bypass** (D2, which changes Phase 1b). The one genuine gap (G1) is where our in-proc
hook is *stronger* than the external-PDP norm; we just document the contract.

## Confused-deputy note (corrected scope)
Rev 1 listed RFC 8707 confused-deputy prevention as a "framework invariant" — overstated.
tooldef holds a *pre-resolved* principal and makes no downstream calls, so **outbound** token
scoping is a **host** concern. The **inbound** half — a resource-server *transport adapter*
validating token audience/resource-indicators so it won't accept passthrough tokens — *is*
framework-level (an MCP/HTTP adapter feature), and belongs there, not as a dispatcher gate.

## Credit
Phases, the `GateBypass` reconciliation, the generic-`Principal`/required-`workspaceId`
corrections, the two-roles-axis hazard, the corrected consumer count, and the
confused-deputy scoping all come from a code-grounded review of rev 1 (verified here
against `dispatch-stack.ts`/`route-stack.ts`/`tool-projection.ts`).

## Sources (2026-05-31 web survey)
MCP Authorization spec (2025-11-25) · Auth0 "MCP specs update — all about auth" · tRPC
Authorization + Middlewares · gRPC Authentication + Interceptors · graphql.org Authorization ·
Oso "Authorization Patterns in GraphQL" · Permit.io "OPA vs OpenFGA vs Cedar" · Auth0
"ReBAC/ABAC via OpenFGA & Cedar" · CIAM Compass "RBAC vs ABAC vs ReBAC" · Storj
"Capability-based access control" · Cerbos "AuthZEN" · OpenID AuthZEN specifications.

## Decisions

### D-001 — D-F resolved + shipped (Phase 1b): authorize is a separate, audited decision
Date: 2026-05-31
The resource-`authorize` gate is NOT implied by the role/capability/quota `GateBypass`es. A new `GateBypass.policy` (default OFF) is the only thing that skips it, and even then the skip emits an `AuthAuditEvent` (gate:'authorize', decision:'allow', reason:'gateBypass.policy'). Rationale: the §8 audit against break-glass best practice — a privileged bypass must be policy-governed AND mandatorily logged; a bypassed check that isn't logged is the "silent super-admin" the standard forbids. The framework EMITS the event via the optional `deps.auditAuth` sink; the host wires persistence (papercup → `apps/operator/lib/auth-audit.ts` `recordAuthEvent`). Shipped in packages/tooldef commit a96bcd55; tsc 0 new errors, 208/208 tests.

---
title: Principal — unified auth subject RFC
slug: principal-rfc-2026-05-20
status: design-review
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
companion-to: [host-architecture-2026-05-20-v2]
---

# Principal — unified auth subject (RFC)

**Date:** 2026-05-20
**Status:** Design-review. **No code lands from this doc until the questions in §6 are resolved.**
**Phase:** 3b of host-architecture v2 (Principal RFC + implementation). This doc is the RFC; the implementation is gated on review.

---

## 1. Why this exists

Today auth in the operator lives in three loosely related places:

1. **`packages/agent-mcp/src/types.ts` `Principal`** — the per-call auth subject the dispatcher already sees. Currently `{ kind, slug, workspaceId, capabilities }`. Only ~half the codebase produces these; many routes never bother and fall back to "the request came from loopback so it's trusted."
2. **`packages/agent-mcp/src/auth.ts`** — bearer-token validation + cache, principal lookup for the MCP transport.
3. **Per-route ad-hoc auth** — 30 routes under `apps/operator/app/api/**` have a local `isLoopback(req)` helper that returns 403 if the Host header doesn't look local. Each one is a copy of the same six-line pattern, with subtle variations that make consolidation by find-replace risky.

This works for desktop today because every request *is* loopback. It does not work for:

- The **endpoint-system dispatcher**, which has been getting Principals from the MCP path but not from the HTTP route path (some routes synthesize, most don't).
- **The future webapp host** (Phase 8 of host-architecture v2). A network-reachable HTTPS request can't be authorized by "the Host header is 127.0.0.1." Every loopback-only route needs a real auth check before that ships.
- **Mobile clients** that already use JWTs (`@papercup/mobile-voice`'s pair flow) — those JWTs project through a different code path entirely (`apps/operator/app/api/mobile/auth/*`) and never produce a `Principal`.

The work is **not** to invent auth. It's to make all three sources produce the same `Principal` shape so the dispatcher / middleware / route handlers can stop knowing which transport delivered the credential.

## 2. Current Principal shape (and its limits)

```ts
// packages/agent-mcp/src/types.ts (current)
export type PrincipalKind = 'harness' | 'system' | 'pi';

export interface Principal {
  kind: PrincipalKind;
  slug: string;             // "system:operator", "pi:abc123", "harness-foo"
  workspaceId: string;
  capabilities: ReadonlySet<string>;
}
```

Three problems:

- **`kind` is enum'd to today's transports.** No `'user'` (cookie-bearing webapp user), no `'mobile'` (JWT-bearing mobile client), no `'service'` (bearer-token external integration). Adding these is mechanical but `PrincipalKind` is unioned across so much code that changing it churns ~40 files. Worth doing once, deliberately.
- **`capabilities` is the only authorization channel.** Every loopback-only route today either (a) does an `isLoopback(req)` early-return — the principal never enters the picture — or (b) calls a separate role-allowlist that's not capability-shaped. To unify, every gate needs to be re-expressed as either "principal has capability X" or "principal kind ∈ allowedKinds."
- **No notion of *how* the principal was authenticated.** A Principal that came from a cookie session is materially less trusted than one that came from a sealed spawn URL or a TPM-attested mobile device. Pretending they're equivalent makes the trust boundary illegible.

## 3. Proposed shape

```ts
export type PrincipalKind =
  | 'system'           // operator self-issued (e.g. background sweepers)
  | 'harness'          // sealed harness spawn URL (orchestrator-minted)
  | 'pi'               // shell-launched agent, bearer file
  | 'user'             // cookie-bearing browser session
  | 'mobile'           // JWT-bearing mobile client
  | 'service'          // bearer-token external integration (future)
  | 'loopback';        // request is local; legacy desktop-only gate

export type PrincipalAuthMethod =
  | 'bearer-token'     // ~/.papercusp/superuser-token or external bearer
  | 'cookie-session'   // browser cookie
  | 'jwt'              // mobile JWT, future webapp tokens
  | 'spawn-url'        // HMAC-signed orchestrator URL
  | 'host-loopback'    // Host header is local; no token (legacy)
  | 'process-internal' // in-process call (e.g. background sweeper)
  ;

export interface Principal {
  kind: PrincipalKind;
  /** Stable subject identifier — UUID, user id, harness slug, etc. */
  slug: string;
  /** Workspace the call is scoped to. Required (no global principals). */
  workspaceId: string;
  /** How the principal was authenticated. */
  authMethod: PrincipalAuthMethod;
  /** Authorization capabilities granted to this principal. */
  capabilities: ReadonlySet<string>;
  /**
   * Trust level. The dispatcher and middleware can compare these without
   * having to know which auth method produced them.
   *   - 'trusted'   — process-internal, sealed spawn URL, bearer file
   *   - 'verified'  — JWT signature checked, cookie session validated
   *   - 'unverified-loopback' — host header only; rejected when running
   *                             on a network-reachable host
   */
  trust: 'trusted' | 'verified' | 'unverified-loopback';
  /** Optional human-readable label for logging. Not load-bearing. */
  label?: string;
}
```

### Why these fields and not others

- **`authMethod` separate from `kind`.** A `'service'` principal might be authenticated by `'bearer-token'` OR `'jwt'`. A `'user'` principal might be `'cookie-session'` today and `'jwt'` later (Phase 8). Keeping them orthogonal means `kind` describes *who* the principal is and `authMethod` describes *how we know*.
- **`trust` is the single thing middleware reads when deciding whether to allow a host-protected operation.** Without it, every gate has to know the full method × kind matrix; with it, "this gate requires `trust === 'trusted'`" is a one-liner.
- **No `roles` field.** Roles are already in `UnifiedToolContext.role` (architect, scoper, etc.) — those describe what an agent is doing in the harness, not who they are. Mixing the two has bitten us before. The dispatcher already does role-allowlist gating separately from capability gating; that stays.
- **No `tenantId` or `orgId`.** Multi-tenancy lives in `workspaceId`; tenants and workspaces are 1:1 in the current model. If Track A (auth+multi-tenancy) decides to split them, this field gets added then.

## 4. Consolidating the 30 loopback-only auth checks

Audit count: 30 route files under `apps/operator/app/api/**` have a local `isLoopback(req)` early-return. Three patterns, by category:

| Category | Count | Pattern | Migration |
|---|---|---|---|
| **Desktop-only state probes** | ~15 | `apps/operator/app/api/desktop/*` (voice-configured, setup-wizard-state, telemetry-config, etc.) | Become `kind: 'loopback'` + `trust: 'unverified-loopback'`. Middleware rejects when `host.bindHost !== '127.0.0.1'`. |
| **Admin operations** | ~8 | `apps/operator/app/api/admin/*` (backup-orphan-cleanup, embed-backfill, etc.) | Require `trust === 'trusted'` + a capability (`admin:backup`, `admin:embed`, etc.). |
| **Agent-MCP internal** | ~7 | `apps/operator/app/api/agent-mcp/console/*`, `agent-mcp/el-admin-creds` | Require `trust === 'trusted'` + `kind === 'system' | 'pi'`. |

The consolidation work is:

1. A `requirePrincipal(req, requirements)` helper that produces a `Principal` (or 401/403) from any incoming request. One file, one helper, used everywhere.
2. A scripted sweep that replaces each route's local `isLoopback()` + ad-hoc early-return with `const principal = await requirePrincipal(req, { trust: 'trusted' | 'verified', kind: [...], capabilities: [...] })`.
3. Per-route review of the migration to ensure no gate weakened.

This is the meaningful payoff of the RFC: **30 route files lose their custom auth code and gain a single, typed, testable gate.**

## 5. Producing a Principal from each transport

### 5a. Cookie session (browser → operator HTTP)

```ts
// New, in apps/operator/lib/auth/principal-from-cookie.ts
export async function principalFromCookie(req: NextRequest): Promise<Principal | null> {
  const sid = req.cookies.get('papercusp_session')?.value;
  if (!sid) return null;
  const session = await loadSession(sid);  // existing lib/auth/session.ts
  if (!session) return null;
  return {
    kind: 'user',
    slug: session.userId,
    workspaceId: session.workspaceId,
    authMethod: 'cookie-session',
    capabilities: new Set(session.capabilities),
    trust: 'verified',
  };
}
```

### 5b. Sealed spawn URL (orchestrator → harness agent)

Already produces `kind: 'harness'`. Migration adds `authMethod: 'spawn-url'` + `trust: 'trusted'` to the synthesized record. ~5 lines in `packages/agent-mcp/src/auth.ts`.

### 5c. Mobile JWT (mobile pair → operator)

```ts
// New, in apps/operator/lib/auth/principal-from-mobile-jwt.ts
export async function principalFromMobileJwt(req: NextRequest): Promise<Principal | null> {
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return null;
  const claims = await verifyMobileJwt(token);   // existing lib/mobile/jwt.ts
  if (!claims) return null;
  return {
    kind: 'mobile',
    slug: claims.deviceId,
    workspaceId: claims.workspaceId,
    authMethod: 'jwt',
    capabilities: new Set(claims.capabilities ?? []),
    trust: 'verified',
  };
}
```

### 5d. Superuser bearer file (shell → operator MCP)

Already produces `kind: 'system'` via `superuser-token.ts`. Migration adds `authMethod: 'bearer-token'` + `trust: 'trusted'`.

### 5e. Loopback fallback (desktop legacy)

```ts
// In apps/operator/lib/auth/principal-from-loopback.ts
export function principalFromLoopback(req: NextRequest, workspaceId: string): Principal | null {
  if (!isLoopbackRequest(req.headers)) return null;
  return {
    kind: 'loopback',
    slug: 'loopback',
    workspaceId,
    authMethod: 'host-loopback',
    capabilities: new Set(['*']),  // legacy desktop trust
    trust: 'unverified-loopback',
  };
}
```

### 5f. Composite resolver

```ts
// apps/operator/lib/auth/require-principal.ts
export async function requirePrincipal(
  req: NextRequest,
  reqs: {
    trust?: ReadonlyArray<Principal['trust']>;
    kind?: ReadonlyArray<PrincipalKind>;
    capabilities?: ReadonlyArray<string>;
  },
): Promise<Principal> {
  const ws = await resolveWorkspaceId(req);
  const principal =
    (await principalFromCookie(req)) ??
    (await principalFromMobileJwt(req)) ??
    (await principalFromSuperuserToken(req)) ??
    principalFromLoopback(req, ws);
  if (!principal) throwUnauthorized();
  if (reqs.trust && !reqs.trust.includes(principal.trust)) throwForbidden(`trust=${principal.trust}`);
  if (reqs.kind && !reqs.kind.includes(principal.kind)) throwForbidden(`kind=${principal.kind}`);
  if (reqs.capabilities) {
    for (const cap of reqs.capabilities) {
      if (!principal.capabilities.has(cap) && !principal.capabilities.has('*')) {
        throwForbidden(`missing capability: ${cap}`);
      }
    }
  }
  return principal;
}
```

Note: `trust: 'unverified-loopback'` is the legacy desktop trust level. Phase 8 (webapp host) bans it at boot — `requirePrincipal` rejects loopback-only principals when `PAPERCUSP_BIND_HOST !== '127.0.0.1'`. That single config-driven check is what makes the webapp safe; today the desktop's "loopback ⇒ trusted" assumption is exactly the thing that won't survive.

## 6. Open questions (block implementation)

### Q1. Host-issued vs. platform-issued tokens for users / services

When Phase 8 ships the webapp, who issues the JWT?

- **(a) Host-issued.** Each operator deploy mints its own signing key, validates its own tokens, manages its own session table. Pro: simple, no third party. Con: every operator deploy is its own auth island; SSO is impossible.
- **(b) Platform-issued.** A central auth service (`auth.papercupai.com`?) mints tokens; operator deploys verify against the platform's public key. Pro: SSO + token-revocation work cross-deploy. Con: requires running a platform service; couples user accounts to a network identity provider.

**Recommend (a) for v1 + revisit when the second tenant appears.** Mobile pairing already does (a) — extending the same model to webapp users is the smallest step.

### Q2. Mobile JWT shape — is it `kind: 'mobile'` or `kind: 'user'` with `authMethod: 'jwt'`?

Today the mobile pair flow validates a device JWT. A mobile user is a user-on-a-device. Two options:

- **(a) `kind: 'mobile'`** — surfaces the device dimension. A "mobile vs. desktop" gate becomes a `kind` check.
- **(b) `kind: 'user', authMethod: 'jwt'`** — surfaces the auth method; device is metadata on the principal (added field?).

**Recommend (a)** — gates like "this tool is desktop-only" or "this tool is mobile-only" are real and benefit from being kind-shaped. The `'service'` kind covers non-user JWT bearers later.

### Q3. Capability strings — namespace and registry

`capabilities: Set<string>` is currently freeform. Should we:

- **(a) Keep freeform** + document the namespacing convention (`tasks:read`, `admin:backup`, etc.).
- **(b) Define a `Capability` enum** with all known values; build fails if a tool references one that doesn't exist.

**Recommend (a) for the RFC + revisit alongside Phase 6b (layering enforcement).** Premature enum churn risks slowing down the consolidation work; the doc convention is enough.

### Q4. Audit recording — does Principal go in `tool_invocations`?

Today `tool_invocations` records `(ctx.role, ctx.principal?.slug)`. Should we add full `(principal.kind, principal.authMethod, principal.trust)`?

**Recommend yes** — drives a `/dev → Sessions` filter "show me everything authenticated via X" that today is impossible. Migration: add three columns to `harness_shared.tool_invocations`, plumb through `DispatchProjectedDeps.recordInvocation`.

### Q5. Backwards-compat shim during rollout

The current `Principal` shape is in `packages/agent-mcp/src/types.ts` and imported by ~30 files. Add the new fields with defaults so existing producers don't break:

```ts
authMethod: 'process-internal',  // safe default for synthesized principals
trust: 'trusted',                // matches current implicit behavior
```

Producers that lie about trust (loopback path returning `'trusted'`) are migrated to the new principal-from-* functions in §5. Pre-alpha → break things; we can ship the new fields as **required** and update producers in the same PR. Recommend required.

### Q6. Does this change `DispatchProjectedDeps`?

The dispatcher reads `ctx.principal` today. The proposed shape is a superset of today's — same field names, three added fields. No deps surface changes. Existing tests pass without churn.

## 7. Non-goals

- **No real OAuth / passkeys here.** Track A owns that decision. This RFC is the *shape* of the principal regardless of who issues the token.
- **No multi-tenant isolation strategy.** RLS policy is Track A's call. Principal carries `workspaceId`; that's enough for the dispatcher.
- **No central session store rewrite.** `lib/auth/session.ts` keeps working; the new shape is the interface, not the implementation.

## 8. Phases (after RFC review)

**Pre-implementation:** resolve Q1–Q5 above. Mostly recommend → confirm.

**Implementation order:**

1. **Type shape only** — add `authMethod` + `trust` (+ optional `label`) to `Principal`; update `PrincipalKind`. ~30 files touched mechanically. Adds the new fields as required; updates each existing producer to fill them. **Acceptance:** `tsc --build` clean across the agent-mcp + operator surface; no existing tests change behavior.
2. **`requirePrincipal()` helper + per-transport resolver functions** as in §5a–5f. **Acceptance:** unit tests for each resolver; integration test that hits a route via cookie, mobile JWT, loopback, and sealed spawn URL — all produce a Principal with the expected `trust`.
3. **Consolidation sweep** — replace the 30 ad-hoc `isLoopback()` patterns with `requirePrincipal()` calls. One PR per route family (desktop/, admin/, agent-mcp/). **Acceptance per batch:** every route in the batch returns the same status code (401/403/200) for the same input as pre-migration. E2E spec snapshots cover.
4. **`tool_invocations` columns** (per Q4) — schema migration + dispatcher plumb-through.

Each phase is a real PR; together they replace the auth scatter.

## 9. Cost-benefit

| Item | Cost | Benefit |
|---|---|---|
| Type shape change | ~30 files touched once | Every consumer can read `principal.trust` instead of inferring from `kind` |
| `requirePrincipal()` | ~150 LoC + tests | One typed auth gate replaces 30 hand-rolled six-line patterns |
| Consolidation sweep | 4-6 PRs | Phase 8 webapp host has a real auth gate to ban loopback-only principals against |
| `tool_invocations` cols | One PG migration + dispatcher patch | `/dev → Sessions` gets auth-method filter |

**Total estimate:** 2-3 weeks single-agent. Net deletion at the end; the implementation costs less than the audit it replaces.

## 10. What waits on this

- **Phase 8 webapp host** — explicit hard prerequisite per host-architecture v2.
- **Track A auth & multi-tenancy** — Track A's deliverable is the *implementation* (OAuth / RLS / etc.); this RFC defines the *shape* it produces. Track A starts later but should not re-litigate the shape.
- **Migration of A1-class routes** — handlers like `agent-chats.ts` (419 LoC, transcript persistence, cost caps) still benefit from a typed principal in their handler signature even if they don't migrate to `define_tool`.

## 11. What this doc is NOT

- Not a Track A replacement. Track A still needs an owner and the identity provider / tenant model / RLS policy / data migration plan.
- Not a webapp launch plan. Phase 8 has its own design work.
- Not a critique of the existing `Principal` — the shape that exists today is the right starting point. The RFC's job is to extend it deliberately, not to throw it out.

---

**Next step:** review answers to Q1–Q5 above, then proceed to phase 1 (type shape change). If any answer flips, the §3 shape adjusts before any implementation code.

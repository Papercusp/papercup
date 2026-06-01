---
title: Endpoint unification — collapse defineRoute into defineTool, add expose.mobile
slug: endpoint-unification-2026-05-21
status: superseded
created: 2026-05-21
updated: 2026-06-01
owner: pandawamble@gmail.com
companion-to: [endpoint-route-migration-2026-05-20, phase-4-endpoint-system-2026-05-12, principal-rfc-2026-05-20, host-architecture-2026-05-20-v2]
---

<!--
STATUS 2026-05-21: E1–E6 SHIPPED. defineRoute is now a re-export of the
unified defineTool primitive — the collapse is done. E7–E14 not started.
Post-E: E15 (mobile→device generalization) SHIPPED — see the E15 section.
-->


## Now

**State:** E1 + E2 shipped. E1 (`c567f7ac`) — type-additive `defineTool` fields. E2 — the load-bearing auth fix: the `/api/agent-tools/*` catch-all now resolves a mobile device JWT (composite bearer resolver: `resolveBearer` token_index → mobile JWT), and `requirePrincipal()` gained a `from-bearer-token` resolver so agent `system`/`pi` bearers resolve there too. A paired phone can now call any built-in `defineTool`.

**Next:** E7 (ESLint enforcement + docs) — though its `no-raw-route-handlers` rule is gated on E12/E13 migrating the remaining `_hono/*` routers.

**Post-E follow-up shipped:** E15 — the `mobile` concept generalized to `device` (`'device'` principal kind, `auth.tokenIn`, the `cors` route field; `routes/device/`, `/api/device/*`). See the E15 section.

E1–E6 shipped. The mobile arc (E1–E5) plus the actual collapse (E6): **`defineRoute` is now a re-export of the unified `defineTool` primitive.** `defineTool` discriminates structurally — a route-shaped input (`{ method, path, auth, handler }`) returns a `RouteDefinition`; a tool-shaped input returns a `ToolDefinition`. One primitive, three projections. The earlier "E6 is blocked" assessment was resolved by splitting the concern: the route *types* + the `defineTool` route *branch* (pure logic) moved into `@papercusp/agent-mcp`; the Hono-coupled `registerRoute` + `route-stack` stayed host-side. The package never imports the app.

**Scope adjustment (E2 review):** the telemetry-table merge (`route_invocations` → `tool_invocations` with a `kind` discriminator) is **moved from E2 to E6**. Rationale: migration 077 separated the tables *by deliberate design* (RFC Q1 — genuinely different column sets, different volume/retention). The merge's benefit only fully materializes once `defineRoute` actually collapses into `defineTool` (E6) and the route/tool distinction disappears at the dispatch level. Forcing a PG migration in E2 would couple the auth fix to schema-migration risk for no near-term gain. E2 ships the auth fix alone.


# Endpoint unification — collapse defineRoute into defineTool, add expose.mobile

## 1. What we have today

Two declarative primitives sit next to each other with substantial overlap:

| Concern | `defineTool` (`packages/agent-mcp/src/define-tool.ts`, 380 LOC) | `defineRoute` (`apps/operator/lib/endpoint-route/define-route.ts`, 115 LOC) |
|---|---|---|
| Identity | name auto-derived from file path; description from TSDoc | none — caller passes `method` + `path` |
| Auth gate | single `capability` → tier lookup; principal+tx required by built-in catchall via `resolveBearer` | rich `auth: 'public' \| PrincipalRequirements` (trust + kind + capabilities) routed through `requirePrincipal()` |
| Input | `args: ZodTypeAny` — JSON body only | `input: ZodTypeAny` — body for POST/PUT/PATCH, query for GET/DELETE; **optional** (freeform routes pass raw `Request`) |
| Handler signature | `(input, ToolContext) → ToolResponse \| ToolResult` (JSON envelope) | `(req: Request, ctx) → Response` (Web-standard; can be SSE, image, file) |
| HTTP path | one fixed `expose.http.path`, defaulting to `/api/agent-tools/<group>/<verb>` (POST) | arbitrary `path` (incl. `:slug` dynamic segments) + any `method` |
| MCP catalog | yes (auto-projected via `expose.mcp`) | no — deliberate (plumbing must not be tools) |
| Role/quota | yes (`roles`, `rolesQuota`, role-gated flavor with `requirePrincipal: false`) | no |
| Streaming / replay / state | `events`, `state`, `modality`, `idleTimeoutSec`, `replayBufferSize` | no |
| Telemetry | `tool_invocations` row | `route_invocations` row, with `sampleRate` |
| Mobile | catchall uses `resolveBearer` (custom path) — does **not** today reach `requirePrincipal`'s mobile resolver | route-stack uses `requirePrincipal()` → mobile JWT works **today** for any `defineRoute` whose `auth.kind` includes `'mobile'` |

Two functional gaps surfaced by the audit, both load-bearing for the unification:

- **G1 — Auth-path divergence.** `defineTool`'s HTTP front door (`apps/operator/lib/endpoint-route/routes/agent-tools/catchall.ts:30`) resolves principal via `resolveBearer` against the workspace PG, **not** through `requirePrincipal()`. Mobile JWTs don't flow through that path — so the brief's "device-JWT → built-in tool" path is not actually reachable, even though the principal type exists. The single most important fix in the plan.
- **G2 — Mobile CORS lives on the legacy router.** `apps/operator/app/api/_hono/mobile.ts:60` carries a per-router CORS allowlist (tauri.localhost, localhost:*, 127.0.0.1:*, 10.0.2.2:*). Route-stack has none. Until CORS is centralized, every mobile-eligible route has to live in `_hono/mobile.ts` or replicate the CORS block.

## 2. End state

**One primitive, three exposure modes.** `defineTool` (kept name) takes:

```ts
defineTool({
  // Identity (auto-derived from filepath if absent)
  name?, description?, guidance?,

  // Auth — unified. Replaces today's `capability`-only gate on defineTool.
  // Accepts the full PrincipalRequirements from defineRoute.
  auth: 'public' | PrincipalRequirements,
  capability?: Capability,           // sugar: pushes into auth.capabilities + sets tier badge

  // Input — single field. Rename `args` → `input` (defineRoute's name is the better one).
  input?: ZodTypeAny,                // optional; freeform handlers read raw Request

  // Handler — unified signature.
  handler: (req: Request, ctx: ToolContext) =>
    | Response                       // freeform (SSE, files, redirects, raw bytes)
    | ToolResult                     // MCP content[] shape
    | ToolResponse                   // {data, uiResources} envelope
    | Promise<above>,

  // Exposure — AT LEAST ONE required. Each surface is independent.
  expose: {
    mcp?:    { name?, streaming?, largeOutput? },        // agent catalog
    http?:   { method | methods, path },                 // path defaults to /api/agent-tools/<name>
    mobile?: true | { capabilities?, cors? },            // NEW — the one-line mobile flag
    ipc?:    true,                                       // NEW (Phase E8) — IPC surface
  },

  // Role/quota/streaming/replay/state (current defineTool)
  roles?, rolesQuota?, modality?, events?, state?,
  replayBufferSize?, idleTimeoutSec?,

  // Timing & telemetry
  timeoutSec?, sampleRate?,
})
```

`expose.mobile` is sugar, not a new transport. It does three things on the dispatcher side:

1. **Adds `'mobile'` to the route's allowed `auth.kind`** (so the JWT principal isn't rejected for kind).
2. **Allows the mobile origins through CORS** (the cross-origin set; loopback-only routes don't get this).
3. **Marks the route in the registry** so the openapi assembler emits a `papercusp:mobile` tag.

`defineRoute` becomes a re-export of `defineTool` for one PR's worth of grace, then deletes. Pre-alpha freedom applies — no deprecation aliases longer than that.

## 3. Functionality crossover — what survives, what merges

**No functionality from defineRoute is lost.** Inventory:

| defineRoute field | Survives as | Notes |
|---|---|---|
| `method` (single) | `expose.http.method` (string) **or** `methods` (array). Both forms accepted. | Locked in via Q3. |
| `path` (incl. `:slug` dynamic) | `expose.http.path`. String passthrough to Hono — `:slug` segments work in the projected-tool catchall too. | Verified. |
| `auth: 'public' \| PrincipalRequirements` | top-level `auth` — same shape, replaces today's `capability`-only gate on defineTool. | `capability:` sugar still accepted for tier-badge lookup. |
| `input` (body OR query) | `input` — same name, same dual semantics. The route-stack's input step already handles this. | Rename today's `defineTool.args` → `input` (mechanical, ~140 callsites). |
| `handler(req, ctx) → Response` (raw) | Unified handler signature; if it returns a `Response`, the framework passes it through. | Detection via `result instanceof Response` — clean discrimination from `ToolResult`/`ToolResponse`. |
| `timeoutSec` | top-level `timeoutSec` (already in defineTool). | — |
| `sampleRate` | top-level `sampleRate` — **add to defineTool**. | Closes a defineTool gap. |
| `ctx.principal` | already in `UnifiedToolContext.principal`. | — |
| `ctx.input` (parsed) | already in `UnifiedToolContext` (passed as fn arg today; move to ctx alongside raw `req`). | — |
| `ctx.params` (path params) | **add to `UnifiedToolContext`** — additive. | Pulls from `hono.req.param()`. |
| `ctx.log` (telemetry-bound) | already in `UnifiedToolContext.log`. | — |
| `ctx.signal` (timeout abort) | already in `UnifiedToolContext.signal`. | — |

What defineTool already has that defineRoute doesn't — these stay:

- `expose.mcp` (catalog projection)
- `roles`, `rolesQuota`, `tier`
- `events`, `state`, `modality`, `replayBufferSize`, `idleTimeoutSec`
- `ctx.emit`, `ctx.askUser`, `ctx.publishState`
- `guidance` (per-tool TSDoc tips)

**Net new functionality:**

- `expose.mobile` flag (CORS + kind allowlist sugar).
- `sampleRate` on tool invocations (parity with route invocations).
- `ctx.params` for path-parameterized tool URLs.

## 4. Dispatch unification — the load-bearing fix (G1)

Today there are **two HTTP entry paths**:

```
defineRoute → registerRoute → Hono → runRouteStack (auth via requirePrincipal) → handler
defineTool  → registerProjectedTool → agent-tools/catchall.ts (auth via resolveBearer) → dispatchProjected → handler
```

These collapse to **one**:

```
defineTool {with expose.http} → registerProjectedTool → routeStack (auth via requirePrincipal) → handler
```

Concretely (Phase E2):

1. **`agent-tools/catchall.ts` switches its auth source** from `resolveBearer` to `requirePrincipal()` (already includes the mobile resolver). The bearer→principal mapping inside `HOST_EXTRAS.resolvePrincipalAndTx` becomes a principal→tx mapping driven by the resolved principal's `workspaceId`. Mobile JWTs work for built-in tools the day this lands.
2. **The route-stack gets a `cors` step prepended** (runs before `auth`). The cors policy is read from a registry of mobile-eligible paths populated by `expose.mobile: true`. Loopback-only routes get no CORS headers.
3. **Telemetry merge.** `tool_invocations` and `route_invocations` collapse: add `kind` column to `tool_invocations` (`'tool' | 'route'`), backfill, drop the route-only table. `/dev` views rewrite.

Risk: the projected-tool catchall serves ~96 tools today. The auth swap must be 1:1 — `resolveBearer` accepts the same superuser-token / cookie / loopback signals `requirePrincipal` does. Verification: extend `auth-posture.test.ts` to assert mobile-JWT hits both a projected tool AND a defineRoute equivalently.

## 5. Decisions locked in (review session 2026-05-21)

| # | Question | Decision |
|---|---|---|
| 1 | Drop dead routes after migration | Yes — `/voice-tool/:name` deletes in E4 (mobile client drops the wrapper in lockstep); per-batch dead-route sweep |
| 2 | Allow `auth: 'public'` + `expose.mcp` | Yes — no typecheck barrier |
| 3 | `method` vs `methods` on `expose.http` | Both accepted |
| 4 | Telemetry table merge | In E2 (same PR as auth swap) |
| 8 | Formerly-deferred items | All pulled into scope (E8–E11) |
| 9 | Legacy `_hono/*` cleanup on desktop side | Yes — confirmed 184 legacy routes across 5 mounted sub-apps; added E12–E14 |

## 6. Phases — status

```
E1  Type unification (no behavior change)                       ✅ SHIPPED  c567f7ac
E2  Auth unification — mobile JWT reaches built-in tools        ✅ SHIPPED  1cccc53f
E3  mobile flag + centralized CORS                              ✅ SHIPPED  17aa7729
E4  Migrate 33 mobile routes (/api/mobile/* wire-compat)        ✅ SHIPPED  9fa447d4
E5  Delete _hono/mobile.ts                                      ✅ SHIPPED  9bc35e3c
E6  Collapse defineRoute → defineTool                           ✅ SHIPPED — see §E6
E7  ESLint enforcement + docs                                   ◐ docs shipped; lint rule gated on E12/E13
E8  IPC transport for unified handlers                          ⬜ deferred — no driver (see §E8)
E9  Auth-tightening pass (229 routes — not 30–50)               ⬜ own plan (see §E9)
E10 OpenAPI mobile-tag rendering                                ✅ SHIPPED
E11 Hono replacement assessment                                 ✅ SHIPPED — verdict: stay on Hono
E12 Migrate _hono/harness.ts (135 routes)                       ⬜ not started — own plan
E13 Migrate coord/plugins/su-locks + orphan triage              ◐ coord+su-locks done; plugins deferred
E14 Delete _hono/* directory                                    ⬜ not started
```

**Shipped (E1–E6, E7-docs, E10, E11, E13-partial):** the complete mobile arc + the collapse. `defineRoute` is a re-export of the unified `defineTool` primitive; `mobile: true` is the one-line flag; all 33 legacy mobile routes are migrated; `_hono/mobile.ts`, `_hono/coord.ts`, `_hono/su-locks.ts` are deleted; auth is unified through `requirePrincipal`.

**The tail (E8, E9, E12, E13-plugins, E14) moved to its own plan:** [`endpoint-hono-elimination-2026-05-21`](./endpoint-hono-elimination-2026-05-21.md). Audit found it is two real projects, not a continuation — ~199 `_hono` routes across 10 routers still to migrate (Workstream A), and ~430 routes to auth-tighten (Workstream B; the "~30–50" estimate below was wrong). E8 (`expose.ipc`) deferred — no driver. The phase notes below are kept for history; the new plan is canonical for that work.

### Phase E1 — Type unification, no behavior change

- Add optional fields to `defineTool`'s input type: `auth`, `input` (alias for `args`), `expose.mobile`, `sampleRate`, `expose.http.path` arbitrary, `expose.http.method` (singular) alongside existing `methods`.
- `defineRoute` becomes a thin wrapper that calls `defineTool` registration with `expose: { http: { method, path } }` and no `mcp` projection. No file deletes yet. Existing route-stack mounting via `registerRoute` is unchanged.
- `tsc` clean across both packages.
- Acceptance: every existing `defineTool` and `defineRoute` callsite compiles unchanged; 264 endpoint-route tests + agent-mcp tool tests green.

### Phase E2 — Auth unification (fixes G1) — ✅ SHIPPED

- ✅ `agent-tools/catchall.ts` `resolvePrincipalAndTx` is now a composite: `resolveBearer` (token_index → agent `system`/`pi`) first, then mobile device JWT. Both arrive as `Authorization: Bearer`, so one hook reaches both. `resolveBearer`'s PG errors are caught so a transient DB failure can't block the self-contained mobile path.
- ✅ `from-bearer-token.ts` resolver added to `requirePrincipal()` + `tryResolvePrincipal()` chains (order: cookie → mobile JWT → superuser → agent bearer → loopback) so a `defineRoute` with `auth: { kind: ['pi','system'] }` resolves agent bearers. Closes the asymmetry where agent bearers only resolved through the catchall's bespoke path.
- ✅ `PrincipalRequirements` + `RouteAuth` exported from `@papercusp/agent-mcp` index (E1 added them to `types.ts` but missed the barrel).
- ✅ Fixed the pre-existing `ReadonlySet`/`Set` mismatch in the catchall (`new Set(principal.capabilities)`).
- ✅ Proving test `agent-tools-mobile-auth.test.ts` — device JWT → principal → built-in tool fn; garbage bearer → anonymous.
- **Deferred:** the "merge route-stack + projected-tool dispatch into one driver" cleanup and the telemetry-table merge → both fold into E6 when `defineRoute` actually collapses. Keeping two dispatch stacks is fine as long as both share `requirePrincipal`-class auth — which they now do.
- Acceptance met: endpoint-route suite green except 2 pre-existing unrelated failures (`auth-posture` — another agent's untracked admin routes; `design.test.ts` — `@restart/db-org` mock drift).

### Phase E3 — `mobile` flag + centralized CORS (fixes G2) — ✅ SHIPPED

- ✅ `mobile?: boolean` on `RouteDefinition`. `registerRoute` mounts the shared `mobileCors` middleware (`lib/endpoint-route/cors.ts`) for `mobile: true` routes — deduped per-app via a `Symbol`-keyed Set so the agent-tools catch-all's 5 same-path defineRoutes don't stack the middleware 5×.
- ✅ `defineRoute` folds `'mobile'` into an explicit `auth.kind` allowlist (idempotent; `auth: 'public'` and kind-unrestricted gates left untouched).
- ✅ `ensureMobileDevicesTable()` DDL moved to `runBootstrap()` (host startup) — the legacy per-request lazy call stays as a safety net until `_hono/mobile.ts` is deleted in E5.
- ✅ `/api/agent-tools/*` catch-all marked `mobile: true` — combined with E2's composite bearer resolver, the phone can now call built-in tools cross-origin.
- ✅ Tests: `mobile-cors.test.ts` (9 tests) — kind-folding, origin allowlist, OPTIONS preflight, no-CORS-on-non-mobile.
- **Note:** the CORS-block deletion from `_hono/mobile.ts` was deferred from E3's bullet to E5 — deleting it while the legacy routes still serve would break mobile clients mid-migration. E3 only *adds* the centralized mechanism.
- **Implementation note:** done as Hono `app.use` middleware, not a route-stack step. The route-stack runs inside a single matched handler and never sees the OPTIONS preflight; `cors()` middleware does. Same end state (one allowlist, declarative opt-in), correct mechanism.

### Phase E4 — Migrate the 33 legacy mobile routes — ✅ SHIPPED

All 33 routes ported to `defineRoute` modules under `routes/mobile/` (renamed `routes/device/` in E15), grouped into 5 family files:

- **`pair.ts` (8):** `/desktop/mint-pair-token`, `/pair`, `/workspace/switch`, `/devices` GET, `/devices/:deviceId` DELETE, `/runtime-config`, `/workspaces`, `/heartbeat`.
- **`voice.ts` (6):** `/voice-lease` GET/claim/heartbeat/DELETE, `/voice-session-init`, `/voice`.
- **`operator.ts` (10):** `/notifications/recent`, `/actions/recent`, `/operator/pause` GET/POST/DELETE, `/operator/cards` GET, `/operator/cards/:id/dispatch`, `/operator/cards/:id/dismiss`, `/operator/standing-candidates` GET, `/operator/standing-candidates/decide`.
- **`harnesses.ts` (7):** `/harnesses`, `/harnesses/:slug`, `/harnesses/:slug/{replan,smoke-test,cleanup}`, `/harnesses/:slug/log/stream` (SSE), `/running`.
- **`sync.ts` (2):** `/rest-query` (query-token auth), `/voice-tool/:name`.

(The brief's M5 `/sync/sse` doesn't exist in the legacy file — the actual count is 33, not 34. `qr.svg` was already a `defineRoute`.)

URLs unchanged (`/api/mobile/*`) — wire-compat with the Rust mobile client. Decisions:
- **Family files, not 33 single-route files.** Each exports an array of `defineRoute`s — mirrors `agent-tools/catchall.ts` + `admin/plans.ts`. Far less boilerplate.
- **JWT routes** → `auth: { kind: ['mobile'] }` + `mobile: true`. **`/pair`** → `auth: 'public'`. **`/desktop/mint-pair-token`** → `auth: 'public'` + inline Host loopback gate. **`/rest-query`** → `auth: 'public'` + inline `?token=` verify (its libs/sync polling caller can't set headers).
- **`principalFromMobileJwt` is now async + revocation-aware** — it runs `isRevoked`, parity with the legacy `deviceAuth()` middleware. Without this, migrating off `deviceAuth` would have silently dropped the revocation check. (`isRevoked` treats an unknown device as revoked, so test JWTs need it mocked.)
- The migrated literals register phase-1 and **shadow** the still-present `_hono/mobile.ts` sub-app — deleted in E5.
- Tests: `mobile-routes.test.ts` (handler-direct, 4 tests). Registration coverage via `route-shadowing-invariant.test.ts`.

### Phase E5 — Delete legacy `_hono/mobile.ts` — ✅ SHIPPED

- ✅ `_hono/mobile.ts` deleted (1009 LOC) + `import { registerMobile }` + `app.route('/mobile', registerMobile)` removed from `_hono/app.ts`.
- ✅ `deviceAuth()` Hono middleware deleted from `mobile-jwt.ts` — its job (signature verify + `isRevoked`) is now `principalFromMobileJwt` via `requirePrincipal`. `signDeviceToken`/`verifyDeviceToken` kept (the resolver + routes use them).
- ✅ `mobile-sse-route.test.ts` deleted — it tested a `/sync/sse` route that had already been removed from `mobile.ts` (the test was already failing; its `sync-sse` import in `mobile.ts` was dead).
- Acceptance: `route-shadowing` + `composed-app-shadowing` + mobile route/auth/CORS suites green (24 tests); no lingering `deviceAuth`/`registerMobile` references.

### Phase E6 — Collapse `defineRoute` into `defineTool` — ✅ SHIPPED

**`defineRoute` is now a re-export of `defineTool`.** The two are one primitive.

The first pass declared this blocked: `defineTool` is in `packages/agent-mcp`, `defineRoute` + `route-stack` are in `apps/operator`, and the package can't import the app. The resolution was to **split the concern** rather than move everything:

- **Route *types* → the package.** `RouteMethod`, `RouteContext`, `RouteDefinition` moved into `@papercusp/agent-mcp/types.ts` (next to `RouteAuth`, already there from E1). They reference only `Principal`/`RouteAuth`/`ZodTypeAny` — all package-resident. No app dependency.
- **The `defineTool` route *branch* → the package.** `defineTool` gained a third overload + a `defineRouteShaped` branch, discriminated structurally by the `method` field. The branch is **pure** — the `mobile: true` `auth.kind` fold + `return def`. No Hono, no `requirePrincipal`. It does NOT register the route into the projection registry (plumbing must not enter the agent catalog).
- **Hono mounting stays host-side.** `apps/operator/lib/endpoint-route/define-route.ts` slimmed to: `export const defineRoute = defineTool` + re-exported route types + `registerRoute` (the only Hono/`route-stack`-coupled piece). A route is *declared* with the package primitive and *mounted* by the host.

Result: `defineTool` is the unified primitive — route-shaped input → `RouteDefinition`, role-gated tool → `RoleToolDefinition`, principal-gated tool → `ToolDefinition`. All 252 `defineRoute` callsites compile unchanged (they import `defineRoute`, which IS `defineTool`). Authors may call `defineTool` directly for routes too.

Key fixes during implementation:
- **Overload order** — the route overload must be *last*. Route-overload-first poisons the contextual typing of tool handlers (widens their return literals, then fails the tool overloads too). Tool calls now resolve against the tool overloads first; genuine route calls fall through structurally.
- **`= undefined` type-param default** on the route overload — without it, a route file with no `input` schema + a standalone `RouteContext<undefined>`-annotated handler leaves `TInputSchema` to fall back to the constraint (`→ RouteContext<unknown>`), which the handler then rejects. The old standalone `defineRoute` had this default; it had to be preserved.
- Test mocks that fully replace `@papercusp/agent-mcp` (`workspaces.test.ts`) now must keep `defineTool` real — switched to the `importActual` spread.

**Not done — and deliberately so:** the cosmetic codemod renaming the 252 `import { defineRoute }` callsites to `defineTool`. The collapse (one implementation, one primitive) is complete; the `defineRoute` name survives as a re-export alias because it is a useful ergonomic signal at the callsites ("plumbing, not an agent tool"). Renaming 252 files is churn without behavior change — a follow-up if desired, not a blocker.

**Telemetry note:** the E2-deferred `route_invocations` → `tool_invocations` merge is **not recommended** — migration 077 separated the tables by deliberate design (RFC Q1: genuinely different column sets, different volume/retention). Folding them undoes a good decision. Dropped from scope.

### Phases E7–E14 — status

E10 + E11 shipped. Remaining: E7 (lint + docs — the `no-raw-route-handlers` rule is gated on E12/E13 migrating the last `_hono/*` routers), E8 (IPC transport), E9 (auth-tightening ~30–50 routes), E12 (migrate `_hono/harness.ts`, 135 routes), E13 (`coord`/`plugins`/`su-locks`, 16 routes + orphan triage), E14 (delete `_hono/`). E12 in particular is the single largest phase (135 route migrations) and warrants its own focused plan + review rather than a rushed pass. The `mobile: true` flag and the unified `requirePrincipal` auth from E1–E5 make every one of those migrations mechanical when they happen.

### Phase E7 — Lint enforcement + docs — ◐ DOCS SHIPPED, lint rule deferred

- ✅ `endpoint-system/overview.mdx` gained a "The route projection" section — `defineTool` route-shaped input, `defineRoute` as a re-export, the `mobile: true` flag.
- ✅ Agent insight already shipped in E5: `agent-insights/mobile-endpoint-unification.mdx`.
- ⬜ **ESLint rule `no-raw-route-handlers`** (reject raw `app.get/.post` in `_hono/*`) — **deferred**, and necessarily so: `_hono/harness.ts` (135 routes), `coord.ts`, `plugins.ts`, `su-locks.ts` still use raw `app.get/.post`. Landing the rule now would fail lint across the whole `_hono/` dir. It must follow E12/E13.

### Phase E8 — IPC transport for unified handlers — ⬜ NOT STARTED (no driver; recommend deferral)

- The `expose.ipc?: true` flag is typed (E1) but inert. The plan was to extend the endpoint-IPC adapter to carry route-shaped (`Response`-returning) handlers over the UDS frame.
- **No consumer exists.** Routes are HTTP plumbing called by the browser / desktop shell; the IPC fast-path serves *agent tool* dispatch (the Rust client). A route-over-IPC has no identified caller. Building the adapter now is speculative machinery.
- **Recommendation:** keep `expose.ipc` as a reserved flag; implement E8 only when a concrete route-over-IPC need appears (e.g. the Rust mobile-server wanting to invoke a plumbing route in-process). Deferred, not dropped.

### Phase E9 — Auth-tightening pass — ⬜ NOT STARTED (scope corrected — needs its own plan)

**Audit finding (2026-05-21): the scope is 229 routes, not "~30–50".** The endpoint-route migration landed *every* route as `auth: 'public'` — it preserved behavior by deferring all auth-tightening. Of the 229:

- **29** carry an **inline** auth check (`requirePrincipal`, `isLoopbackRequest`, `getSessionUser`, `readIdentity`, …) — `auth: 'public'` is a lie; the real gate is in the handler. These should become declarative `PrincipalRequirements`.
- **200** carry **no auth check at all** — they are genuinely fail-open at the type level, protected today only by the operator's loopback bind.

This is a real security pass, not a mechanical cleanup, and it **cannot be done blind**:
- A uniform "convert all 200 to `{ trust: ['trusted','verified','unverified-loopback'] }`" would be behavior-preserving for loopback-bound traffic (every legit caller resolves ≥ a loopback principal) — *but* it would break the genuinely-public routes (OAuth callbacks under `oauth/*`, `flags/webhook`, `mobile/pair`, `mobile/desktop/mint-pair-token`, `mobile/rest-query`, `mobile/qr.svg`) that are called with no principal by design.
- So each of the 229 needs a per-route decision: genuinely public, loopback-tier, verified-user, or trusted-only.
- 229 auth-posture changes cannot be verified in a single pass — getting one wrong is either a fail-open security hole or a broken caller.

**Recommendation:** E9 is its own focused plan (`endpoint-auth-tightening-<date>`), sized like the route-migration itself — family batches, per-batch review, the `auth-posture.test.ts` rationale catalog as the acceptance gate. Not foldable into the unification arc.

### Phase E10 — OpenAPI mobile-tag rendering — ✅ SHIPPED

- ✅ `routeToOpenApiFragment` emits `tags: ['papercusp:mobile']` for any `mobile: true` route, so an OpenAPI consumer (or the mobile client reading `openapi.json`) can filter the paired-phone surface.
- ✅ Tests in `openapi.test.ts` (3) — tag present on `mobile: true`, absent otherwise, present on every migrated `/api/mobile/*` route (`qr.svg` excepted — it is loopback-only by design, not a cross-origin phone route).
- **Not done:** the `/dev → Endpoints` panel tag *filter* — a UI nicety; the substantive part (the tag in `openapi.json`) is shipped. Optional follow-up.

### Phase E11 — Hono router replacement assessment — ✅ SHIPPED (verdict: stay on Hono)

**Question:** now that the endpoint system is unified, should Papercusp replace Hono with something else (raw `@hono/node-server` routing, Node `http`/`http2`, or another framework)?

**Verdict: stay on Hono. Do not replace it.**

**How coupled is the codebase to Hono, really?**
- The unified primitive (`defineTool` route branch) is **router-agnostic** — it produces a plain `RouteDefinition` (`{ method, path, auth, handler }`) with Web-standard `Request`/`Response`. Nothing Hono-specific.
- `route-stack.ts` — the dispatch pipeline — touches Hono only through one field: `exec.hono` (the `Context`), and only to read `req.raw` and `req.param()`. Trivially abstractable.
- `registerRoute` (~40 lines) is the **single** Hono-coupled mount point for the ~250 unified routes: `app.on(method, path, …)` + `app.use(path, mobileCors)`.
- The legacy `_hono/*` sub-apps (`harness.ts`, `coord.ts`, `plugins.ts`, `su-locks.ts`) DO use Hono pervasively (`new Hono()`, `app.route`, `c.json`) — but those are exactly what E12/E13 migrate *off* Hono-router-style and onto `defineRoute`. After E12–E14, the only Hono surface left is `_hono/app.ts` (the app instance + `cors`/`compress` middleware) and `registerRoute`.

**Cost of replacing Hono:** rewrite `_hono/app.ts`, `registerRoute`, the `route-stack`'s `Context` coupling, the `cors`/`compress` middleware integration, and re-validate all ~250 routes + the host (`@hono/node-server`). Weeks. Regression surface: the entire HTTP API.

**Benefit of replacing Hono:** approximately none. Hono is mature, fast, zero-dependency, Web-standard (`Request`/`Response` native — which is *why* the endpoint system is host-neutral), and already integrated with `@hono/node-server`. No performance ceiling, licensing issue, or missing capability has been identified. The endpoint-system abstraction already delivers the only real benefit a swap could offer — insulation from the router — so the router choice is a settled, low-risk detail.

**If a future driver appears** (e.g. the `operator-vite` host migration wanting a different server, per `host-architecture-2026-05-20-v2`), the swap is localized to `registerRoute` + `_hono/app.ts` + the `route-stack` `Context` read — a bounded change precisely *because* the endpoint system was unified. Revisit then, with a concrete driver. Not now.

### Phase E12 — Migrate `_hono/harness.ts` (135 routes)

- 17 batches of ≤8 routes each. Auth posture is already mostly correct; bulk is converting `harness.get('/path', ...)` → `defineTool({ expose: { http: { path: '/harness/path' } }, ... })`.
- URLs stay at `/api/harness/*` — wire-compat with desktop UI.
- Biggest single phase; will dominate the timeline.

### Phase E13 — Migrate `coord` / `plugins` / `su-locks` + orphan triage — ◐ coord+su-locks SHIPPED

- ✅ **`coord.ts` (8 routes)** → `routes/coord/index.ts`. All `auth: 'public'` — the legacy `coord` sub-app had no auth middleware; posture preserved. File + `app.route('/coord', …)` mount deleted.
- ✅ **`su-locks.ts` (1 route)** → `routes/su-locks/hook-health.ts`. File + mount deleted. Its 6-case test migrated to `endpoint-route/__tests__/su-locks.test.ts` (handler-direct).
- ⬜ **`plugins.ts` (7 routes)** — **deferred.** `plugins.ts` is not a plain route bundle: `installPluginApiDispatcher(plugins)` *mutates* the `plugins` Hono sub-app to add the dynamic plugin-API catch-all, and `_hono/app.ts` mounts that sub-app. Migrating the 7 static routes to `defineRoute` while the sub-app must survive for the dispatcher = churn without the delete-win. It needs a focused pass that relocates the dispatcher first. Documented for a follow-up.
- ⬜ Orphan triage of the 9 unmounted `_hono/*.ts` files — deferred with `plugins.ts`.

### Phase E14 — Delete `_hono/` directory

- After E5 + E12 + E13, only `app.ts` (host seam) and possibly `bootstrap.ts` (startup hooks) remain.
- Delete the rest; rename the directory if useful.

### Phase E15 — mobile → device generalization — ✅ SHIPPED

Post-E1–E14 follow-up (commits `ea779f95`, `d17a3b09`, `3480a51c`, `5bccbd29`; Rust client `236e935`). Supersedes the *mobile-specific* parts of E2/E3/E4/E10. "mobile" bundled three orthogonal concerns under one name — a principal kind, a CORS posture, and a route category. Each is general; none is intrinsically mobile (a phone is just the first *device*). So "mobile" was split into general primitives and deleted as a concept.

- **`'device'` principal kind** replaces `'mobile'` (`PrincipalKind`, `auth/principal/from-device-jwt.ts`). Any route opts in via `auth: { kind: ['device'] }`.
- **`auth.tokenIn: ('header'|'query')[]`** — a general token-source option. The route-stack lifts `?token=` into a synthetic `Authorization: Bearer` when a route admits `'query'`. `rest-query` uses `tokenIn: ['query']`; this replaces its per-route inline `?token=` hack.
- **`cors` route field** (`boolean | { origins }`) replaces the `mobile` flag for cross-origin reachability — orthogonal to auth.
- `routes/mobile/` → `routes/device/`; URLs `/api/mobile/*` → `/api/device/*`; OpenAPI tag `papercusp:mobile` → `papercusp:device`; `MOBILE_AUTH` → `DEVICE_AUTH`; `lib/mobile-*.ts` → `lib/device-*.ts`.
- Cloudflare ingress v16: `api.papercuspai.com ^/api/device → :3070`. Rust client base path `/api/mobile` → `/api/device`.

**`routes/device/` is the ratified end state — a single domain folder, not a dissolution into `routes/harness/` + `routes/operator/` + `routes/voice/`.** The repo convention is folder name = first URL segment (`routes/harness/` → `/harness/*`); given the confirmed `/api/device/*` URL prefix, one `routes/device/` folder is the consistent home. The earlier "scatter into domain folders" sketch only applied under the abandoned "merge mobile and desktop endpoints onto a shared route" branch.

Kept deliberately (not stale): the `device_kind` JWT claim value stays `'mobile'` (a form-factor — extensible to `cli` / `kiosk`); the `Surface` enum values (`mobile-android` etc.) are ElevenLabs wire values; `MOBILE_*` env var names are deployment config.

Audit follow-up (review of this doc, 2026-05-21 — commits `e4f5f985`, `6c142872`, `b1af1541`): deleted the vestigial `GET /device/voice` HTTP stub, removed the dead `ToolExposure.mobile` field, retargeted the e2e spec, and swept the residual stale `mobile-` file/comment references.

## 7. Risks & mitigations

- **R1 — Auth-path swap (G1) breaks built-in tools.** Mitigation: matrix test in `auth-posture.test.ts` covering cookie / superuser / loopback / mobile-JWT × tool-vs-route × success/denied; run before E2 merge.
- **R2 — Wire break for mobile client during E4.** Mitigation: keep `/api/mobile/*` URLs; convert in-place; mobile client doesn't need to change.
- **R3 — Telemetry table merge.** Mitigation: backfill migration in one transaction; preserve `/dev` views by aliasing. Route table is ~2 weeks old, one panel consumes it.
- **R4 — Codemod regressions in E6.** Mitigation: rename PR ships after one full session of dual-export, gated on tsc + 264-test suite.
- **R5 — `ctx.params` addition breaks plugin tools.** Mitigation: purely additive on `UnifiedToolContext`; existing plugins ignore it.
- **R6 — E12 (harness migration) is the biggest single phase.** Mitigation: 17 small batches; per-batch acceptance (route serves identically via Hono `app.request()`, original block deleted, tsc clean); ship daily.

## 8. Out of scope (genuinely deferred)

- Cross-workspace endpoint discovery / federation.
- Replacing `mobile-jwt` with a richer device-identity scheme (Track A in the principal RFC).
- Splitting `apps/operator` further (workspaces stay one app for now).

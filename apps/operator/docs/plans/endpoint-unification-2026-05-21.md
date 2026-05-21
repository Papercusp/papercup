---
title: Endpoint unification — collapse defineRoute into defineTool, add expose.mobile
slug: endpoint-unification-2026-05-21
status: active
created: 2026-05-21
updated: 2026-05-21
owner: pandawamble@gmail.com
companion-to: [endpoint-route-migration-2026-05-20, phase-4-endpoint-system-2026-05-12, principal-rfc-2026-05-20, host-architecture-2026-05-20-v2]
---

<!--
STATUS 2026-05-21: E1–E6 SHIPPED. defineRoute is now a re-export of the
unified defineTool primitive — the collapse is done. E7–E14 not started.
-->


## Now

**State:** E1 + E2 shipped. E1 (`c567f7ac`) — type-additive `defineTool` fields. E2 — the load-bearing auth fix: the `/api/agent-tools/*` catch-all now resolves a mobile device JWT (composite bearer resolver: `resolveBearer` token_index → mobile JWT), and `requirePrincipal()` gained a `from-bearer-token` resolver so agent `system`/`pi` bearers resolve there too. A paired phone can now call any built-in `defineTool`.

**Next:** E7 (ESLint enforcement + docs) — though its `no-raw-route-handlers` rule is gated on E12/E13 migrating the remaining `_hono/*` routers.

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
E7  ESLint enforcement + docs                                   ⬜ not started
E8  IPC transport for unified handlers                          ⬜ not started
E9  Auth-tightening pass (~30–50 routes)                        ⬜ not started
E10 OpenAPI mobile-tag rendering                                ✅ SHIPPED
E11 Hono replacement assessment                                 ⬜ not started
E12 Migrate _hono/harness.ts (135 routes)                       ⬜ not started — own plan
E13 Migrate coord/plugins/su-locks (16 routes) + orphan triage  ⬜ not started
E14 Delete _hono/* directory                                    ⬜ not started
```

**Shipped (E1–E6):** the complete mobile arc + the collapse. `defineRoute` is a re-export of the unified `defineTool` primitive; `mobile: true` is the one-line flag; all 33 legacy mobile routes are migrated; `_hono/mobile.ts` is deleted; auth is unified through `requirePrincipal`. E7–E14 remain; E12 (135 routes) warrants its own focused plan.

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

All 33 routes ported to `defineRoute` modules under `routes/mobile/`, grouped into 5 family files:

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

Not started. E7 (lint + docs), E8 (IPC), E9 (auth-tightening ~30–50 routes), E10 (OpenAPI mobile tag), E11 (Hono assessment), E12 (migrate `_hono/harness.ts`, 135 routes), E13 (`coord`/`plugins`/`su-locks`, 16 routes + orphan triage), E14 (delete `_hono/`). E12 in particular is the single largest phase (135 route migrations) and, like E6a, warrants its own focused plan + review rather than a rushed pass. The `mobile: true` flag and the unified `requirePrincipal` auth from E1–E5 make every one of those migrations mechanical when they happen.

### Phase E7 — Lint enforcement + docs

- ESLint rule `no-raw-route-handlers`: reject `app.get/.post` in `_hono/*` outside `app.route(...)` or `registerAllRoutes(app)`.
- Doc updates: `/internal/docs/endpoint-system/overview` reflects single primitive; dedicated `defineRoute` page deletes; `expose.mobile` gets a section under `Mobile`.
- Agent insight: `agent-insights/unified-define-tool-2026-05-21.mdx`.

### Phase E8 — IPC transport for unified handlers

- Extend the existing endpoint-IPC adapter (Phase 4 plan) to recognize route-shaped handlers returning raw `Response`; stream body bytes over UDS frame.
- New `expose.ipc?: true` flag. Default `false`.
- Acceptance: a `defineTool` with `expose: { ipc: true, http: {...} }` is callable from a Rust client over UDS framing.

### Phase E9 — Auth-tightening pass

- Walk every endpoint that landed as `auth: 'public'` with an inline check; convert to proper `PrincipalRequirements` gate.
- Target ~30–50 routes (the carve-outs from R5). Per-route audit; family batches of ~10.
- Acceptance: `git grep "auth: 'public'"` returns only routes that genuinely don't need auth; `auth-posture.test.ts` enumerates every public route with a rationale.

### Phase E10 — OpenAPI mobile-tag rendering — ✅ SHIPPED

- ✅ `routeToOpenApiFragment` emits `tags: ['papercusp:mobile']` for any `mobile: true` route, so an OpenAPI consumer (or the mobile client reading `openapi.json`) can filter the paired-phone surface.
- ✅ Tests in `openapi.test.ts` (3) — tag present on `mobile: true`, absent otherwise, present on every migrated `/api/mobile/*` route (`qr.svg` excepted — it is loopback-only by design, not a cross-origin phone route).
- **Not done:** the `/dev → Endpoints` panel tag *filter* — a UI nicety; the substantive part (the tag in `openapi.json`) is shipped. Optional follow-up.

### Phase E11 — Hono router replacement assessment

- Written cost/benefit assessment, NOT a port. Unified primitive doesn't care what router serves it.
- Output: a follow-up plan doc (or a "stay on Hono" memo) — decide whether to execute after E1–E10 ship.

### Phase E12 — Migrate `_hono/harness.ts` (135 routes)

- 17 batches of ≤8 routes each. Auth posture is already mostly correct; bulk is converting `harness.get('/path', ...)` → `defineTool({ expose: { http: { path: '/harness/path' } }, ... })`.
- URLs stay at `/api/harness/*` — wire-compat with desktop UI.
- Biggest single phase; will dominate the timeline.

### Phase E13 — Migrate `coord` / `plugins` / `su-locks` (16 routes) + orphan triage

- `coord.ts` (8), `plugins.ts` (7), `su-locks.ts` (1).
- Delete `app.route(...)` mounts in `_hono/app.ts`.
- Triage 9 unmounted `_hono/*.ts` files: load-bearing vs dead vs helper. Move helpers to `lib/`.

### Phase E14 — Delete `_hono/` directory

- After E5 + E12 + E13, only `app.ts` (host seam) and possibly `bootstrap.ts` (startup hooks) remain.
- Delete the rest; rename the directory if useful.

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

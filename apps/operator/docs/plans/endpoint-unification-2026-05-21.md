---
title: Endpoint unification — collapse defineRoute into defineTool, add expose.mobile
slug: endpoint-unification-2026-05-21
status: active
created: 2026-05-21
updated: 2026-05-21
owner: pandawamble@gmail.com
companion-to: [endpoint-route-migration-2026-05-20, phase-4-endpoint-system-2026-05-12, principal-rfc-2026-05-20, host-architecture-2026-05-20-v2]
---

## Now

**State:** E1 + E2 shipped. E1 (`c567f7ac`) — type-additive `defineTool` fields. E2 — the load-bearing auth fix: the `/api/agent-tools/*` catch-all now resolves a mobile device JWT (composite bearer resolver: `resolveBearer` token_index → mobile JWT), and `requirePrincipal()` gained a `from-bearer-token` resolver so agent `system`/`pi` bearers resolve there too. A paired phone can now call any built-in `defineTool`.

**Next:** E4 — migrate the 33 legacy `_hono/mobile.ts` routes to `defineRoute` (5 family batches; URLs stay `/api/mobile/*`).

E3 shipped: `mobile: true` flag on `RouteDefinition` — `registerRoute` mounts the shared `mobileCors` middleware (deduped per-app), `defineRoute` folds `'mobile'` into an explicit `auth.kind`. `ensureMobileDevicesTable()` DDL moved to `runBootstrap()`. The `/api/agent-tools/*` catch-all is now `mobile: true` so the phone reaches built-in tools cross-origin.

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

## 6. Phases — final arc

```
E1  Type unification (no behavior change)
E2  Dispatch + telemetry merge (fixes G1, mobile JWT reaches built-in tools)
E3  expose.mobile + centralized CORS (fixes G2)
E4  Migrate 33 mobile routes (5 batches, /api/mobile/* wire-compat)
E5  Delete _hono/mobile.ts
E6  Codemod defineRoute → defineTool, delete defineRoute symbol
E7  ESLint enforcement + docs
E8  IPC transport for unified handlers
E9  Auth-tightening pass (~30–50 routes)
E10 OpenAPI mobile-tag rendering
E11 Hono replacement assessment (written, not executed)
E12 Migrate _hono/harness.ts (135 routes, ~17 batches)
E13 Migrate coord/plugins/su-locks (16 routes) + triage 9 orphan files
E14 Delete _hono/* directory (keep only app.ts as host seam)
```

**Total surface migrated:** mobile 33 + harness 135 + others 16 = **184 legacy routes** on top of the 242 already-`defineRoute` modules.

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

### Phase E4 — Migrate the 33 legacy mobile routes

Family batches of ≤8 routes per PR:

- **M1 — Pair + device lifecycle (8):** `/pair`, `/heartbeat`, `/devices` GET/DELETE, `/workspaces`, `/workspace/switch`, `/runtime-config`, `/desktop/mint-pair-token`.
- **M2 — Voice (6):** `/voice-lease` × 4, `/voice-session-init`, `/voice` (WS bootstrap).
- **M3 — Operator surface (8):** `/operator/pause` × 3, `/operator/cards` × 3, `/operator/standing-candidates` × 2, `/notifications/recent`, `/actions/recent`.
- **M4 — Harness surface (7):** `/harnesses` × 6, `/running`.
- **M5 — Sync + freeform (4):** `/sync/sse`, `/rest-query`, `/voice-tool/:name`, `/qr.svg` (already migrated; reshape).

URLs stay at `/api/mobile/*` — wire-compat with the mobile client.

### Phase E5 — Delete legacy `_hono/mobile.ts`

- Remove file + `app.route('/mobile', registerMobile)` mount in `_hono/app.ts`.
- Delete `deviceAuth()` Hono middleware (its job is now `requirePrincipal()`).
- Keep `mobile-jwt.ts` core verify/sign helpers (used by principal resolver).
- Acceptance: mobile client end-to-end smoke test (pair → list devices → SSE sync → tool call) passes through the new dispatcher.

### Phase E6 — Delete `defineRoute` symbol

- `defineRoute` becomes `export { defineTool as defineRoute }` for one PR cycle.
- Codemod 242 callsites: `s/defineRoute(/defineTool(/g` + manual review of `expose.http` shape differences.
- Delete `apps/operator/lib/endpoint-route/define-route.ts`.
- Move route-stack to `packages/agent-mcp/src/route-stack.ts`.
- Rename `endpoint-route/` → `endpoint/`.

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

### Phase E10 — OpenAPI mobile-tag rendering

- `openapi.json` assembler reads `expose.mobile`; adds `papercusp:mobile` tag.
- `/dev → Endpoints` panel filters by tag.
- Small — ½ day. May ride along with E3.

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

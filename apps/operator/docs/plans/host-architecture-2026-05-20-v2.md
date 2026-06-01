---
title: Host architecture — implementation plan v2
slug: host-architecture-2026-05-20-v2
status: active
created: 2026-05-20
updated: 2026-06-01
owner: pandawamble@gmail.com
supersedes: [host-architecture-2026-05-20]
---

## Now

**State:** The host-agnostic-core infrastructure is the live, valuable scope: Phase 1 (IPC `sys:http` bridge — SHIPPED, see `libs/generic/ipc-endpoint-server/src/sys-http.ts`), Phase 2 (platform-adapter interface), Phase 3a (composable middleware), Phase 3b (principal RFC — internal auth only), Phase 4 (route-migration audit), Phase 6a/6b (layering), Phase 7 (OpenAPI surface). ⛔ RETIRED 2026-06-01 (user): **Phase 8 (webapp host)**, **Track A (auth & multi-tenancy)**, and this plan's top-of-body **"Decision reversal banner"** are DEAD — the standalone webapp is retired (CLAUDE.md canon) and is not coming back. Do NOT build them. Confirmed no code depends on them (the only reference is a doc comment in `apps/operator/lib/auth/principal/from-loopback.ts`). See the retirement decision below.

**Next:** Owner — live remaining infra is Phase 2 (platform-adapter interface), Phase 3a (composable middleware), Phase 6a (layering scaffold), and the Phase 4 route-migration audit. Ignore Phase 8 / Track A / the reversal banner (retired); the body banner is stale.

## Recommended first move

**Build the platform before moving routes onto it.** The plan's ordering already does this; v2 makes it explicit. The first ~4 weeks of work are Phases 1, 2, 3a, and 6a — the infrastructure substrate. Route migration (Phase 4) only starts once that substrate is real. Migrating 217 routes onto a half-baked platform would force re-migration when the platform settles.

| Order | Phase | Why first | Estimate |
|---|---|---|---|
| 1 | **Phase 1** — IPC `sys:http` bridge + polyfills | All IPC infrastructure already exists; zero Rust changes; smallest scope; delivers reliability immediately | ~1 week |
| 2 | **Phase 2** — Platform-adapter interface | Defines the host-boundary shape the rest of the work conforms to | ~1 week (interface PR; migration tail is parallel, ongoing) |
| 3 | **Phase 3a** — Compose existing middleware | Provides the gating/auth/quota surface route migrations will consume | ~1 week |
| 4 (interleave) | **Phase 6a** — Layering scaffold | Provides the structural slots; can start as soon as Phase 2 defines the boundary | ~1 week |
| Parallel | **Phase 3b** design spike | Design-review-gated; can spike any time | Independent |
| Parallel | **Track A** owner assignment | Webapp prerequisite; not strictly desktop infrastructure | Independent |

**Phase 4 (route migration) starts once Phases 1 + 2 + 3a have shipped.** Phase 6a can land before or alongside Phase 4. Everything else (3b RFC, Phase 6b enforcement, Phase 7, Phase 8) follows in dependency order.

---

## ⛔ Decision reversal banner — RETRACTED 2026-06-01

> **This banner is DEAD. Do not act on it.** It tried to re-introduce a webapp host
> target; that was retracted by the user on 2026-06-01: **the standalone webapp is
> retired (CLAUDE.md canon) and is not coming back.** The prior decisions it claimed
> to "reverse" are STILL IN FORCE. See `## Now` + decision **D-001**. Phase 8 (webapp
> host) and Track A (auth & multi-tenancy) are retired — do not build them.

| Prior decision | Source | Status (RE-AFFIRMED 2026-06-01) |
|---|---|---|
| "Webapp retired; Tauri dev is the only test path." | `feedback_webapp_retired_use_tauri_dev.md` (2026-05-14) | **In force.** The standalone webapp is retired; do not build a webapp host. |
| "Webapp is test-only." | `project_papercup_deployment_model.md` | **In force.** |
| "Operator auth is loopback-only." | `project_operator_auth_loopback.md` | **In force.** (Internal principal work = Phase 3b; genuine user-protection = `papercusp-user-protection-gate-2026-05-31`.) |
| "Desktop releases are local; no GitHub Actions." | `reference_desktop_releases_local.md` | **In force.** |

---

## Target shape

**papercusp = one host-agnostic client + one host-agnostic core + a thin platform adapter + a swappable transport projection between them.**

- **Client** — React UI. Reaches the core through exactly two seams: `useSyncQuery` (data/reads) and `dispatchEndpointStream` (imperative/actions). Identical on desktop and webapp; the seams' implementations swap by host.
- **Core** — the endpoint system (`define_tool` handlers) + orchestration logic. Cannot import from `next/*`, Tauri, or Node `fs`; takes typed inputs, returns typed outputs/events.
- **Platform adapter** — the ~10% that genuinely is host-specific: fs, process spawning, embedded-PG location, sockets. One interface, with a desktop impl and a server impl.
- **Transport projection** — carries both seams' traffic between client and core: IPC + loopback HTTP on desktop today (boundary shifts as routes consolidate); HTTP on the webapp.

**Scope:** all work targets `apps/operator`, `packages/`, and the live `libs/`. **Excludes `libs/papercusp/*`** — that's the parallel rust-port submodule with its own discipline.

---

## Cross-phase dependency DAG

```
                                Track A (auth+multi-tenancy)
                                          │
                                          ▼
  Phase 1 (IPC bridge) ──┐         Phase 8 (webapp host)
                         │                ▲
  Phase 2 (adapter) ─────┼──> Phase 3a ──> Phase 4 ──> Phase 6b
                         │      (mw)     (routes)    (layering
                         │                            enforce)
                         └──> Phase 6a (layering scaffold)
                              │
                              ▼
                          Phase 7 (OpenAPI surface)

  Phase 3b (principal RFC) — parallel; gated only on its own design review
```

| Edge | Type | Why |
|---|---|---|
| Phase 1 → Phase 4 | recommended | IPC is the desktop transport for migrated routes |
| Phase 2 → Phase 4 | hard | host-agnostic core needs the adapter interface to call fs/spawn |
| Phase 3a → Phase 4 | hard | composable middleware is the gating/quota/auth surface migrated routes consume |
| Phase 4 ≥75% → Phase 6b | hard | layering enforcement cannot land until routes are disentangled |
| Track A → Phase 8 | hard | webapp without real auth isn't a webapp |
| Phase 3b → (informs) Phase 8, Track A | soft | principal abstraction is what auth middleware will be defined against |

Critical path is **Track A and Phase 4**. Everything else parallelizes against those two.

---

## Procedural disciplines — apply to every phase

1. **Pre-flight audit per route before migration** (the agent-chats lesson at scale): classify each candidate against four axes — (a) does the handler hold non-transport state? (b) is there pre/post handler work that doesn't belong in a transport-agnostic tool? (c) does it touch cookies/cost-caps/feature-locks? (d) is its wire contract stable? Any "yes" → A1-class, leave as a shim. Migrate-count is a ceiling, not a target.
2. **Per-phase, machine-greppable acceptance.** Every phase ships when a bash one-liner proves it. "Looks clean" is not shipped.
3. **Per-phase NOT-shipping line.** Explicit non-scope per phase. Prevents creep.
4. **Reversals of memory'd decisions list all downstream reversals** (banner at top is the canonical example).
5. **No elevation of deferred items without a concrete second consumer.** Naming the consumer is the cost of elevation.
6. **Per-phase rollback** in writing, not aspirational.

---

## Ideas to borrow

**1. Build-enforced layering** *(VS Code)* — core logic physically cannot import host APIs. **Honest cost:** multi-week TS-monorepo refactor (tsconfig projects per layer + ESLint/dependency-cruiser rules + untangling existing `next/*`/`tauri/*`/`fs` imports). Tightly coupled to Phase 4. Split into Phase 6a (scaffold) + Phase 6b (enforcement).

**2. Platform-adapter interface** *(VS Code services + Obsidian vault adapter)* — host-specific 10% behind one small interface; desktop impl and server impl. **Audit finding:** `packages/agent-mcp/src` and `libs/sync/src` are already host-clean (0 `fs`/`spawn` imports). But `apps/operator/lib/` has **106 files** using them — the interface ships in one PR; migrating those 106 onto the adapter is a parallel-running tail.

**3. Transport as pure projection + composable client-side picker** *(your endpoint system + tRPC/oRPC "links")* — formalize `transport-adapters` into a composable link chain.

**4. Close subscription/resumability gaps in the existing endpoint surface** *(reframed from "new endpoint kind")* — the endpoint system already has `events:`, `state:`+`publishState`, `replayBufferSize` + Last-Event-ID resume (PR #73 / `2c06c8f7`). Work is gap-closure on existing primitives.

**5. Extract + expose the existing middleware stack** *(reframed from "build")* — `dispatch-projected.ts` already injects gating/quota/telemetry/idle/HMAC via `DispatchProjectedDeps`. Work is making them **composable + ordered + replaceable**, not inventing them. Splits into Phase 3a (extract) and Phase 3b (principal RFC).

**6. Decouple the core from the Next runtime** *(WinterCG portable-handler / VS Code one-core-many-targets)* — core does not import `next/*`. Next is one host of the HTTP projection, not the framework everything is welded to. **Decouple ≠ drop:** Next keeps hosting the routes; the work is pulling `next/*` references out of *handler logic* into the *route shims*.

**7. Two seams, both host-swappable** *(VS Code service-swap; Linear/Obsidian as the webapp-era impl)* — `useSyncQuery` (data) and `dispatchEndpointStream` (imperative). *Today on desktop:* request/response. *Webapp era:* local-first replica added as a new impl behind `useSyncQuery`. Corollary: `rest-query` belongs to the data seam, **not** the endpoint system.

**8. Extend `tools/list` to be OpenAPI-shaped** *(reframed; smaller delta)* — `tools/list` (in `packages/agent-mcp/src/server.ts`) already surfaces event JSON-schemas. Work is extending its payload to OpenAPI-compatible, not building a new contract dump.

---

## Non-borrows (settled — don't re-litigate)

- **No protobuf / ConnectRPC** as the definition layer.
- **No Figma-style WASM core** — papercusp's backend is I/O orchestration.
- **No tRPC/oRPC wholesale** — borrow patterns; keep `define_tool`.
- **No local-first/Zero on the desktop** — redundant when the server is local; webapp-era only.
- **No big-bang rewrite.**
- **No "drop Next."** Decouple, don't remove (245 route files + 63 pages + 800+ `next/*` imports = multi-month replacement with no driver).

---

## Phases

### Phase 1 — IPC `sys:http` bridge + EventSource/fetch polyfills

- **Scope:** drafted in `desktop-ipc-transport-completion-2026-05-20.md` (Phases 0–3). `sys:http` pseudo-tool + EventSource/fetch polyfills.
- **Motivator (reframed):** the 3 fixes already shipped this session (`21e5c1b3` SSE transport+dedup, `1b2ee83` libs/sync batching) mitigate the worst connection-pool symptoms; the live bug is *mostly* fixed. Phase 1 is now **reliability + foundation for the rest of the plan** — not firefighting. Still recommended order #1.
- **IPC framing reality:** IPC carries the 6 allowlisted endpoint-system tools today + (after this phase) polyfill-routed fetch/SSE. Everything else stays loopback HTTP. Boundary shifts as routes consolidate (Phase 4).
- **Dispatch option:** v1 uses loopback-fetch (option 1a). In-process `app.fetch()` (option 1b) would require exporting `app` from `apps/operator/app/api/[[...route]]/route.ts` (currently only `GET`/`POST`/etc. are exported). Trivial change; defer until there's a reason to remove the internal loopback port.
- **Cookie surface:** 6 routes use `next/headers`/`cookies()`. `sys:http` forwards `document.cookie` in headers.
- **Acceptance:** `ss -tnp` from the running webview shows ≤ 2 ESTAB HTTP connections at rest (down from 6–7); the live-thinking popover connects in well under a second, repeatably, after a **cold relaunch**.
- **NOT shipping:** no per-route migration; no Rust changes; no custom protocol (Phase 4 of the IPC doc, deferred).
- **Rollback:** `NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT=1` skips the polyfill install.

### Phase 2 — Platform-adapter interface

- **Scope (interface PR):** define one `HostPlatform` interface for fs / spawn / embedded-PG URL / socket dir. Ship desktop impl + a stub server impl that throws. Migrate **one consumer** to prove the shape.
- **Parallel migration tail:** `apps/operator/lib/` has **106 files** importing `node:fs`/`child_process` today. Many of these are tool handlers that ought to be host-agnostic. After the interface exists, **migrating those 106 onto it is ongoing hygiene** — runs in parallel with Phase 4, paced by per-handler audit. Not gated; not a phase boundary.
- **Acceptance (interface PR):** `grep -r "node:fs\|child_process" packages/agent-mcp/src libs/sync/src libs/endpoint-system/src 2>&1 | wc -l` returns 0 after the interface is consumed by ≥1 handler.
- **NOT shipping:** mass migration of the 106 files (that's the parallel tail). The interface + desktop impl + one consumer only.
- **Rollback:** revert is a single-PR revert.

### Phase 3a — Extract dispatcher middleware to a composable stack

- **Scope:** `packages/agent-mcp/src/dispatch-projected.ts` (702 lines, one file) — existing in-place gating/quota/telemetry/idle/HMAC become ordered, named, replaceable middleware. The dispatcher already exposes these via `DispatchProjectedDeps`; work is **making them composable + ordered**, not inventing them.
- **Acceptance:** existing dispatcher tests pass without change; new test enumerates the middleware stack in order; existing `recordInvocation` / quota / idle behavior identical on the wire.
- **NOT shipping:** principal abstraction (Phase 3b); new middleware (per-feature later).
- **Rollback:** revert; middleware definitions are additive over the existing dispatcher.

### Phase 3b — Principal RFC + implementation

- **Scope:** unified `Principal` abstraction across HTTP / MCP / IPC. Design-review gated.
- **Decisions needed before coding:** host-issued vs platform-issued tokens; mobile-JWT fit (memory: `feedback_mobile_targets_hono.md`); consolidation of the **8+ scattered loopback-only auth checks** identified in the blocker report (`auth/me`, `auth/logout`, `auth/change-password`, `mobile/qr.svg`, `dev/processes/kill`, `agent-mcp/console/launch`, `agent-mcp/el-admin-creds`, `desktop/telemetry-report`).
- **Independent timeline** — does not block Phase 4.
- **Acceptance:** all three transports synthesize a `Principal` of the same shape; middleware (3a) consumes it; one route is converted from ad-hoc auth to principal-driven auth as proof.
- **NOT shipping:** real session auth (Track A); cookie migration.
- **Rollback:** abstraction is additive; existing ad-hoc auth paths stay until per-route conversion.

### Phase 4 — Route migration (after mandatory pre-flight audit)

- **Scope (re-baselined per blocker report):** there are **240 `route.ts` files** in `apps/operator/app/api`. **Only 23 use endpoint-system substrate** today. **~217 are non-substrate** — that's the audit population. The audit will split it across three buckets:
  - **A1-class** — handler does real business logic that doesn't belong in a transport-agnostic tool (the `_hono/agent-chats.ts` shape: 419 lines, transcript persistence, cost caps, feature locks, three rejected relocations). **Stay as shims by precedent.**
  - **Genuinely migratable** — handler is a typed-IO function mapping cleanly onto `define_tool`. Migrate.
  - **Trivial PG-read/return** — could be either; depends on whether it fits the tool model cleanly.
- **Honest estimate:** **ongoing through the calendar year, paced by audit output.** Not 8–12 weeks. The 217 base is roughly 10× what the v1 plan implied; the migratable subset is unknown until audit runs.
- **Audit IS Phase 4's first deliverable** (not a precondition). Audit output: a written table per route → Migrate / A1-exempt / Audit-flagged.
- **Sequencing within Phase 4:** PR batches by route family (oracle, harness, plugins, admin, dev, etc.). Each batch normal-sized; no flag day.
- **Acceptance per batch:** every route in the batch either projects through the endpoint system OR is documented A1-exempt in the audit doc; `tool_invocations.transport` rows visible for migrated ones.
- **NOT shipping:** A1-class routes; pages; static assets.
- **Rollback:** per-batch PR revert.

### Phase 5 — *removed*

`scope: 'global'` (A2) returns to deferred status in `deferred-followups-2026-05-14.md`. No second consumer exists today.

### Phase 6a — Layering scaffold

- **Scope:** tsconfig projects per layer (`core`, `host`, `routes`, `client`) with paths configured; *no* lint enforcement yet. **Net-new structure** — operator currently has a single tsconfig, no project references, only `@/*` path alias. No existing layering to retrofit; no back-imports from libs/packages into `apps/operator` were found.
- **Acceptance:** `tsc --build` resolves cleanly; layer boundaries exist as compile units; docs describe the layers.
- **NOT shipping:** enforcement; no existing code moves.
- **Rollback:** revert tsconfig + remove project references; nothing else changes.

### Phase 6b — Layering enforcement

- **Scope:** ESLint `no-restricted-imports` (or `dependency-cruiser`) rules; build fails on cross-layer violations.
- **Hard prerequisite:** Phase 4 ≥75% complete (routes disentangled, host-specific imports moved into shims).
- **Realistic timeline:** **6–12 months out**, not 8–12 weeks.
- **Acceptance:** `lint` fails on a planted violation; passes on the actual tree.
- **NOT shipping:** any code movement (Phase 4); pages aren't subject to the rules.
- **Rollback:** demote enforcement to warnings; remove rules.

### Phase 7 — Extend `tools/list` to OpenAPI

- **Scope:** add OpenAPI-compatible output to the existing schema-surfacing path (`packages/agent-mcp/src/server.ts`). Generated artifact emitted by a build step.
- **Design spike needed first:** OpenAPI's request/response model doesn't translate trivially to the `events:`-schema-array model — OpenAPI 3.1 supports SSE responses via `text/event-stream` but per-event schemas need a convention. ~30-minute spike on the wire shape before committing.
- **Acceptance:** `npm run build:openapi` produces a valid OpenAPI document; round-trips one example endpoint through a typed client.
- **NOT shipping:** typed-client codegen for consumers (separate decision); regenerating runtime from OpenAPI.
- **Rollback:** remove the build step; endpoint definitions unchanged.

### Phase 8 — Webapp host  ⛔ RETIRED 2026-06-01

> **RETIRED — do not build.** The standalone webapp is retired (CLAUDE.md canon). See `## Now` + D-001. Nothing below is active.

- **Hard prerequisite:** **Track A** complete or substantially complete.
- **Scope:** operator as a network-reachable HTTP server. `PAPERCUSP_BIND_HOST` env already supports this — *transport-level* webapp deployment is trivial. The same client (React + `useSyncQuery` + `dispatchEndpointStream`) connects over HTTP. A **local-first replica is added behind `useSyncQuery`** (the Linear/Obsidian impl) when the webapp ships.
- **Acceptance:** a hosted instance answers requests over HTTPS, gated by Track-A auth; a webapp client connects with the same code as the desktop one; the local-first replica syncs.
- **NOT shipping:** the desktop-release model — that decision is independent.
- **Rollback:** depository on the host; desktop unaffected.

---

## Parallel tracks

### Track A — Auth & multi-tenancy  ⛔ RETIRED 2026-06-01

> **RETIRED — do not build.** This track existed only as the webapp-host prerequisite; the webapp is retired. Genuine user-protection work is governed by `papercusp-user-protection-gate-2026-05-31` / `papercusp-trust-model-2026-05-31`, not here. See `## Now` + D-001.

- **Scope:** real session auth (OAuth / passkeys / TBD); multi-tenant data isolation; row-level security policy; **consolidation of the 8+ scattered loopback-only auth checks** identified in the blocker report.
- **Why parallel:** independent of any transport phase; can start immediately; gates Phase 8.
- **Decisions needed:** identity provider; tenant model (workspace-per-tenant? user-per-tenant?); RLS strategy; platform-issued vs host-issued tokens; data-model migration plan (embedded-PG per-workspace → multi-tenant cloud DB).
- **Owner:** **TBD. Without an owner, this track does not start, and Phase 8 cannot ship.**

### Track B — Pending reversal decisions

- **Open from the banner:** desktop-release model.

---

## Open questions

- **Q1.** Connection-pool bug status — **confirmed live earlier this session via Playwright** (raw `EventSource` hung `readyState=0`; popover stuck "connecting…"), then the 3 shipped fixes mitigated the worst symptoms. Re-confirm on a clean desktop relaunch before opening Phase 1; expect "mostly mitigated, reliability still a concern" — not "all clear."
- **Q2.** Webapp deployment target — multi-tenant SaaS, single-tenant self-hosted, or both? Gates Track A scope.
- **Q3.** Phase 4 audit output — the migratable count is unknown until the audit runs. Audit is itself Phase 4's first deliverable.

---

## Payoff

When this lands: the desktop is the core hosted locally, reached over IPC + (still-existing) loopback HTTP; the webapp is the same core on a server, reached over HTTP, with a local-first replica behind `useSyncQuery`. The client is identical — it only ever calls `useSyncQuery` and `dispatchEndpointStream`. `define_tool` stays the single definition surface throughout, gaining capability (resumability gap-closure, composable middleware, OpenAPI emission), never coupled to a transport.

**Start with Phase 1.** It's small, contained, has all its infrastructure already shipped, needs zero Rust changes, and is the cleanest first proof that the substrate works.

## Decisions

### D-001 — RETIRED: Phase 8 (webapp host) + Track A — the standalone webapp is retired, do not build
Date: 2026-06-01
User direction 2026-06-01: "THE WEBSITE IS RETIRED — I don't want anyone using them." This plan's top-of-body **"Decision reversal banner"** (which claimed to reverse the webapp-retired / loopback-only-auth decisions and re-introduce a webapp host target) is itself REVERSED and dead.

- **Phase 8 (webapp host)** — RETIRED. The standalone webapp is retired per CLAUDE.md; the operator runs only as the desktop content source. Do not build a network-reachable webapp host.
- **Track A (auth & multi-tenancy)** — RETIRED *as a webapp prerequisite*. (Any genuine security/user-protection work is governed by `papercusp-trust-model-2026-05-31` / `papercusp-user-protection-gate-2026-05-31`, NOT by Track A's "real session auth for a public webapp" framing.)
- The body's **"Decision reversal banner"** table is stale: treat "Webapp retired" and "operator auth is loopback-only" as STILL IN FORCE.

Dependency check (grep, 2026-06-01): nothing depends on these surfaces — the only reference is a doc comment in `apps/operator/lib/auth/principal/from-loopback.ts:10`. No build target, no route, no other plan blocks on them. Safe to retire.

STILL LIVE in this plan (host-agnostic-core, webapp-independent): Phase 1 (shipped), Phase 2 (platform adapter), Phase 3a (composable middleware), Phase 3b (principal RFC — internal auth only), Phase 4 (route-migration audit), Phase 6a/6b (layering), Phase 7 (OpenAPI).

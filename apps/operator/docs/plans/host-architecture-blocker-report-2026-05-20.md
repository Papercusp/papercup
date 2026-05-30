---
title: Host architecture — pre-implementation blocker report
slug: host-architecture-blocker-report-2026-05-20
status: shipped
created: 2026-05-20
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** **Date:** 2026-05-20 **Companion to:** `host-architecture-2026-05-20.md` **Purpose:** before coding starts, walk every phase of the plan against the actual codebase and flag what would block, complicate, or change scope. Findings only; the plan should be updated where this report contradicts it.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Host architecture — pre-implementation blocker report

**Date:** 2026-05-20
**Companion to:** `host-architecture-2026-05-20.md`
**Purpose:** before coding starts, walk every phase of the plan against the actual codebase and flag what would block, complicate, or change scope. Findings only; the plan should be updated where this report contradicts it.

---

## Headline findings (read first)

Three findings reshape the plan:

1. **Phase 4 scope is much bigger than the plan implied.** Of 240 `route.ts` files in `apps/operator/app/api`, **only 23 use endpoint-system substrate** (`dispatchProjectedToolStream` / `emitToSseSink` / `sseResponse`). **~217 are non-substrate.** Some will be A1-class shims and stay; some will migrate; the audit determines the split. But the *base of non-substrate routes the audit must classify* is roughly **10× what the plan implied** ("the bespoke surface is small / 23 ad-hoc" from the hallucinated v3 was the wrong direction).
2. **Platform-adapter interface (Phase 2) has two boundaries depending on where "the core" cuts.** `packages/agent-mcp/src` and `libs/sync/src` are **zero `node:fs`/`child_process` imports** — already host-clean at that layer. But `apps/operator/lib/` (where most tool handlers live) has **106 files importing `node:fs` or `node:child_process`**. The interface is small if drawn at the framework boundary; refactoring existing handlers to use it is per-handler work touching up to 106 files.
3. **Hono `app` is not exported.** `apps/operator/app/api/[[...route]]/route.ts` defines `const app = new Hono().basePath('/api')` but only exports the HTTP method handlers (`GET`, `POST`, …). In-process `app.fetch(request)` requires adding `export { app }` (trivial) — or, per Phase 1's recommendation, sticking with loopback-fetch (option 1a) which doesn't need this. Not a blocker, just a constraint on Phase 1's option choice.

Other findings below per phase.

---

## Phase 1 — IPC `sys:http` bridge + EventSource/fetch polyfills

**Status: clean to start.**

- **Hono app dispatch:** the plan's Phase 1 option 1a (loopback-fetch) works as-is. Option 1b (in-process `app.fetch()`) requires exporting `app` from the catch-all route — small, but unnecessary for v1. Recommend sticking with 1a; revisit 1b only if removing the internal loopback port becomes a goal.
- **Cookie-bearing routes:** only **6 routes** import `next/headers` / call `cookies()`. The `sys:http` bridge needs to forward `document.cookie` in headers (or synthesize the operator principal); manageable scope. Auditable individually.
- **fetch polyfill collisions:** grep for libraries that globally patch `fetch` found only **test files** doing it (mock-fetch in vitest tests) — no third-party library at runtime that would fight a desktop-only `window.fetch` patch. Surgical predicate (same-origin `/api/*` only) stays compatible with PostHog / LLM-API / asset traffic.
- **`createResilientEventSource`** already accepts an injectable `eventSourceCtor` (confirmed in `libs/sync/src/client/resilient-event-source.ts`). The polyfill seam exists.
- **IPC infrastructure** (`endpoint_ipc.rs`, `endpoint-ipc/server.ts`, `transport-adapters/`, `PAPERCUSP_IPC_ENABLE=1` wiring in `instrumentation-node.ts`, the `058-tool-invocations-transport` migration) is all live. Phase 1 builds on existing wiring; no new Rust changes.

**Phase 1 plan: unchanged. Ready to implement.**

---

## Phase 2 — Platform-adapter interface

**Status: clean at the framework layer; per-handler refactor work is larger than the plan implied.**

- `packages/agent-mcp/src` and `libs/sync/src` have **zero** `node:fs` or `node:child_process` imports. The host-agnostic framework boundary is already enforced *by convention* there — formalizing the platform-adapter interface against this layer is a one-PR change with a small interface surface.
- `apps/operator/lib/` has **106 files** that import `node:fs` or `node:child_process` (samples: `omp-sessions.ts`, `embedded-pg-discovery.ts`, `auth-audit.ts`, `operator-notes.ts`, `plugin-api-mount.ts`, `workspace-registry.ts`). Many of these live under `lib/agent-tools/...` — i.e., **tool handler implementations**. If "the core" includes tool handlers (and architecturally it should), then making the core fully host-agnostic means refactoring these to call through the adapter — touchpoint count up to 106.

**Plan update needed:** Phase 2 ships the *interface + desktop impl + one consumer to prove the shape* — that's the small PR. But the **broader migration of the 106 files onto the adapter is a tail that runs in parallel with Phase 4** (and through similar audit discipline — many `node:fs` reads are genuinely platform-specific, but some are gratuitous and can move). Flag this in the plan as: "Phase 2 = define + prove; ongoing migration = parallel hygiene, gated only on the interface existing."

---

## Phase 3a — Extract dispatcher middleware (composable stack)

**Status: refactor is tractable; size honest.**

- `packages/agent-mcp/src/dispatch-projected.ts` is **702 lines**. Single file. Top-level shape: `computeProjectedQuotaWindowKey`, error types, `DispatchProjectedDeps` interface (with `recordInvocation` as a callback), `dispatchProjectedTool` (~450 lines of the file), `DispatchStreamEvent`, `dispatchProjectedToolStream`.
- The middleware concerns (gating, quota window, idle timer, abort, telemetry, HMAC verification) are *already* surfaced through the `DispatchProjectedDeps` interface — they're injectable, just not composable as an ordered stack. This is a "make existing seams composable + ordered + replaceable" refactor, exactly as the plan says.
- **No structural blocker.** The refactor scope is one file + its tests. Risk is medium because the file is hot (every projected tool dispatch goes through it) — comprehensive test coverage matters. Need to verify test surface as part of P3a kickoff.

**Phase 3a plan: unchanged. Ready to implement after a test-surface audit.**

---

## Phase 3b — Principal RFC + implementation

**Not a code blocker; design-review work.**

- No codebase fact materially changes the plan.
- One observation that informs the RFC: **loopback-only auth is enforced per-route, not centrally** — at least 8+ routes have their own loopback-checking (`auth/me`, `auth/logout`, `auth/change-password`, `mobile/qr.svg`, `dev/processes/kill`, `agent-mcp/console/launch`, `agent-mcp/el-admin-creds`, `desktop/telemetry-report`, ...). The principal abstraction will need a clear deprecation path for those scattered checks. Track A inherits this consolidation.

---

## Phase 4 — Route migration

**Status: scope materially larger than the plan implied. Plan update required.**

- **240 `route.ts` files** in `apps/operator/app/api`.
- **23 use endpoint-system substrate** today. That's the population the plan's "already-substrate" framing fits.
- **~217 are non-substrate** — the audit population. The hallucinated v3's "23 ad-hoc + 134 substrate + 10 shims" was *inverted*; the substrate count is the *small* one.
- Of the 217 non-substrate, the population will split into roughly three buckets (audit confirms exact numbers):
  - **A1-class** — handler does real business logic that doesn't belong in a transport-agnostic tool (cookies + cost-caps + transcript persistence + feature locks; the `_hono/agent-chats.ts` shape). These **stay as shims** by A1 precedent.
  - **Genuinely migratable** — handler is a typed-IO function that maps cleanly onto `define_tool`. Migrate.
  - **Trivial PG-read/return** — could be either a tool or stay a shim; depends on whether it fits the tool model cleanly.
- **Plan update needed:** Phase 4's framing should be "audit 217 non-substrate routes, expected outcome a mix across A1/migratable/trivial buckets. Migratable count is well under 217." The estimate `8–12 weeks of PR batches` in the prior plan version is probably an *under*estimate against this real population; recommend re-baselining to "ongoing through the calendar year, paced by audit output."
- **The audit itself is the gating deliverable** — Phase 4 cannot move into migration PRs until the audit is at least partially complete. Frame the audit as Phase 4's first deliverable, not a prerequisite.

---

## Phase 5 — *removed*

No code work. Confirms the deletion from the plan: I scanned `state:`-shaped tool definitions; no second `scope: 'global'` consumer exists today. Returns to deferred status correctly.

---

## Phase 6a — Layering scaffold (tsconfig projects)

**Status: net-new structure; no existing layering to retrofit.**

- `apps/operator/tsconfig.json` has **no `references`** (no project references today), only path alias `@/*`. Single compilation unit.
- `libs/` and `packages/` exist but aren't wired as TS project references from the operator.
- **No back-imports** from libs/packages into `apps/operator` were found (the back-imports in `libs/papercusp/apps/web` are inside the parallel Rust-port submodule's own `apps/web`, not into the live operator).
- This means Phase 6a is **green-field** — no existing structure fights the layering work. The cost is design (where do the boundaries cut) + writing the references + updating build scripts. Not a refactor; an addition.

**Phase 6a plan: unchanged.** Phase 6b's "6–12 months out" estimate stands — gated on Phase 4 having moved most cross-layer imports out of route handlers.

---

## Phase 6b — Layering enforcement

**No code-side finding changes the timeline.** Honest estimate stands.

---

## Phase 7 — Extend `tools/list` to OpenAPI

**Status: implementation surface is in one place; clean.**

- `tools/list` is implemented in `packages/agent-mcp/src/server.ts` (the MCP server) and surfaces TSDoc descriptions + per-event JSON Schemas (`types.ts:141`, `types.ts:232`, `tool-projection.ts:15`).
- The Zod schemas are already there; producing OpenAPI from them needs a Zod-to-OpenAPI converter (off the shelf — `@asteasolutions/zod-to-openapi`, `zod-openapi`, or similar). Pure addition; no existing structure resists.
- One real consideration: the `events:`-schema-array model doesn't translate trivially to OpenAPI's request/response model — OpenAPI 3.1 supports SSE responses via `text/event-stream` content type but per-event schemas need a convention. Worth a 30-minute spike on the wire shape before committing the extension; not a blocker, just design.

**Phase 7 plan: unchanged.**

---

## Phase 8 — Webapp host

**Status: gated by Track A (as plan says); some code-side prep observable.**

- The Next.js sidecar already supports network-reachable binding (`PAPERCUSP_BIND_HOST` env). So the *transport-level* "webapp host" is essentially "deploy the same Next app to a server with `PAPERCUSP_BIND_HOST=0.0.0.0`" — that part is real and small.
- The blockers, as the plan says, are auth (Track A) + multi-tenancy. Code findings that inform Track A:
  - **Auth is decentralized today** — at least 8 routes do loopback-only checks individually. Multi-tenant auth needs to consolidate these into middleware (which composable-middleware Phase 3a enables).
  - **Data model assumes single-user single-workspace** — embedded-PG discovery (`embedded-pg-discovery.ts`) finds *the* workspace's DB. Multi-tenancy requires per-tenant DB or RLS-partitioned single-DB. Big data-model decision; named in plan; not litigated here.

**Phase 8 plan: unchanged.** Track A is correctly identified as the gate.

---

## Cross-cutting blockers / observations

### `libs/papercusp` is a parallel rust-port submodule with its own `apps/`

It contains `apps/web/` (a separate Next app) and `apps/desktop/` (the older shell I mistakenly looked at last session). It has its own back-imports and shape. **None of these affect the operator** — the operator at `apps/operator` is the live target — but the existence of the submodule means greps need to be path-scoped to `apps/operator`, `packages`, and the live `libs/` (not `libs/papercusp/*`). Layering work (Phase 6) should be scoped to exclude the rust-port submodule; it follows its own discipline.

### IPC infrastructure is complete; Phase 1 builds on existing wiring

`endpoint-ipc/server.ts`, `endpoint_ipc.rs` (in `papercusp-desktop` repo), the protocol, the Rust handshake, the `transport-adapters` picker, the `tool_invocations.transport` column — all live. Phase 1 doesn't introduce IPC; it extends the existing IPC surface with `sys:http`. **Zero Rust changes required** for Phases 1–7. Only Phase 8 (if a webapp host needs IPC, which it shouldn't) or a future "kill the loopback port" cleanup touches Rust.

### The 3 fixes already shipped this session reduce Phase 1's urgency

`21e5c1b3` (SSE transport + dedup) + `1b2ee83` (rest-query batching, libs/sync) make the current pre-Phase-1 desktop *tolerable* even without IPC — the popover works most of the time. Phase 1 is still correct and necessary for reliability, but it's no longer "the live bug is unfixed" — the live bug is *mostly* fixed. Update Phase 1's framing: it's the *reliability* fix and the *foundation* for the rest of the plan, not the firefighting motivator.

---

## Updates the plan needs based on this report

1. **Phase 4:** invert the framing — *most* routes are non-substrate (~217), not the other way around. Audit population is large. Time estimate increases; "ongoing through the calendar year" is honest.
2. **Phase 2:** add an explicit "ongoing parallel migration" sub-stream for the 106 `apps/operator/lib/` files using `node:fs`/`spawn`. Interface itself is still a one-PR scope; the migration tail is open-ended.
3. **Phase 1:** reframe motivator — the connection-pool bug's worst symptoms are already mitigated by the three fixes shipped earlier this session. Phase 1 is now reliability + foundation, not emergency. Still recommended order #1, but honesty about urgency.
4. **Track A / Phase 3b / Phase 8:** the auth surface is more decentralized than the plan implied (8+ scattered loopback checks). Consolidating these is meaningful work that lands between Phase 3a (which provides the middleware framework) and Phase 8 (which needs real auth).
5. **Scope note:** all work is scoped to `apps/operator`, `packages/`, and the live `libs/` (NOT `libs/papercusp/*`, which is the parallel rust-port submodule and follows its own discipline).

---

## Net assessment

Plan structure is sound. No phase has a structural blocker. Phase 4 needs honest re-baselining (10× the audit population) and Phase 2 needs explicit acknowledgement of the per-handler migration tail. Phase 1 has the smoothest path — its infrastructure is mostly already there. The honest critical path is Phase 4's audit + Track A, exactly as the DAG in the plan says.

Recommend: apply the 5 plan updates above, then proceed in the planned order. Phase 1 can start any time.

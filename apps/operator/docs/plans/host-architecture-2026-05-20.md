# Host architecture — high-level plan

**Date:** 2026-05-20
**Status:** Proposal — awaiting review (high-level; low-level codebase-grounded plan follows once this is settled).
**Builds on:** `desktop-ipc-transport-completion-2026-05-20.md` (Phase 1 detail), `deferred-followups-2026-05-14.md` (A1 exemption, A2 status).

---

## Decision reversal banner

Future sessions: this plan **reverses** prior memorialized decisions. Read here before acting on stale memory.

| Prior decision | Source | Status under this plan |
|---|---|---|
| "Webapp retired; Tauri dev is the only test path." | `feedback_webapp_retired_use_tauri_dev.md` (2026-05-14) | **Reversed.** Self-hosted/webapp is a target host again. |
| "Webapp is test-only." | `project_papercup_deployment_model.md` | **Reversed.** Same as above. |
| "Operator auth is loopback-only." | `project_operator_auth_loopback.md` | **Reversed in principle; design TBD.** Real auth is required before Phase 8 ships. Tracked as Track A. |
| "Desktop releases are local; no GitHub Actions." | `reference_desktop_releases_local.md` | **Not yet decided.** A self-hosted webapp deployment may or may not change this; flag, don't decide here. |

---

## Target shape

**papercusp = one host-agnostic client + one host-agnostic core + a thin platform adapter + a swappable transport projection between them.**

- **Client** — React UI. Reaches the core through exactly two seams: `useSyncQuery` (data/reads) and `dispatchEndpointStream` (imperative/actions). Identical on desktop and webapp; the seams' implementations swap by host.
- **Core** — the endpoint system (`define_tool` handlers) + orchestration logic. Cannot import from `next/*`, Tauri, or Node fs; takes typed inputs, returns typed outputs/events.
- **Platform adapter** — the ~10% that genuinely is host-specific: fs, process spawning, embedded-PG location, sockets. One interface, with a desktop impl and a server impl.
- **Transport projection** — carries both seams' traffic between client and core: IPC + loopback HTTP on desktop today (boundary shifts as routes consolidate); HTTP on the webapp.

The desktop app isn't special — it's "the general architecture, hosted locally." The webapp is the *same client* + the *same core* hosted on a server. Linear/Obsidian model: a deploy, not a fork.

---

## Cross-phase dependency DAG

Plan structure is a graph, not a sequence. Edges below.

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

Critical path is Track A and Phase 4. Everything else parallelizes against those two.

---

## Procedural disciplines — apply to every phase

These are framework rules, not phase content. They apply universally.

1. **Pre-flight audit per route before migration.** The agent-chats lesson at scale: classify each candidate against four axes — (a) does the handler hold non-transport state? (b) is there pre/post handler work that doesn't belong in a transport-agnostic tool? (c) does it touch cookies/cost-caps/feature-locks? (d) is its wire contract stable? Any "yes" → A1-class, leave as a shim. The migrate-count is a ceiling, not a target.
2. **Per-phase, machine-greppable acceptance.** Every phase ships when a bash one-liner proves it. "Looks clean" is not shipped.
3. **Per-phase NOT-shipping line.** Explicit non-scope per phase. Prevents creep.
4. **Reversals of memory'd decisions list all downstream reversals.** The banner at the top of this doc is the canonical example; every plan that reverses memory does the same.
5. **No elevation of deferred items without a concrete second consumer.** If a deferred-followups entry says "trigger to revisit: a second consumer," then *naming the consumer* is the cost of elevation. (Phase 5 in the prior plan was deleted under this rule.)
6. **Per-phase rollback.** Every phase has a concrete rollback strategy in writing, not aspirational ("revert the PR" only counts when the PR is well-scoped).

---

## Ideas to borrow

**1. Build-enforced layering** *(VS Code)* — core logic physically cannot import host APIs; the build fails if it does. **Honest cost:** this is a multi-week TS-monorepo refactor (tsconfig projects per layer + ESLint `no-restricted-imports` / dependency-cruiser rules + untangling existing `next/*`/`tauri/*`/`fs` imports across the core). It is **tightly coupled to Phase 4** — routes can't move into the host-agnostic core until they're disentangled. Split into Phase 6a (scaffold, no enforcement) + Phase 6b (enforcement, long-arc).

**2. Platform-adapter interface** *(VS Code services + Obsidian vault adapter)* — host-specific 10% (fs, spawn, PG location) behind one small interface; desktop impl and server impl. Names what can't be host-neutral. Small enough to ship in one PR before enforcement.

**3. Transport as pure projection + composable client-side picker** *(your endpoint system + tRPC/oRPC "links")* — formalize `transport-adapters` into a composable link chain. Makes "desktop = IPC, webapp = HTTP" config, not code fork.

**4. Close subscription/resumability gaps in the existing endpoint surface** *(reframed; was "new endpoint kind")* — the endpoint system already has `events:` declarations, `state:` + `ctx.publishState`, `replayBufferSize` + Last-Event-ID resume (`2c06c8f7` PR #73). The work is **gap-closure** on the existing primitives so the sync/log/popover stream routes can enter the system, not introducing a new "kind."

**5. Extract + expose the existing middleware stack** *(reframed; was "build composable middleware")* — the dispatcher already does telemetry / quota / capability gating / idle-timeout / HMAC signed-URL verification in-place. The work is making them **composable + ordered + replaceable**, not inventing them. Splits into Phase 3a (extract, pure refactor) and Phase 3b (principal RFC, design-review gated).

**6. Decouple the core from the Next runtime** *(WinterCG portable-handler / VS Code one-core-many-targets)* — the core does not import `next/*`. Next is **one host of the HTTP projection**, not the framework everything is welded to. **Decouple ≠ drop:** Next keeps hosting the routes on desktop and (potentially) the webapp; the work is pulling `next/*` references out of *handler logic* into the *route shims* that adapt Next's request/response to the handler.

**7. Two seams, both host-swappable** *(VS Code service-swap; Linear/Obsidian as the deferred webapp impl)* — `useSyncQuery` (data) and `dispatchEndpointStream` (imperative) are the seams. *Today on desktop:* request/response behind both seams. *Webapp era:* local-first replica added as a new impl behind `useSyncQuery` (the Linear/Obsidian model). Components don't change. Corollary: `rest-query` belongs to the data seam, not the endpoint system — don't blur reads into the imperative layer.

**8. Extend `tools/list` to be OpenAPI-shaped** *(reframed; smaller delta)* — `tools/list` already surfaces event JSON-schemas (Phase-3 work). The work is extending its payload to be OpenAPI-compatible, not building a new contract dump.

---

## Non-borrows (settled — don't re-litigate)

- **No protobuf / ConnectRPC as the definition layer** — no local perf gain, loses Zod, `define_tool` decided.
- **No Figma-style WASM core** — papercusp's backend is I/O orchestration, not computation.
- **No tRPC/oRPC wholesale adoption** — borrow link + middleware patterns; keep `define_tool`.
- **No local-first/Zero on the desktop** — redundant when the server is local; it's a webapp-era addition behind `useSyncQuery`.
- **No big-bang rewrite.**
- **No "drop Next."** Decouple, don't remove. 245 route files + 63 pages + 800+ `next/*` imports make replacement a multi-month undertaking with no driver.

---

## Phases

### Phase 1 — IPC `sys:http` bridge + EventSource/fetch polyfills

- **Scope:** drafted in `desktop-ipc-transport-completion-2026-05-20.md` (Phases 0–3 of that doc). The `sys:http` pseudo-tool + the EventSource/fetch polyfills.
- **Why now:** **the connection-pool bug is live** (reproduced this session via Playwright — raw `EventSource` hung `readyState=0`; popover stuck "connecting…"). The `cross-origin-url.ts` sibling-host shard is a partial mitigation, not a fix; this phase reverts it.
- **IPC framing reality:** IPC carries the 6 allowlisted endpoint-system tools today + (after this phase) the polyfill-routed fetch/SSE. Everything else stays loopback HTTP. The boundary shifts as routes consolidate (Phase 4) — IPC is not yet "the substrate."
- **Acceptance:** `ss -tnp` from the running webview shows ≤ 2 ESTAB HTTP connections at rest (down from 6–7); the live-thinking popover connects in well under a second, repeatably, after a cold relaunch.
- **NOT shipping:** no per-route migration; no Rust changes; no custom protocol (that's Phase 4 of the IPC doc, deferred).
- **Rollback:** `NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT=1` skips the polyfill install; the cross-origin shard can be re-applied if needed.

### Phase 2 — Platform-adapter interface

- **Scope:** one interface (`HostPlatform` or similar) for fs, spawn, embedded-PG URL, socket dir. Desktop implementation; a stub server implementation that throws (to be filled by Phase 8).
- **Acceptance:** `grep -r "node:fs\|child_process.spawn" packages/agent-mcp/src libs/sync/src libs/endpoint-system/src 2>&1 | wc -l` returns 0 *after* the interface is consumed by at least one tool's handler.
- **NOT shipping:** mass-migration of existing code onto the adapter — only the interface + the desktop impl + one consumer to prove the shape.
- **Rollback:** revert is a single-PR revert; the interface has zero existing consumers before this phase.

### Phase 3a — Extract dispatcher middleware to a composable stack

- **Scope:** `dispatch-projected.ts`'s existing in-place gating/quota/telemetry/idle/HMAC become ordered, named, replaceable middleware. Wire format identical; behavior identical.
- **Acceptance:** existing dispatcher tests pass without change; new test enumerates the middleware stack in order.
- **NOT shipping:** principal abstraction (that's 3b); new middleware (that's per-feature later).
- **Rollback:** revert; middleware definitions are additive over the existing dispatcher.

### Phase 3b — Principal RFC + implementation

- **Scope:** unified `Principal` abstraction across HTTP (loopback / future webapp session), MCP (signed URL), and IPC (synthesized operator). Design-review gated.
- **Decisions needed before coding:** is the principal host-issued or platform-issued? How does mobile-JWT (memory: `feedback_mobile_targets_hono.md`) fit?
- **Independent timeline** — does not block Phase 4.
- **Acceptance:** all three transports synthesize a `Principal` of the same shape; middleware (3a) consumes it; one route is converted from ad-hoc auth to principal-driven auth as proof.
- **NOT shipping:** real session auth (that's Track A); cookie migration.
- **Rollback:** the abstraction is additive; existing ad-hoc auth paths stay until the route is converted.

### Phase 4 — Route migration (after mandatory pre-flight audit)

- **Scope:** there are **245 standalone `route.ts` files** in `apps/operator/app`. Some are already host-agnostic shims over `dispatchProjectedToolStream` — those don't migrate, they already conform. Some are A1-class (real business logic in the route layer) — those **stay as shims by design**. The remainder are migration candidates.
- **Mandatory pre-flight audit before any migration PR:** classify each candidate against the four axes (see Procedural Discipline #1). Output: a written audit table per route → Migrate / A1-exempt / Audit-flagged. **The migratable count is unknown until the audit completes** — anything is at best a ceiling.
- **A1 exemption is by precedent:** `_hono/agent-chats.ts` (419 lines, three rejected relocations, transcript persistence + cost caps + feature locks) is the canonical A1 case. Routes matching that shape exempt themselves.
- **Sequencing within Phase 4:** PR batches by route family (oracle, harness, plugins, admin, dev, etc.) — each batch is a normal-sized PR; no flag day.
- **Acceptance per batch:** every route in the batch either projects through the endpoint system OR is documented A1-exempt in the audit doc; `tool_invocations.transport` rows visible for the migrated ones.
- **NOT shipping:** A1-class routes (oracle:chat shim, agent_chats:chat shim, anything matching that shape); pages; static assets.
- **Rollback:** per-batch PR revert.

### Phase 5 — *removed*

`scope: 'global'` (A2) returns to deferred status in `deferred-followups-2026-05-14.md`. No second consumer exists today. **Trigger to revisit:** a second singleton-shaped tool appears that genuinely needs the pattern.

### Phase 6a — Layering scaffold

- **Scope:** tsconfig projects per layer (`core`, `host`, `routes`, `client`) with paths configured; *no* lint enforcement yet. Sets up the structure so future work can land in the right place.
- **Acceptance:** `tsc --build` resolves cleanly; the layer boundaries exist as compile units; documentation in the doc-site describes the layers.
- **NOT shipping:** enforcement; no existing code moves yet.
- **Rollback:** revert tsconfig + remove the project references; nothing else changes.

### Phase 6b — Layering enforcement

- **Scope:** ESLint `no-restricted-imports` (or `dependency-cruiser`) rules; build fails on cross-layer violations.
- **Hard prerequisite:** Phase 4 must be ≥75% complete (routes disentangled, host-specific imports moved into shims).
- **Realistic timeline:** **6–12 months out**, not 8–12 weeks. Honest cliff.
- **Acceptance:** `lint` fails on a planted violation; passes on the actual tree.
- **NOT shipping:** any code movement (that's Phase 4); pages aren't subject to the rules.
- **Rollback:** demote enforcement to warnings; remove rules.

### Phase 7 — Extend `tools/list` to OpenAPI

- **Scope:** add OpenAPI-compatible output to the existing schema-surfacing path. Generated artifact emitted by a build step.
- **Acceptance:** `npm run build:openapi` produces a valid OpenAPI document validated by a standard linter; the document round-trips one example endpoint through a typed client.
- **NOT shipping:** typed-client codegen for consumers (separate decision); regenerating the runtime from the OpenAPI doc.
- **Rollback:** remove the build step; the endpoint definitions are unchanged.

### Phase 8 — Webapp host

- **Hard prerequisite:** **Track A** (auth + multi-tenancy) complete or substantially complete.
- **Scope:** the operator as a network-reachable HTTP server (probably `next start` deployed; possibly a bare host if Phase 6b is also done). The same client (React + `useSyncQuery` + `dispatchEndpointStream`), connecting over HTTP. A local-first replica is added behind `useSyncQuery` (the Linear/Obsidian impl) when the webapp ships.
- **Acceptance:** a hosted instance of the operator answers requests over HTTPS, gated by Track-A auth; a webapp client connects with the same code as the desktop one; the local-first replica syncs.
- **NOT shipping:** the desktop-release model — that decision is independent.
- **Rollback:** depository on the host; the desktop is unaffected.

---

## Parallel tracks

### Track A — Auth & multi-tenancy

- **Scope:** real session auth (OAuth / passkeys / TBD); multi-tenant data isolation; row-level security policy.
- **Why parallel:** independent of any transport phase; can start immediately; gates Phase 8.
- **Decisions needed:** identity provider; tenant model (workspace-per-tenant? user-per-tenant?); RLS strategy; platform-issued vs host-issued tokens.
- **Owner:** TBD. **Without an owner this track does not start, and Phase 8 cannot ship.**

### Track B — Pending reversal decisions

- **Open from the banner:** desktop-release model (Track-A may or may not change it).
- This isn't engineering work; it's a decision to record before Phase 8 closes.

---

## Open questions (gate the relevant phases)

- **Q1.** Connection-pool bug status — verified live this session, but `c718d501`'s cross-origin shard is in place. Re-confirm on a clean desktop relaunch before opening Phase 1. *(Confirmed live in my own testing — flagged as fresh-confirm only.)*
- **Q2.** Webapp deployment target shape — multi-tenant SaaS, single-tenant self-hosted, or both? Decides Track-A scope.
- **Q3.** Phase 4 route audit output — until the audit runs, the migratable count is unknown. Audit is itself a Phase 4 deliverable, not a precondition.

---

## Payoff

When this lands: the desktop is the core hosted locally, reached over IPC + the still-existing loopback HTTP; the webapp is the same core on a server, reached over HTTP, with a local-first replica behind `useSyncQuery`. The client is identical — it only ever calls `useSyncQuery` and `dispatchEndpointStream`. `define_tool` stays the single definition surface throughout, gaining capability (resumability gap-closure, composable middleware, OpenAPI emission), never coupled to a transport.

Review and tell me which phases to keep, defer, split further, or cut. When this is settled, the low-level codebase-grounded plan follows.

---
title: Endpoint follow-ups — finish _hono elimination + auth-tightening
slug: endpoint-hono-elimination-2026-05-21
status: active
created: 2026-05-21
updated: 2026-05-21
owner: pandawamble@gmail.com
companion-to: [endpoint-unification-2026-05-21, endpoint-route-migration-2026-05-20, host-architecture-2026-05-20-v2]
---

## Now

**State:** The `endpoint-unification-2026-05-21` arc shipped E1–E6 (the `defineRoute`→`defineTool` collapse + the full mobile flag) plus E7-docs, E10, E11, and E13-partial (`coord` + `su-locks` migrated off `_hono`). Its tail — E8/E9/E12/E13-plugins/E14 — was found to be two genuinely separate projects, too large and too risky to fold into that arc. **This plan is that tail, re-scoped from audit.**

**Next:** A2 — migrate the mid routers (`experts` 17, `pty` 10, `agent-chats` ~7). `pty`'s WebSocket upgrade and `agent-chats`'s SSE need the care noted in §A2.

A1 shipped (`c019a0ff`): the five small routers — `operator-notes` (2), `oracle` (3), `dock-layouts` (6), `cross-harness` (5), `projects` (6) — migrated to `defineRoute`; the 5 `_hono` files + their `register*()` calls deleted; `getSpawnableTemplates` relocated to `lib/spawnable-templates.ts`; the oracle-chat test block migrated to `endpoint-route/__tests__/oracle-chat.test.ts`.

# Endpoint follow-ups — finish `_hono` elimination + auth-tightening

## 1. Why this is a separate plan

The unification arc's remaining phases were sized wrong in the original plan:

- "E12 — migrate `_hono/harness.ts`, 135 routes" was only **one** of ten legacy routers. Audit (2026-05-21) found **~199 routes across 10 `_hono` routers** still un-migrated.
- "E9 — auth-tightening, ~30–50 routes" is actually **229 routes today** (every migrated route landed `auth: 'public'`), growing to **~430** once Workstream A migrates the remaining 199.

These are not "continue the arc" items. They are two real projects with different risk profiles — a mechanical-but-large migration, and a security pass requiring per-route judgement. This plan scopes both, plus the leftover `_hono/` deletion and the enforcement lint rule.

## 2. The two workstreams

| | Workstream A — `_hono` elimination | Workstream B — auth-tightening |
|---|---|---|
| **What** | Migrate the 10 remaining `_hono/*` routers (~199 routes) to `defineRoute`; delete `_hono/`; land the `no-raw-route-handlers` lint | Convert every `auth: 'public'` route to an explicit `PrincipalRequirements` posture (or confirm it's genuinely public) |
| **Risk** | Low–medium per route — mechanical port, posture preserved, wire-compatible URLs | **Security-sensitive** — a wrong gate is fail-open (hole) or fail-closed (broken caller) |
| **Verification** | Route serves identically via Hono in-process `app.request()`; `tsc` clean; suites green | Per-route: the intended caller still works AND an unprivileged caller is rejected |
| **Size** | ~199 routes, 10 routers, ~12 batches | ~430 routes, family batches |

**Sequencing: A fully, then B.** Tightening auth on a route that is about to be re-migrated is wasted work. B0 (the audit/categorization — pure analysis, no code) MAY start concurrently; B's conversions wait for A.

E8 (`expose.ipc` for routes) stays **deferred** — the flag is typed but inert and has no consumer. Out of scope here; revisit when a route-over-IPC driver appears.

---

## Workstream A — `_hono` elimination

### Inventory (verified 2026-05-21)

| Router | Routes | LOC | Mounted via | Notes |
|---|---|---|---|---|
| `oracle.ts` | 3 | 146 | `registerOracle(app)` | also exports prompt helpers — keep those |
| `operator-notes.ts` | 2 | 42 | `registerOperatorNotes(harness)` | trivial |
| `dock-layouts.ts` | 6 | 124 | `registerDockLayouts(app)` | — |
| `cross-harness.ts` | 5 | 289 | `registerCrossHarness(harness)` | imported by `routes/marketplace/spawnable.ts` — check exports |
| `projects.ts` | 6 | 203 | `registerProjects(harness)` | — |
| `experts.ts` | 17 | 969 | `registerExperts(harness)` | exports `experts-data` helpers — keep |
| `pty.ts` | 10 | 835 | `registerPty(harness)` | **WS** terminal upgrade — see A2 caveat |
| `agent-chats.ts` | ~5–9 | 437 | `registerAgentChats(harness)` | **SSE** chat streaming |
| `plugins.ts` | 7 | 576 | `app.route('/plugins', plugins)` | **`installPluginApiDispatcher` mutates the sub-app** — see A3 |
| `harness.ts` | 138 | 7418 | `app.route('/harness', harness)` | the big one — see A4; also exports many non-route helpers |
| `bootstrap.ts` | 0 | 112 | `runBootstrap()` | startup hooks — **stays** (not a router) |
| `harness-paths.ts` | 0 | 79 | imported as a lib | helper — **stays / moves to `lib/`** |

**Total route surface: ~199 across 10 routers.**

### A1 — Small routers (oracle, operator-notes, dock-layouts, cross-harness, projects) — ~22 routes — ✅ SHIPPED `c019a0ff`

- ✅ One `routes/<family>/index.ts` module per router (array-export). 22 routes across 5 files.
- ✅ Auth posture preserved verbatim — all `auth: 'public'` (the legacy routers gated none). The `oracle` FLAGS.ORACLE 404-gate middleware became a per-handler `oracleEnabled()` check (`defineRoute` has no per-prefix middleware).
- ✅ 5 `_hono/*.ts` deleted + 5 `register*()` calls removed from `_hono/app.ts`.
- ✅ **Export check done:** `cross-harness.ts`'s `getSpawnableTemplates` (imported by `routes/marketplace/spawnable.ts`) relocated to `lib/spawnable-templates.ts`; importer repointed. `oracle`'s prompt helpers were already in `lib/agent-tools/oracle/prompts.ts` — no move needed.
- ✅ The `/oracle/chat` test block of `_hono/chat-shim-routes.test.ts` migrated to `endpoint-route/__tests__/oracle-chat.test.ts` (4 tests — round-10 close guard, 400-no-messages, 404-flag-off, UUID-runId).
- ✅ Verified: tsc clean; route-shadowing + composed-app green; oracle-chat 4/4; chat-shim (trimmed) 3/3.

### A2 — Mid routers (experts 17, pty 10, agent-chats ~7) — ~34 routes

- `experts.ts` — straightforward HTTP; keep `experts-data` exports.
- **`agent-chats.ts`** — SSE chat streaming. SSE is fine as a `defineRoute` (the handler returns a streaming `Response`; the mobile log-stream route already proves this). Port directly.
- **`pty.ts` caveat** — the terminal **WebSocket upgrade** is NOT a `defineRoute` (defineRoute is request→response + SSE, not WS). `pty.ts` is mounted by `registerPty` and the WS upgrade is bound by a separate `ws` server. Only `pty.ts`'s **HTTP control routes** (session list, resize, etc.) migrate to `defineRoute`; the WS upgrade handler stays on its own seam (document where). Audit `pty.ts` first to split control-routes from the WS handler.
- Acceptance: as A1, plus an SSE smoke test for `agent-chats` and a WS-still-connects check for pty.

### A3 — `plugins.ts` (7 routes) + relocate the plugin-API dispatcher

- `plugins.ts` is **not** a plain bundle: `installPluginApiDispatcher(plugins)` mutates the `plugins` Hono sub-app at boot to add a **dynamic, runtime-populated** catch-all for plugin-supplied API routes.
- Step 1 — relocate the dispatcher: the dynamic plugin-API catch-all becomes its own `defineRoute` catch-all (`/plugins/*`, phase-2 registration) that consults the same in-memory plugin-route registry. This is the real work of A3.
- Step 2 — migrate the 7 static `plugins.*` routes to `defineRoute`.
- Step 3 — delete `plugins.ts` + `app.route('/plugins', plugins)`.
- Acceptance: a plugin-supplied API route still resolves through the relocated catch-all; the 7 static routes serve identically.

### A4 — `harness.ts` (138 routes) — the big one

- ~18 batches of ≤8 routes. Each batch: one commit, explicit pathspecs, per-batch `app.request()` parity check.
- Group batches by URL family (`/harness/:slug/status`, `/harness/:slug/phases/*`, `/harness/:slug/log/*`, …) so a reviewer sees coherent diffs.
- **`harness.ts` exports ~a dozen non-route helpers** (`getHarnessStatusFull`, `resolvePhasedProject`, `harnessDir`, `phasePhaseLabel`-adjacent, …) imported across the app — including by the already-migrated `routes/mobile/harnesses.ts`. These **must survive**: move them to `lib/harness-core.ts` (or similar) as the first batch of A4, repoint importers, *then* migrate routes. `harness.ts` is only deleted once both its routes and its helpers are gone.
- Auth posture preserved verbatim per batch.
- Acceptance: per batch — routes serve identically, `tsc` clean, endpoint-route suite green; the `harness` UI smoke-tested at the end of A4.

### A5 — Orphan triage

- `bootstrap.ts` — 0 routes, the host startup hook (`runBootstrap`). **Keep.** Optionally move to `bin/` since it's host-layer, not API-layer.
- `harness-paths.ts` — 0 routes, a path helper imported by `role-registry`/`expert-dispatcher`/etc. **Keep**; move to `lib/` (it is not `_hono`-specific).
- Confirm no other `_hono/*.ts` file has un-migrated routes after A1–A4.

### A6 — Delete `_hono/`

- After A1–A5, the only files left in `_hono/` are `app.ts` (the Hono app instance + `cors`/`compress` middleware — the host seam) and possibly `bootstrap.ts`.
- Move `app.ts` to a host-appropriate home (`bin/` or a `host/` dir) and delete the now-empty `_hono/` directory. Rename references.
- Acceptance: zero `_hono/` imports outside the relocated `app.ts`; `composed-app-shadowing` test green.

### A7 — `no-raw-route-handlers` ESLint rule

- A custom ESLint rule rejecting raw `app.get/.post/.put/...` and `new Hono()` route registration outside the relocated host seam — the regression guard that keeps routes on `defineRoute`.
- Can only land **after** A1–A6 (until then the rule would fail lint across `_hono/`).
- Acceptance: `eslint` clean; a deliberate raw `app.get` in a test fixture trips the rule.

---

## Workstream B — auth-tightening

### B0 — Audit + categorize (pure analysis — may start anytime)

Every `auth: 'public'` route (229 today, ~430 after Workstream A) is classified into exactly one bucket:

| Bucket | Target posture | Examples |
|---|---|---|
| **genuinely public** | stays `auth: 'public'` | OAuth callbacks (`oauth/*`), `flags/webhook`, `mobile/pair`, `mobile/desktop/mint-pair-token`, `mobile/rest-query`, `mobile/qr.svg` |
| **loopback-tier** | `auth: { trust: ['trusted','verified','unverified-loopback'] }` | desktop-local operator routes — the bulk |
| **verified-user** | `auth: { kind: ['user'], trust: ['verified'] }` | routes that must have a real session |
| **agent/system** | `auth: { kind: ['system','pi'] }` | agent-bearer-only routes |
| **mobile** | `auth: { kind: ['mobile'] }` + `mobile: true` | already done in the unification arc |

Output: a categorization table committed into this plan, and a stub `auth-posture.test.ts` enumerating every route with its bucket + rationale.

### B1…Bn — Convert in family batches

- ~10 routes per batch, one commit each.
- The 29 routes with an **inline** auth check are the priority first batches — there `auth: 'public'` is actively misleading; the conversion just makes the existing in-handler gate declarative and deletes the inline code.
- The 200 with **no** check are the bulk — each needs the B0 bucket decision applied.
- **Per-route verification is mandatory** and is the gate: the intended caller still succeeds, an unprivileged caller is rejected. A batch does not ship on `tsc` + green-suite alone.

### B acceptance

- `git grep "auth: 'public'"` returns only routes in the **genuinely-public** bucket.
- `auth-posture.test.ts` enumerates every route, its posture, and a one-line rationale; it fails CI if a new route lands `auth: 'public'` without a rationale entry.

---

## 3. Risks

- **R1 — `harness.ts` helper exports (A4).** Deleting `harness.ts` before relocating `getHarnessStatusFull` et al. breaks importers (incl. migrated mobile routes). Mitigation: helper-relocation is the *first* batch of A4, with `tsc` as the gate.
- **R2 — the plugin-API dispatcher (A3).** Relocating a runtime-mutated catch-all is the subtlest part of A. Mitigation: A3 gets its own design note; a plugin-supplied route is the acceptance fixture.
- **R3 — pty WebSocket (A2).** The WS upgrade is not a `defineRoute`. Mitigation: split control-routes from the WS handler explicitly; don't force WS into the route model.
- **R4 — auth-tightening fail-open (B).** A route mis-bucketed as loopback-tier when it should be verified-user is a security hole. Mitigation: per-route verification is the batch gate; `auth-posture.test.ts` is the durable check.
- **R5 — concurrent agents.** This repo has multiple agents committing. Every commit uses explicit `--only` pathspecs; `git status --short` before each commit.

## 4. Sequencing summary

```
A1  small routers (~22)            ─┐
A2  mid routers (~34)               │  Workstream A
A3  plugins + dispatcher (7)        │  ~199 routes → defineRoute
A4  harness.ts (138, ~18 batches)   │  then delete _hono/
A5  orphan triage                   │
A6  delete _hono/                    │
A7  no-raw-route-handlers lint      ─┘
B0  audit + categorize (~430)       ─┐  Workstream B
B1…Bn  convert in family batches     │  auth-tightening
B    auth-posture.test.ts gate      ─┘  (after A; B0 may start early)
```

Deferred (not in this plan): E8 `expose.ipc` for routes — no driver.

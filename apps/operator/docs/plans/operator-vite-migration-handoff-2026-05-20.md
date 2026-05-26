---
title: operator-vite migration handoff (Phase E shipped, uncommitted)
slug: operator-vite-migration-handoff-2026-05-20
created: 2026-05-20
updated: 2026-05-25
status: draft
---

# Handoff — operator-vite migration

You are taking over the **frontend half** of the Next.js → Vite migration for `apps/operator/`. A separate backend agent owns the `route.ts → defineRoute` work and has **already shipped that stream** (0 raw `route.ts` remaining, see plan §Inventory).

**Canonical plan:** `apps/operator/docs/plans/operator-vite-migration-2026-05-20.md` — read it before doing anything. It's been audited 5 times and is internally consistent. The phases (0, A, B, C, D, E, F, G, H) and their gates are spec'd there.

**What's already done (this session):**

| Phase | What | Commit |
|---|---|---|
| 0 — Boundary lock | `apps/operator/app/api/_hono/BOUNDARY.md` + coord entry | shipped |
| A — Vite scaffold | `apps/operator-vite/` (Vite 8 + TSR + React 19 + plugins). `npm run build` clean. | shipped, multiple commits |
| A3 — Provider stack | `__root.tsx` translates 12 of 14 `layout.tsx` providers. `npm run build` succeeds (1204 modules); ChromeShell + RouteProgressProvider deferred to Phase D. | shipped |
| C — Hono host | `apps/operator/bin/{hono-host.ts, host-handler.ts, page-routes.ts}`. C1+C2 verified empirically (6/6 smoke + real `@hono/node-server` boot answers `/api/health` 200). | shipped (`fec34b2b` + earlier) |
| **E — Config replication** | **Code on disk, NOT committed yet.** Smoke 12/12 pass. One sub-check (gzip) interrupted before verification. | **PENDING** |

**Your immediate next step:** verify Phase E gzip, then commit Phase E. Details below.

## Phase E artifacts (on disk, uncommitted)

All under `apps/operator/bin/`:

| File | Role |
|---|---|
| `host-cors.ts` | Broad `/api/*` CORS — faithful port of `proxy.ts`. `apiCors` middleware. |
| `host-docs.ts` | `/internal/docs/*` sub-app: loopback gate + Accept→`.md` + slug→`.html` + 404. Docs root resolved from `__dirname` (NOT `process.cwd()` — avoids the audit-3 bug). |
| `host-proxies.ts` | Cross-app proxies (`/api/org/*`→:3061, `/api/admin-sidebar/*`→:3001, etc.) + Rust opt-in middleware (default off). |
| `host-handler.ts` | **REWRITTEN.** Composes a top-level Hono app: `compress` → `apiCors` → `rustOptIn` → `crossAppRewrites` → `docsRoutes` → `pageRoutes` → local-API fallthrough `app.fetch`. |
| `_smoke-e.ts` | 12-test verification — delete before commit (it's a scratch). |
| `_smoke-e-gzip.ts` | 4-line gzip verification (small enough to survive interrupts) — delete before commit. |

**Existing C-phase files unchanged:** `hono-host.ts` (entrypoint, still calls `runBootstrap()` then `serve()` with `handler`), `page-routes.ts` (`/wiki`, `/drizzle-studio`).

### Deviation from plan E2 (documented as-built)

Plan E2 said to mount the broad CORS *inside* `_hono/app.ts` via Hono `cors()` middleware. I deliberately mounted it at **host level** instead (`host-handler.ts` → `host-cors.ts`). Reasons:
1. `_hono/app.ts` is the Phase 0 BOUNDARY-locked module shared with the backend agent; widening its existing narrow `tauriApiCors` mid-stream would race.
2. Host-level CORS is the OUTER layer — it overwrites `_hono`'s narrower ACAO for the 5-path overlap, exactly mirroring the Next stack (`proxy.ts` outer + `_hono` inner).
3. Behaviorally equivalent — every test passes.

**Plan should be updated** to reflect this as-built when you commit. Suggested edit: in plan E2, change the CORS row's "Replication" cell to say "Hono middleware mounted in `apps/operator/bin/host-cors.ts`, applied host-side; `_hono`'s narrower `tauriApiCors` is left untouched."

## Resume steps (in order)

### 1. Verify gzip (the one check the interrupts killed)

```bash
cd apps/operator
npx tsx bin/_smoke-e-gzip.ts
```

Expected output:
```
status: 200 | content-encoding: gzip | body bytes: <small number, ~3-10KB> | gzipped? true
```

(`hono/compress` only fires when the request advertises `Accept-Encoding: gzip` — the 12-test smoke does NOT send that header, which is why those bodies came back as readable HTML, not gzip bytes. The 4-line scratch above sends the header. If gzipped is `true`, Phase E is fully verified.)

If gzip doesn't fire, the most likely cause is `_hono/app.ts`'s inner `compress({ threshold: 1024 })` already gzipping `/api/*` and the outer `hono/compress` correctly skipping — but the docs path doesn't pass through `_hono`, so the outer compress SHOULD fire there. If it doesn't, check that `hono/compress` is calling `CompressionStream` (Node 18+ global) — `node -e "console.log(typeof CompressionStream)"` should print `function`.

### 2. Re-run the 12-test smoke for safety

```bash
cd apps/operator && npx tsx bin/_smoke-e.ts
```

Expected: `12 passed, 0 failed`.

### 3. Delete the two scratch smoke files

```bash
rm apps/operator/bin/_smoke-e.ts apps/operator/bin/_smoke-e-gzip.ts
```

### 4. Update the plan's E2 CORS row to reflect the as-built (see deviation note above).

### 5. Commit ONLY Phase E surfaces

**CRITICAL — shared checkout hazard.** This is a multi-agent monorepo. Other agents' WIP is constantly in the working tree. NEVER use `git add -A` or `git add .` — it sweeps unrelated work into your commit. Stage explicit paths only:

```bash
cd /home/marsh-office/papercupai-workspace/papercup
git reset                                                    # clear any pre-staged WIP from other agents
git add apps/operator/bin/host-cors.ts
git add apps/operator/bin/host-docs.ts
git add apps/operator/bin/host-proxies.ts
git add apps/operator/bin/host-handler.ts
git add apps/operator/docs/plans/operator-vite-migration-2026-05-20.md         # E2 deviation note
git add apps/operator/docs/plans/operator-vite-migration-handoff-2026-05-20.md # this file
git diff --cached --stat                                     # verify ONLY these 6 paths are staged
git commit -m "feat(host): Phase E — port next.config.js + proxy.ts to Hono host"
git push origin main
```

If `git diff --cached --stat` shows more than the 6 explicit files, run `git reset` and start over.

### 6. Append a coord checkpoint

```bash
cat >> coord/frontend.jsonl <<EOF
{"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","agent":"frontend","kind":"phase-shipped","phase":"E","commit":"<the-sha-from-step-5>"}
EOF
git add coord/frontend.jsonl
git commit -m "coord(frontend): Phase E shipped" && git push origin main
```

## Phases that remain (read the plan for full detail)

| Phase | What | Blocked by |
|---|---|---|
| **B** | Translate 62 page.tsx + 6 layout.tsx → TSR routes. 7 batches (B-1..B-7), counts verified per top-level dir (`/settings` is the largest at 20 pages, NOT `/harness`). See plan §B2 for the batch table. Includes B6 (the `@bprogress/next` → react adapter, ~30-60 LOC TSR `useRouterState` subscriber replacing `app/_components/RouteProgressProvider.tsx`). | nothing |
| **D** | Page-side `next/{navigation,dynamic,link}` audit + replacement. Real counts: 21 + 16 + 3 = 40 import sites (NOT 97 — earlier figure was inflated by `.next-prod` build artifacts). Mostly mechanical sed/Edit. Rolled into B batches. | nothing |
| **F** | Tauri shell: dev URL stays `:3055` (Vite), prod loads from `:3070` Hono host. Sibling repo (`../papercusp-desktop/`) — NOT this one. Storybook needs zero migration; already `@storybook/react-vite`. | A, E |
| **G** | Collapse three dev processes → one prod process. Production `:3070` Hono host serves built `dist/` + API + docs + page-routes. | B, E, backend agent finished (✅ already done) |
| **H** | Delete Next: `app/`, `proxy.ts`, `next.config.js`, `.next*`, `next` dep. Move `apps/operator/{_hono, lib, bin, prompts, scripts, __tests__, e2e}/` → `apps/operator-vite/server/` (option-b layout decision frozen in plan). Backend agent deletes the catch-all shim. | G |

**Phase B is the longest stretch.** Start by re-grepping page-side counts (`git grep "from 'next/navigation'" apps/operator/app | wc -l`) to confirm current numbers before sizing batches.

**Dependency order recommendation:** B first (the long pole), then F (Tauri config — small), then G (single-process collapse — small), then H (delete).

## Operational gotchas in this environment

These are real and bit the previous session hard. Read them.

1. **Interrupts during long tool calls.** Long `mcp__pi__bash` commands and long `mcp__pi__write` files get aborted. Mitigations:
   - **Write files in chunks.** Initial `mcp__pi__write` with a small header, then `mcp__pi__edit` to append section by section. Each edit ≤80 lines roughly.
   - **Don't run interactive long commands.** No `npm run dev`. Spawn long jobs by piping output to a log file (`> /tmp/foo.log 2>&1 &`) and `tail` the log in a separate bash call.
   - **Verify after every commit-shaped action.** After every commit/push, re-run `git log --oneline -3` and `git status --short` to confirm state survived.

2. **No `Skill` / `Task` / `TaskCreate` / `Monitor` tools in this environment.** They appear in tool definitions but the user has explicitly disabled them ("the monitor and task tool don't work stop trying to use them"). Don't try. Track progress in this brief / coord channel / your head.

3. **MCP `context7` server may appear/disappear.** It connects, sends instructions, disconnects. Ignore — your work doesn't depend on it. Verify library APIs by `require.resolve` and reading package source instead.

4. **Multi-agent shared checkout — the `git add -A` hazard.** Every turn, `git status` will show **dozens** of modified files belonging to other agents. Never `git add -A` / `git add .`. Always `git add` explicit paths. After staging, ALWAYS run `git diff --cached --stat` and verify ONLY your intended files are staged. If you see anything unexpected, `git reset` and start the staging over.

5. **Coord channel — `coord/frontend.jsonl`.** Append-only JSONL log. Your turn ends by appending an entry naming what you shipped + commit SHA. Read the last 10 lines at turn start to know what's going on. The backend agent appends to `coord/backend.jsonl`.

6. **The Phase 0 BOUNDARY contract.** `apps/operator/app/api/_hono/{app.ts, bootstrap.ts}` are SHARED with the backend agent. `export { app }` and `runBootstrap()` are the contract surface. Don't change their shape without a coord entry naming the change and getting an ack.

7. **`npm install` requires `--legacy-peer-deps`** — there's a pre-existing peer-dep conflict in `apps/papercup`. Bare `npm install` fails. Always use the flag.

8. **No `process.cwd()` for path resolution.** Audit-3 found a real bug where the docs MCP adapter used `process.cwd()`-relative paths and returned empty because the operator runs with cwd `apps/operator`, not the repo root. Use `__dirname`-relative or a `_repo-paths.ts`-style walker. Phase E's `host-docs.ts` already does the right thing (`resolve(__dirname, '..', 'public', 'internal', 'docs')`).

## Key files at a glance

| Path | Why you care |
|---|---|
| `apps/operator/docs/plans/operator-vite-migration-2026-05-20.md` | THE plan. Authoritative. Audited 5x. |
| `apps/operator/app/api/_hono/BOUNDARY.md` | The Phase 0 contract with the backend agent. |
| `apps/operator/app/api/_hono/app.ts` | The shared Hono app. `export { app }` at line 111. DO NOT modify shape. |
| `apps/operator/app/api/_hono/bootstrap.ts` | The shared bootstrap. `runBootstrap()` idempotent. DO NOT modify shape. |
| `apps/operator/app/api/[[...route]]/route.ts` | 25-line catch-all shim (`handle(app)`). Backend agent deletes this at Phase H. |
| `apps/operator/next.config.js` | Source of truth for what Phase E ports. |
| `apps/operator/proxy.ts` | The other source of truth for Phase E. |
| `apps/operator/bin/` | Where the Hono host lives. (Phase C, E.) |
| `apps/operator-vite/` | The new Vite app. (Phase A scaffold.) |
| `coord/frontend.jsonl` | Your append-only coord log. |
| `coord/backend.jsonl` | Backend agent's coord log — read at turn start. |
| `apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md` | Backend agent's plan. `status: shipped`. |
| `../papercusp-desktop/` | Sibling repo (NOT this one). Tauri shell lives there. F4 work happens there. |

## Memory references (auto-memory in this environment)

- `project_fumadocs_to_starlight_plan.md` — prior migration; F1–F11 shipped; relevant because docs serving still flows through Phase E's `host-docs.ts`.
- `project_endpoint_system_streaming_plan_reviews_2026-05-12.md` — context on the endpoint-route system (backend agent's domain).
- `feedback_handler_delete_bounds.md` — careful with `mcp__pi__edit` boundaries; never delete from a handler line to a `next-harness.*` line. (Bit twice in Rust port at stages 2.44 + 2.49.)
- `feedback_no_regex_for_func_args.md` — `[^)]*` greedily eats nested parens; use full signatures in `mcp__pi__edit` `oldString`.
- `feedback_pre_alpha_freedom.md` — no users, no production. Break things freely. No deprecation aliases. Pick the right fix.

## What "done" looks like for the migration

```
git grep -lE "next/(navigation|dynamic|link|server|headers)" apps/operator/ | wc -l    # → 0
git grep -l "from ['\"]next/" apps/operator/ | wc -l                                    # → 0
test ! -d apps/operator/app                                                              # success
test ! -f apps/operator/next.config.js                                                   # success
test ! -f apps/operator/proxy.ts                                                          # success
grep -E '"next":' apps/operator/package.json                                              # exit 1
curl -sf http://127.0.0.1:3055/                                                          # 200 (Vite dev)
curl -sf http://127.0.0.1:3070/api/health                                                # 200 (prod Hono)
curl -sf http://127.0.0.1:3070/internal/docs/agent-policies                              # 200 (docs)
```

When all of the above hold, the migration is done.

## Final note

The previous session got 4 of the planned 8 phases shipped (0, A, A3, C, E-uncommitted) and authored a fully reviewed/audited plan. Phase E is the largest remaining stand-alone piece; the rest (B, F, G, H) are largely mechanical. Phase B is the longest by raw count but is the most parallelizable. Don't be surprised if a single Phase B batch takes a day — they're 8-12 page.tsx translations each plus per-batch smoke.

If you hit ambiguity, the plan doc is authoritative; if the plan is silent, prefer faithful 1:1 ports over enhancements. The user's standing instruction: pre-alpha, no users, no compromises — but no scope creep either.

Good luck.

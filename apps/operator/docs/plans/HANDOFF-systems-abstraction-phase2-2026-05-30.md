---
title: Handoff — systems-abstraction Phase 2 (pick up here)
slug: HANDOFF-systems-abstraction-phase2-2026-05-30
status: active
created: 2026-05-30
owner: avi@storewolf.com
companion-to: [papercusp-systems-abstraction-2026-05-29]
---

# Handoff: papercusp-systems-abstraction Phase 2

## Now

**State:** 7 packages shipped on `main` (rrf, embedded-pg-discovery, plan-parser,
rate-limit, ipc-framing, desktop-ipc, **ipc-endpoint-server**). **P-030 is now
`done`** — all three IPC pieces are extracted (shipped `c74cbe70` + plan flip
`7cac0a37`).

P-030 pt3 was finished with a **simpler design than this brief sketched**: the
package takes a required `host: IpcEndpointHost` (3 injected fns —
`lookupByMcpName`, `dispatchProjectedToolStream`, `getWorkspaceId`), and
`apps/operator/lib/endpoint-ipc/server.ts` became the thin **operator host
adapter** that injects the host and re-exports a bound `startEndpointIpcServer`.
Because the boot site + `dev_ipc_echo_e2e.test.ts` call the bound adapter, those
call sites were left UNCHANGED (no `host` at the call site). The moved
`server.test.ts` wires its OWN `@papercusp/tooldef` lookup/dispatch into `host`,
so the dual-registry failure mode that blocked attempts 2–3 is structurally
impossible — no vitest.config / `deps.inline` / alias gymnastics were needed
(the package has NO vitest.config at all, matching the ipc-framing recipe). The
only config change required was the `ipc-framing` `exports` → object-form fix
(#1 below). Bonus: the operator's `server.test.ts` was **already red on main**
(its synthetic `ProjectedTool` fixture used the pre-tooldef-extraction shape:
`args`/`requiresPrincipal` + `classifyEventWire`, which isn't exported from
`@papercusp/tooldef`); the moved+fixed fixture (`description` + `inputSchema` +
literal `eventWireKinds`) un-breaks it without touching the tooldef package.

**Next:** the backlog in lowest-risk-first order. **P-023 / P-024 are now `done`**
(`@papercusp/backup`, shipped `73fa053d` + flip `2bb372de`). Start at **P-013 →
P-020 (search)**, then P-021 (memory) → P-010 (locks) → P-011/P-012 (coordination)
→ P-040 → P-050/P-051.

**P-023/P-024 notes (what actually shipped, vs the audit below):** the audit
called the DB seam a "settings-table accessor" — it's actually the org-PG `sql`
handle used at 13+ sites, injected as `getSql()`. Final seam set (module-level
`configureBackup(host)`): `getSql`, `workspacesRoot`, `ensureSchema`,
`getHarnessAdminUrl`, + optional `shouldPauseSweep` (battery-policy; a 5th coupling
the audit missed — it was a *dynamic* `import('../search/battery-policy')` in
orphan-cleanup, invisible to a static-import grep). `apps/operator/lib/backup/` is
now configure.ts + index barrel + two deep-path shims (scheduler, orphan-cleanup);
all ~28 consumers unchanged. `orphan-cleanup.test.ts` stayed operator-side (live-PG
integration) and tests through the shim. P-024 opened `SnapshotTriggerReason` to
`'manual' | 'interval' | (string & {})`. The package has ZERO `@papercusp/@restart`
runtime deps. Verified: package tsc + 11/11; operator orphan-cleanup 7/7 + admin
18/18; operator tsc 785→781 (−4, two latent bugs fixed). The host-adapter-barrel +
`configureBackup` module-seam pattern is the template for the remaining
PG-touching extractions (search/memory).

Read this, then the full plan: `papercusp-systems-abstraction-2026-05-29.md`
(via `plans:get`). Everything below is verified against the repo at the time of
writing — but **re-verify before acting** (other agents commit to `main`
continuously; HEAD moves under you).

## Ground rules (from the user, non-negotiable)

- **All work on `main`** in the canonical checkout `~/papercupai-workspace/papercup`.
  **No branches, no git worktrees.** Use the **lock + coord system** for sync, not
  branch isolation. (`locks:acquire` before editing; `coord:declare-intent` +
  `coord:send` to broadcast.) Don't pause the plan for infra friction.
- **`git rev-parse --abbrev-ref HEAD` before every commit** — confirm `main`.
  A sub-agent silently moved the checkout off `main` earlier in this arc; it's
  back on `main` now.
- **Commit each package the instant it verifies** (don't batch across packages);
  `git reset -q` then `git add <explicit paths>` right before commit, because a
  background `paperclipai run` does `git add -A` on a timer and will otherwise
  sweep your uncommitted files into its commits. Put `-m` BEFORE `--` (or use
  `git commit -F <file>`); `git commit -- <path> -m "..."` fails (msg treated as
  pathspec).

## What's DONE (verified: packages exist on disk + plan item = `done`)

Six packages shipped on `main` this arc. Each followed the recipe: a new
`packages/<name>/` with **src-as-entry** (no build step, `main`/`types` →
`./src/index.ts`, mirrors `@papercusp/docs-engine`), the package owns its vitest
suite, a `file:` dep added to `apps/operator/package.json`, and
`node_modules/@papercusp/<name>` **symlinked directly** (`ln -sfn ../../packages/<name>
node_modules/@papercusp/<name>`). All six symlinks are present.

| Item | Package | Approach | Consumer impact |
|---|---|---|---|
| P-002 | `@papercusp/rrf` | move + rewire | `search/semantic.ts` + `endpoint-route/routes/user/search.ts` import from it; old `agent-tools/search/rrf.ts` deleted |
| P-003 | `@papercusp/embedded-pg-discovery` | thin wrapper | `lib/embedded-pg-discovery.ts` wraps `resolvePgUrl(...)`; all `getHarnessAdminUrl` callers untouched |
| P-022 | `@papercusp/plan-parser` | move + re-export shims | `plans/{parser,effective-status,content-hash}.ts` are 1-line `export *` shims; 33 in-`apps/operator` consumers unchanged |
| P-031 | `@papercusp/rate-limit` | move + thin host adapter | `lib/auth-rate-limit.ts` is now a PG-backed `BucketStore` adapter; `login.ts` + 2 tests untouched |
| P-030 pt1 | `@papercusp/ipc-framing` | move + shim | `endpoint-ipc/framing.ts` is a 1-line shim; 6 in-dir consumers unchanged |
| P-030 pt2 | `@papercusp/desktop-ipc` | whole-dir move + 2 shims | extracted ALL of `lib/transport-adapters/`; `index.ts` + `desktop-bootstrap.ts` are shims (incl. a `./desktop-bootstrap` subpath export); 4 consumers unchanged |

**Add-commits — VERIFIED via `git log --diff-filter=A -- packages/<p>/package.json`
(re-confirm yourself; HEAD moves):** rrf `591eaf28` (the package.json was swept
into an unrelated commit by paperclip's `git add -A`; the rrf source+rewire landed
in follow-up commits — net result on disk is correct), embedded-pg-discovery
`68e5116a`, plan-parser `e96f63f3`, rate-limit `bc75a0d9` (also a paperclip-swept
commit; package files landed in a follow-up — net correct), ipc-framing
`775fb24e`, desktop-ipc `e6055e94`. These are the commits that first added each
`package.json`; some are NOT the clean feat-commit you'd expect, because
paperclip's timer swept staged files mid-extraction. The packages on disk are
correct regardless — trust the disk state + tests, not the commit messages.

Design corrections made vs. the original plan audit (all in the plan body):
- **rate-limit (P-031):** uses an injected `BucketStore` seam, NOT the planned
  `PgHandle`+table — safer for security-sensitive login SQL (no schema-identifier
  interpolation). Operator keeps its exact `harness_shared.auth_rate_limit` SQL.
- **desktop-ipc (P-030 pt2):** the audit said "extract the 4 IPC files"; that's
  NOT a clean cut — they share `types.ts` + `sse-parser.ts` with the HTTP path and
  the `index.ts` picker wires both, so the **whole `transport-adapters/` dir** is
  the real seam.
- **plan-parser (P-022):** pure tier only (`parser` + `effective-status` +
  `content-hash`); `lint.ts` is NOT pure (imports `source.ts`) — stays in-app.

## ✅ DONE — P-030 pt3 (`@papercusp/ipc-endpoint-server`), shipped `c74cbe70`

> Resolved. The original design notes below are kept as historical context.
> What actually shipped differs (and is simpler): see the updated **## Now**
> at the top. Key deltas from the sketch below: (a) full `host` injection means
> the package has NO runtime `@papercusp/tooldef` import, so the dual-registry
> risk is structurally impossible and **no vitest.config was needed** (the
> package has none, like ipc-framing); (b) only the `ipc-framing` `exports`
> object-form fix (#1) was required, not the `defineVitestConfig` extension;
> (c) `apps/operator/lib/endpoint-ipc/server.ts` is a host *adapter* (injects
> host, re-exports a bound `startEndpointIpcServer`) so the boot site + e2e test
> call sites are unchanged — the boot site was NOT rewired.

**`@papercusp/ipc-endpoint-server`** — the last IPC piece. **Plan item P-030 was
`wip`.** Attempted 3× in the prior session, **all reverted clean** (main never left
broken on attempts 2–3; attempt 1 briefly broke it and was fixed). The
**package does not exist on disk right now** (`packages/ipc-endpoint-server`
absent — verified) and `apps/operator/lib/endpoint-ipc/` still has the 4
originals: `server.ts`, `sys-http.ts`, `server.test.ts`, `sys-http.test.ts` (plus
`framing.ts` shim, `dev_ipc_echo_e2e.test.ts`, `PROTOCOL.md`).

**The package CODE is correct** (attempt 2 had it building with 31/33 tests
passing; attempt 3 had 11 passing before a resolution error). The blocker is
**purely standalone-vitest sibling resolution** — this is the first extracted
package whose **test files** import two sibling `@papercusp/*.ts` packages
(`@papercusp/ipc-framing` and `@papercusp/tooldef`).

### What the extraction is (verified against the code)

- Move `endpoint-ipc/server.ts` (399 LOC) + `endpoint-ipc/sys-http.ts` (225 LOC,
  self-contained, only imports framing) into `packages/ipc-endpoint-server/src/`.
- **Coupling is exactly 3 injected fns** (NOT the plan's original "4"):
  `lookupByMcpName`, `dispatchProjectedToolStream`, `getWorkspaceId` (wraps the
  operator's `activeWorkspaceId`). The plan's "4th" (`allowedTools`) is already a
  caller option, not a coupling. Inject them via a required
  `host: IpcEndpointHost` field on `StartEndpointIpcServerOptions`.
  `UnifiedToolContext` + `DispatchProjectedDeps` stay `import type` from
  `@papercusp/tooldef` (no runtime dep). `./framing` → `@papercusp/ipc-framing`.
- `lookupByMcpName` + `dispatchProjectedToolStream` are exported from BOTH
  `@papercusp/tooldef` (origin) and `@papercusp/agent-mcp` (re-export) — depend on
  `@papercusp/tooldef` directly (already shipped, stable).
- **Consumers to rewire:** boot site `apps/operator/instrumentation-node.ts`
  (~line 445, `maybeStartEndpointIpcServer` — pass `host: {...}` alongside the
  existing `deps`/`allowedTools`), and leave a re-export shim at
  `endpoint-ipc/server.ts` for `dev_ipc_echo_e2e.test.ts` (imports
  `startEndpointIpcServer`). `sys-http.ts` has NO external consumer (only a
  doc-comment mention in instrumentation-node) — moves cleanly.
- The integration test (`server.test.ts`) needs a `host` constructed from the
  real `@papercusp/tooldef` `lookupByMcpName`/`dispatchProjectedToolStream`, and
  both its `startEndpointIpcServer({...})` call sites need `host:` added.

### The actual blocker + turnkey fix (root-caused across 3 attempts)

`server.test.ts` registers a synthetic tool via `registerProjectedTool` and
expects the dispatcher to read the **same** tooldef module-singleton registry.
Two distinct sub-issues, both confirmed:

1. **`@papercusp/ipc-framing` uses string-shorthand `exports`**
   (`{".":"./src/index.ts"}`) which vite's resolver won't follow as a dep entry.
   Switch it to the conditional-object form like `@papercusp/tooldef`:
   `{".":{"types":"./src/index.ts","import":"./src/index.ts","default":"./src/index.ts"}}`.
   (ipc-framing's own 16 tests use relative `./index` imports, and the operator
   consumes it via the shim — both unaffected; this is a net-positive consistency
   fix. NOTE: `docs-engine`/`rate-limit`/`rrf` also use the shorthand — they only
   resolve in the operator via vite-tsconfig-paths, not standalone vitest.)
2. **Do NOT hand-roll a bare `defineConfig` vitest.config** — it REPLACES vitest's
   default resolver and breaks `@papercusp/tooldef` resolution that no-config
   gets for free (`node require.resolve('@papercusp/tooldef')` succeeds from the
   package dir, so the symlink is fine). **Do NOT use `resolve.alias` for
   tooldef** — aliasing forks it into a 2nd module instance, so
   `registerProjectedTool` writes registry A while the dispatcher reads registry
   B → the 2 streaming/cancel tests fail (this was the attempt-2 failure).

   **Turnkey:** create `packages/ipc-endpoint-server/vitest.config.ts` by
   EXTENDING the repo base — `import { defineVitestConfig } from
   '@papercusp/test-config'` (the way `apps/operator/vitest.config.ts` does), which
   pulls in vite-tsconfig-paths + `deps.inline`, so both siblings resolve as a
   **single instance** and all tests pass. (Verify `@papercusp/test-config` is the
   right import — read `apps/operator/vitest.config.ts` first.)

   **Fallback** if base-config resolution still fights: keep the 2
   registry-dependent `server.test.ts` cases (streaming-dispatch, cancel) in
   `apps/operator` under the operator's vitest (single tooldef instance) and ship
   the package with its standalone-safe tests (sys-http ×12, bind, allowlist,
   unknown-tool).

### Process discipline for pt3 (learned the hard way)

- Use **`cp`, not `git mv`**, to copy files into the new package — keep the
  originals intact until the shim is wired at the very end. (Attempt 1 `git mv`'d
  `sys-http.ts` out first, leaving `server.ts`'s `./sys-http` dangling → main
  broke.)
- After copying, **grep for stale `from './framing'`** before running tests —
  every moved file must import `@papercusp/ipc-framing`.
- Build package + shim FIRST, verify tests green, THEN rewire the boot site, THEN
  delete originals — never leave the original importing a moved file.
- If the sandbox terminal degrades (truncated/echoed output), **stop and revert
  clean** rather than thrash — that's how attempt 1 broke main.

## Remaining backlog (all plan items `todo`, in lowest-risk-first order)

- **P-030 pt3** — `ipc-endpoint-server` (above). Finishes P-030.
- **P-023 / P-024** — `@papercusp/backup` (kopia wrapper). ~24 files
  (`lib/backup/` 16 + `agent-tools/backup/` 8). Real seam is **workspace-root path
  + workspaceId + a settings-table accessor**, NOT a PG tx (uses raw `getOrgPg()`).
  Table is `harness_shared.workspace_backup_settings`. Keep the load-bearing
  self-exclusion guard (`policy.ts` `IGNORE_PATTERNS` must contain `backups`;
  enforced by `assertSelfExclusionPolicy`). P-024 = externalize the hardcoded
  `SnapshotTriggerReason` enum (couples to harness lifecycle hooks). Audit
  `server.ts`/`scheduler.ts`/`hook.ts` first.
- **P-013** — pre-req for P-020. `search/semantic.ts` (8×) + `fulltext.ts` (4×)
  read optional `ctx.tx`; reads are `try/catch`-guarded so absence degrades to
  empty results (NOT a crash — earlier audit overstated it). Make the DB contract
  explicit (inject a `PgHandle`) during the search extraction.
- **P-020** — `@papercusp/search` (BM25 + pgvector hybrid). Seams: `SearchSource`
  registry (the 4 surfaces are hardcoded branches), injectable embedder, PgHandle.
  Depends on rrf (done) + P-013.
- **P-021** — `@papercusp/memory`. mem0 (`mem0ai`) owns its own `pg.Client`, so
  NOT a PgHandle — seams are PgDiscovery + EmbedderProvider + VectorStoreProvider
  (+ optional Claude dedup judge, feature-flagged off). Coupling LOW.
- **P-010** — `@papercusp/locks`. Extract AS-IS behind the `@papercusp/file-claim`
  interface it ALREADY implements (`SuLocksCoordinator`); keep its own
  `papercusp_su` DB + pool + `pg_advisory_xact_lock`. Do NOT inject a shared tx
  handle. Caller passes opaque `coordinationDomain` string.
- **P-011 / P-012** — `@papercusp/coordination` as 3 pieces (D-009): `coord-core`
  (pure) + `CoordEventLog` (fs default + optional PG, the only swappable seam) +
  `PresenceStore` (PG, separate). P-012 first: migrate
  `escalations.resolveEscalation` from in-place mutation to an
  `escalation_resolved` append so the event log is cleanly append-only.
- **P-040** — publish/promote Population-A libs (already factored, just packaging):
  `@restart/sse`, `@papercusp/token-kit`, `@papercusp/host-platform`,
  `@papercusp/docs-engine`, `@papercusp/file-claim`, the React libs, `@papercusp/flags`.
- **P-050 / P-051** — verification (conformance suites + a detached-mode proof).
- **P-023b** (prose follow-up, not a formal item): rewire the 33 `plan-parser`
  consumers off the re-export shims to direct `@papercusp/plan-parser` imports,
  then delete the shims. Deferred — non-urgent.
- **P-000** (`needs-human`): confirm the ~4-bundle packaging decision (D-002) vs.
  one-package-per-system. Does NOT block extractions.

## Cross-cutting facts (verified)

- **Root `npm install` is BROKEN** by a pre-existing `@blocknote/mantine` ERESOLVE
  (unrelated to this work). Do NOT chase it. Link new packages with a direct
  `node_modules` symlink, or use `--legacy-peer-deps` if you must install.
- The companion `@papercusp/tooldef` / chat-system extractions are owned by OTHER
  teams — out of scope here (D-001). `tooldef` is already shipped and depended on.
- Plan lints clean (`plans:lint`). Keep it that way; mark items `done` as you ship.

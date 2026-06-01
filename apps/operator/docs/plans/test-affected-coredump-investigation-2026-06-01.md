---
title: "Investigation brief: `npm run test:affected` core-dumps (Node 25 + vitest worker pool)"
slug: test-affected-coredump-investigation-2026-06-01
status: done
created: 2026-06-01
owner: claude (su-2f904)
tags: [test-infra, vitest, node-version, ci]
---

## RESOLVED 2026-06-01 — `pool: 'forks'` (commit c09cf6b1b)

**Root cause (corrected):** the shared config was **not** "no pool override"
as the brief guessed — `libs/test-config/src/vitest-config.ts` set the unit +
browser layers to **`pool: 'threads'`** (worker_threads). worker_threads share
one libuv loop, which aborts mid-run under Node ≥25 on this kernel (io_uring is
a symptom on *some* runs, not the cause — `UV_USE_IO_URING=0` alone is
insufficient, as the brief already found).

**Fix (candidate #2, chosen over the Node-22 pin #1):**
`pool: layer === 'browser' ? 'threads' : 'forks'`. `forks` is vitest's own
default; it runs each file in its own child process, is stable across Node
versions, and removes the dependency on which Node the runner's PATH resolves.
Chosen over the Node-22 pin because a pool change is robust on every runner
(CI + each box), whereas PATH-based Node pinning re-breaks the moment a runner
resolves a different Node. Wall-clock for the full operator suite ≈ 29s
parallel — no meaningful slowdown, so #2's "slower" caveat did not materialize.

**Verification:** full `npm test --workspace apps/operator` (661 files /
6820 tests) now runs **to completion** on Node 25.9.0 — exit 1 from real test
results, **never** code 134 / "Aborted (core dumped)". Acceptance criteria met.
Insight written: `agent-insights/vitest-threads-pool-node25-coredump`.

### Two findings the fix REVEALS but does not cause (both PRE-EXISTING)

Proven not-introduced: identical failures under the old `threads` pool when a
file is run in isolation (e.g. `distributed-claim.test.ts` → 7 failed under
both pools; `subscriptions.test.ts` → 7 under both).

1. **~60–110 pre-existing unit-test failures** the perpetual crash had masked
   (genuine broken/stale tests, not flake). `test:affected` runs only the
   changed-file closure, and `origin/main` on this box is hundreds of commits
   behind, so these rarely all ran at once before. **Out of scope for this
   infra plan — needs an explicit decision (see below).**
2. **~60 spurious `Test timed out in 5000ms` failures** that appear ONLY at
   full parallelism (forks `maxForks` = CPU count) and **vanish to 0 when
   serialized** (`--no-file-parallelism`). Worst-case-only CPU contention when
   running all 661 files at once; normal `test:affected` subsets don't hit it.

### Pre-existing-failures triage (investigated 2026-06-01, avi said "fix now")

Isolation-tested the failing files one-by-one (each run alone). Findings:

- **`app/**` UI/component tests → mostly CONTAMINATION.** They pass alone and
  fail only in the full suite (shared external-state bleed across files —
  filesystem/CWD/`.harness` paths, the real PG, ENOENT on moved routes, a
  "FileHandle closed during GC" fd leak). Sweep sample: 65/68 passed alone.
- **`lib/**` tests → substantial GENUINE failures** (fail in isolation, proven
  not pool-related — identical under `threads`). The dominant cluster is
  **test-debt from a repo-wide raw-`sql` → Drizzle `getOrgPg().db`
  query-builder migration**: the SUTs (voice-lease, device-pair-store,
  device-harnesses, operator-notes, omp-sessions, execute-action,
  harness-plan-reviews, cooldown-marks, harness-fs-watcher, harness-status-sweep,
  spawn-signing, admin-tables, provision/*, completion-ref-verifier, … ~16+
  files importing `generated`) now query via `db.select().from(generated.X)`,
  but their `vi.mock('@papercusp/db-org')` factories still only provide `sql`
  (and omit `generated`, so they crash at import with vitest's strict
  named-export check). Plus distinct one-offs: `distributed-claim` (7),
  `subscriptions` (7), `experts`, snapshots/`bumpPatch`, css-tokens, etc.

Fixing the genuine cluster is **not mechanical** — each test needs its `db`
query-builder mock rewritten (or conversion to a real-PG integration test per
the testing-spec). That's a strategy call + a multi-session effort. The
contamination is a separate root-cause investigation (find the file(s) that
pollute shared external state). **Both are out of THIS plan's scope (the
core-dump); tracked here for the follow-up.** Status of the follow-up is the
open decision below.

### Pre-existing-failure FIX progress (avi: two-pass — retire outdated, then fix relevant)

**Authoritative classification** (per-file isolation sweep, `forks`):
**38 genuine** failures (fail alone) out of 116 full-suite-failing files; the
other **78 are contamination** (pass alone, fail only in the full suite — a
separate root-cause).

**Pass 1 (retire) result: ~ZERO whole-file retirements.** Every genuine failure
tests a *live* feature whose test drifted from a recent refactor (P-054 tooldef
extraction, raw-`sql`→Drizzle migration, the backup seam, UI/env changes). No
test was found that tests a *removed* feature. (Outdated *assertions* inside
otherwise-relevant tests — e.g. raw-SQL-string `.toContain('DELETE FROM…')` —
are dropped as part of fixing each file.)

**Proven fix patterns (Pass 2):**
1. *Relocated import* → repoint. `@papercusp/agent-mcp/tool-projection` →
   `@papercusp/agent-mcp` (barrel still re-exports `lookupByMcpName`).
2. *db-org strict-export crash* → `vi.mock('@papercusp/db-org', async (orig) =>
   ({ ...(await orig()), getOrgPg: … }))`. `importActual` is side-effect-free
   (connection.ts is fully lazy — verified), so this keeps REAL
   `generated`/`schemaOf`/`withWorkspace` (drizzle `eq`/`and` resolve real
   columns) and only stubs the connection.
3. *SUT migrated to Drizzle `db`/`tx`* → chainable thenable fake:
   `thenable(r) = Proxy(fn,{get:(_,p)=> p==='then' ? res=>res(r) : ()=>thenable(r)})`;
   `db.select` resolves a queued rows array, `insert/delete/update` resolve `[]`
   and are recorded for behavioral assertions. Drop raw-SQL-string assertions.
4. *Empty-mock artifact assertions* (e.g. `expect(tables).toEqual([])` because
   `generated` was `{}`) → assert the real shape instead.

**FIXED + committed so far (13 of 38, all green in isolation):**
- tool-projection import (4): `ipc_echo`, `streaming-tools-migration`,
  `chat-architect.e2e`, `chat-surfaces.e2e`.
- db-org Drizzle / mock-gap: `voice-lease` (reference), `design`, `dev`,
  `operator-scan-lock`, `operator-audit`, `device-pair-store`,
  `device-harnesses`, `power-user-routes`, `operator-state-snapshot`.

**Extra pattern learned:** workspace-registry mocks need `workspacesRoot`
(backup seam reads it at import); ensure-schema is a flat module of `ensure*Table`
DDL helpers — spread the real module + harden the getOrgPg `sql` stub with
`unsafe`/`begin` so they no-op (a Proxy mock breaks vitest's interop).

**REMAINING genuine (25) — by cluster, with the pattern to apply:**
- *endpoint-route 500s (route throws at runtime — TRACE the thrown error, not
  just a mock-gap; capture the 500 response body / route try-catch):* `experts`,
  `agent-tools-device-auth`, `agent-tools-catchall` (also an SSE
  `event: delta` ordering assertion).
- *Relocated/retired path:* `chat-surface-tools` — a source-auditing test with a
  hardcoded list of `app/api/agent-mcp/**/route.ts` paths (the RETIRED Next.js
  routes). Repoint each `file:` to the relocated `lib/endpoint-route/routes/**`
  module, or rework the audit; the *intent* (chat surfaces wire tools
  consistently) is still relevant.
- *Assertion/expectation drift (verify NOT a real regression first):*
  `subscriptions`, `projects`, `roles`, `agent-tools/misc`, `require-principal`,
  `oauth/state`, `runner-aggregate`, `sync-resolver/table-to-query-names`,
  `harness-testing-registry`, `steps`, `OperatorChatSidebar`, `AddPanelCatalog`
  (UI text), `coord-hook`, `auth-posture`.
- *Env-specific assumption:* `desktop` (`/home/…/claude` vs `claude`; similar
  `gh` path) — assert resolved-path behavior, not the bare name.
- *Possibly REAL code issues (don't just patch the test):* `css-tokens` (43
  undefined CSS tokens), `perf-anti-patterns`, `un-hardcode-contract`
  (console.warn), `branch-actions` (5s timeout + FileHandle-GC fd leak under
  Node 25 — `ERR_INVALID_STATE`), `pty-ws`.
- *`bumpPatch is not a function`:* `app/installed/snapshots/page` — import/export
  drift in `InstalledSnapshotsClient`.

**Contamination (78 files, pass alone): NOT yet root-caused.** Shared
external-state bleed in the full suite (filesystem/CWD/`.harness` paths, real PG,
an fd leak). Separate workstream; `test:affected` subsets mostly dodge it.
---

## Objective

`npm run test:affected` cannot complete on the standing dev box — the
`apps/operator` (`@papercusp/web`) vitest run **core-dumps** (`SIGABRT`, exit
code 134) part-way through, non-deterministically. Find the root cause and make
the affected/CI unit suite run to completion again. This is a **test-infra /
environment** problem, not a product regression.

## TL;DR (most likely root cause)

The vitest process runs under **Node 25.9.0**, while the login shell is on Node
**22.21.1**. The shared vitest config sets **no pool override**, so vitest uses
its default parallel worker pool. Node 25.9.0 (current/non-LTS) + vitest 4.1.5's
parallel workers on this kernel appears to crash the worker (one run showed a
`libuv: io_uring_enter(getevents): Operation not supported` → `Aborted (core
dumped)`; a second run core-dumped on a *different* file with no io_uring
message). **Leading fix: run the test suite under Node 22 LTS, and/or pin a
stable pool in the shared config.** A known-good workaround already exists (see
below) so you can unblock immediately while confirming the real fix.

## Symptom (exact)

```
libuv: io_uring_enter(getevents): Operation not supported
Aborted (core dumped)
npm error code 134
npm error workspace @papercusp/web@0.0.1
npm error command sh -c vitest run --passWithNoTests
1 non-quarantined task(s) failed.
```

- Crash point is **non-deterministic**: run 1 died early in `@papercusp/web`'s
  suite; run 2 (with `UV_USE_IO_URING=0`) died later on
  `app/harness/useDebouncedSave.test.tsx` with **no** io_uring message — so
  io_uring is a *symptom on some runs*, not the whole story.
- **Every test that actually executed passed** (✓). It's a worker-process abort,
  not an assertion failure.
- `@papercusp/operator-vite` and other smaller workspaces complete fine; only the
  large `apps/operator` suite crashes.

## Reproduce

```bash
cd /home/marsh-office/papercupai-workspace/papercup
npm run test:affected          # or: npm test --workspace apps/operator
```

## Evidence already gathered (don't re-derive)

| Fact | Value |
|---|---|
| Login-shell node | `/home/linuxbrew/.linuxbrew/bin/node` → **v22.21.1** |
| `npm exec` node (what vitest runs under) | **v25.9.0** (linuxbrew `Cellar/node/25.9.0_1`) |
| vitest | 4.1.5 |
| Shared vitest config | `libs/test-config/src/index.ts` — **no** `pool`/`poolOptions`/`fileParallelism` override (→ vitest default parallel pool) |
| Walker | `scripts/affected-tests.mjs` — `spawnSync('npm', ['run', <script>, '--workspace', ws.dir])`; per-workspace `test` script = `vitest run --passWithNoTests` |
| Crashing workspace | `apps/operator` (`@papercusp/web`) |

The Node-version split is the strongest lead: the systemd `papercup-dev-api.service`
PATH and the npm exec PATH put linuxbrew Node **25.9.0** ahead of the nvm Node 22,
so tooling launched through npm runs on 25.9.0 even though an interactive `node -v`
may show 22.21.1.

## Ruled out

- **Not a product/test regression.** The crash files (`useDebouncedSave`, voice
  tests, etc.) are unrelated to recent changes; failures are SIGABRT aborts, not
  assertion failures.
- **Not solely io_uring.** `UV_USE_IO_URING=0` removed the io_uring message but the
  run still core-dumped on a different file — so disabling io_uring alone is
  insufficient.

## Known-good workaround (unblock immediately)

Running with a **single forked pool, no file parallelism** completes cleanly:

```bash
cd apps/operator
UV_USE_IO_URING=0 npx vitest run <files…> --pool=forks --no-file-parallelism
```

This is how the recent workspace-scoping changes were verified — 58 tests across
`papercusp-root` / `console-launcher` / `role-launch-spec` / `workspace-pin-guard`
+ their `bootstrap-su` / `bootstrap-role` consumers — all green. So the suite
*content* is healthy; only the default parallel pool under Node 25 is unstable.

## Candidate fixes (ranked — verify each before adopting)

1. **Run tests under Node 22 LTS (preferred).** Confirm whether Node 22 +
   default parallel pool is stable (it very likely is). If so, pin the test
   runner to Node 22: add an `.nvmrc`/`engines` + ensure `scripts/affected-tests.mjs`
   (and CI) invoke under Node 22, or fix the PATH ordering so npm doesn't pick up
   linuxbrew Node 25.9.0. Cheapest real fix; keeps full parallelism.
   - Verify: `PATH=<node22-first> npm test --workspace apps/operator` runs to
     completion.
2. **Pin a stable pool in the shared config.** In `libs/test-config/src/index.ts`
   `defineVitestConfig`, set `pool: 'forks'` (and consider
   `poolOptions.forks.singleFork` or `fileParallelism: false`). Fixes it
   regardless of Node version but **slower** — measure the wall-clock hit on
   `apps/operator` before committing to it; consider gating behind an env so CI
   can keep parallelism if it runs on Node 22.
   - Verify: full `npm test --workspace apps/operator` completes green.
3. **`UV_USE_IO_URING=0` in the runner env** — necessary-but-not-sufficient on its
   own (run 2 still crashed). Use only in combination, not as the fix.

Recommended path: confirm (1) first; if the box can't easily switch the test
runner to Node 22, ship (2) as the robust fallback.

## Acceptance criteria

- `npm run test:affected` (and a full `npm test --workspace apps/operator`)
  complete without a `code 134` / `Aborted (core dumped)`.
- The chosen fix is documented (root cause + why), and — if it's the Node-version
  pin or a pool change — captured as an agent-insight
  (`apps/operator-docs/src/content/docs/agent-insights/`) so the next agent
  doesn't lose time to this.
- No tests are silently skipped to make it pass (don't quarantine your way out of
  an infra crash).

## Pointers

- Walker: `scripts/affected-tests.mjs`
- Shared vitest config: `libs/test-config/src/index.ts`
- Test conventions / homes: `CLAUDE.md` (§ "Where new tests go") + `apps/operator/TESTING.md`
- Quarantine mechanism (do NOT use to mask this): `quarantine.txt`

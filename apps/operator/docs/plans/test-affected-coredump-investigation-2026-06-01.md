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

### Open decision (with avi)

Genuine `lib/**` test-debt: rewrite the `db` mocks per-file, OR convert the
Drizzle-querying units to real-PG integration tests, OR push one through fully
as the reference pattern then fan out. Contamination: separate root-cause pass.
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

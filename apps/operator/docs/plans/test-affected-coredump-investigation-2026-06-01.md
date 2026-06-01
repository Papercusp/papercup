---
title: "Investigation brief: `npm run test:affected` core-dumps (Node 25 + vitest worker pool)"
slug: test-affected-coredump-investigation-2026-06-01
status: draft
created: 2026-06-01
owner: unassigned
tags: [test-infra, vitest, node-version, ci]
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

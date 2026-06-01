---
title: Handoff brief — P-054 (mirror tooldef to a libs/generic submodule) — DECIDED, attempted, reverted; here's how to finish it
slug: BRIEF-tooldef-P054-handoff-2026-05-31
status: shipped
created: 2026-05-31
owner: avi@storewolf.com
related: [papercusp-tooldef-extraction-2026-05-29, BRIEF-tooldef-shared-repo-2026-05-30]
updated: 2026-06-01
---

# Handoff — finishing P-054 (tooldef → `libs/generic` submodule)

> For the next agent. Self-contained. The `@papercusp/tooldef` extraction
> (plan `papercusp-tooldef-extraction-2026-05-29`) is **complete through Phase 6**.
> The **only** remaining item is **P-054** (distribution). It is **decided** but its
> first execution attempt was **reverted**. This brief tells you the decision, the exact
> current state, why the attempt failed, and the precise steps + preconditions to finish.

## TL;DR

- **Decision (avi, 2026-05-31):** Option B — papercup consumes `@papercusp/tooldef`
  (+`tooldef-http`) as a standalone **`libs/generic/*` git submodule** of
  `github.com/Papercusp/tooldef`, matching the borrowable-lib convention (like
  `libs/generic/ipc-endpoint-server`). **Not** npm-publish. `tooldef-mcp` stays
  papercup-internal; `agent-mcp` stays in-tree and keeps re-exporting the engine (D-010).
  Recorded as **D-011** in the extraction plan.
- **Current tree state: clean + green, fully in-tree** (the conversion did NOT land —
  it was reverted). Verify before starting (see "Current state" below).
- **An attempt on 2026-05-31 was reverted** after a half-applied state got swept into a
  peer commit. Nothing reached the shared repo. Read "Why the attempt failed" — the lessons
  are the whole point of this brief.
- **Two hard preconditions before you start** (both currently UNMET):
  1. `Papercusp/tooldef` shared repo must be reconciled to in-tree HEAD (the push is
     **non-fast-forward** — genuine divergence, owner's call; do NOT `--force`).
  2. Run it in a **tree-quiet window with reliable tooling**, coordinated with the active
     tooldef dev (`claude-su-dcc1793e`), and commit the conversion **atomically**.

## Current state (verify this first — HEAD moves constantly on this shared tree)

As of HEAD `a8f583eb6` (2026-05-31), confirmed:

```
packages/tooldef/src/index.ts        PRESENT, committed in HEAD   ✓ in-tree
libs/generic/tooldef                 GONE (submodule removed)     ✓
.gitmodules                          0 tooldef entries            ✓ clean
node_modules/@papercusp/tooldef  ->  ../../packages/tooldef       ✓ in-tree symlink
tooldef tsc 0 / 219 tests · tooldef-mcp 5/5 · tooldef-http 3/3 · agent-mcp resolves tooldef ✓
```

Re-confirm with:
```bash
[ -f packages/tooldef/src/index.ts ] && echo INTREE_OK
[ -e libs/generic/tooldef ] && echo "SUBMODULE PRESENT (unexpected)" || echo NO_SUBMODULE_OK
git cat-file -e HEAD:packages/tooldef/src/index.ts && echo COMMITTED_OK
```
Restore point if anything is wrong: tag **`tooldef-preconvert-restore`** (`307c5d53b`,
pre-surgery HEAD; includes the tooldef-mcp `agentRoles` fix) →
`git checkout tooldef-preconvert-restore -- packages/tooldef`.

A small fix that's already landed and must NOT be lost: `packages/tooldef-mcp/src/index.test.ts`
uses `agentRoles:` (not stale `roles:`) — the `tool.roles → tool.agentRoles` rename (commit
`a67bc5cdc`) had missed it. Re-committed at `5454e349b`. If you see `roles: ['architect']`
there again (merge churn re-orphaned it), re-apply: `agentRoles: ['architect']`.

## Why the first attempt failed (read before retrying — these are the traps)

1. **Shared-repo sync push was rejected (non-FF), correctly.** A fresh
   `git subtree split --prefix=packages/tooldef` pushed to `Papercusp/tooldef main` was
   **rejected** — shared main (`60d6cc38`) has commits the split base lacks, AND in-tree has
   commits shared lacks (the auth-RFC Phase 1-3 + the `agentRoles` rename were never synced).
   **Genuine divergence → needs a real reconcile/merge by the shared-repo owner, never a
   `--force`** (Restart depends on that repo). No `--force` was used; the shared repo is
   intact and unmodified.
2. **A staged-but-uncommitted destructive change got swept into a peer's commit.** I ran
   `git rm -r packages/tooldef` + `git submodule add … libs/generic/tooldef`, but the
   build-config edits **failed to apply** (Edit "file not read first" errors, missed amid
   tool-output flakiness). Before I caught it, a peer's `git commit` packaged my *staged*
   rm+submodule-add (the shared-tree commit model — "whatever's staged lands in someone's
   commit"), leaving `main` momentarily with `@papercusp/tooldef` unresolvable.
3. **Environment was flaky.** This session had intermittent tool-output truncation/duplication
   and transient MCP outages. That's what let the half-state slip through. **Do not attempt
   this conversion in a flaky session** — it has destructive, shared-tree, outward-facing steps.

**The meta-lesson:** on this shared, always-on-`main` tree, the conversion's destructive steps
**cannot be left staged-uncommitted even briefly**. Stage the *entire* atomic change (rm +
submodule + every config edit) and commit it in **one shot**, or do it in a genuinely quiet
window. Verify every Edit actually applied (don't trust the absence of an error in noisy output).

## The execution runbook (Option B)

**Preconditions (both UNMET right now):**
- **(P1) Reconcile `Papercusp/tooldef` → in-tree HEAD.** Owner: the active tooldef dev
  (`claude-su-dcc1793e`) who manages that repo. The divergence must be merged so shared main
  == the subtree split of in-tree `packages/tooldef`. Coordinate via `coord:*`; do not race them.
- **(P2) Create `Papercusp/tooldef-http`.** It does **not** exist yet. `git submodule add`
  needs the remote to exist first. (Decide: own repo — matches one-lib-one-repo — vs. a
  `tooldef-http` subpath of the shared repo. Lean: own repo.)

**Steps (commit atomically — all in one commit):**
1. Tag a fresh restore point: `git tag -f tooldef-preconvert-restore HEAD`.
2. Confirm `packages/tooldef` is clean (`git status --porcelain -- packages/tooldef` empty)
   and lock the file set across the whole op + commit:
   `locks:acquire { paths: ['packages/tooldef','libs/generic/tooldef','.gitmodules','tsconfig.base.json','apps/operator/vitest.config.ts','scripts/affected-tests.mjs','knip.json','package.json'], intent:'P-054 conversion', ttl_sec:1800 }`.
3. `git rm -r packages/tooldef`; `git submodule add https://github.com/Papercusp/tooldef.git libs/generic/tooldef`
   (pin to the reconciled shared main from P1). Repeat for tooldef-http if doing it this pass.
4. **Rewire build refs — these are the exact edits (the ones that failed last time):**
   - `tsconfig.base.json` — **2 lines**: `"@papercusp/tooldef": ["packages/tooldef/src/index.ts"]`
     → `["libs/generic/tooldef/src/index.ts"]`, and `"@papercusp/tooldef/*": ["packages/tooldef/*"]`
     → `["libs/generic/tooldef/*"]`.
   - `apps/operator/vitest.config.ts` — **2 alias lines**: the two
     `replacement: resolve(__dirname, '../../packages/tooldef…')` → `'../../libs/generic/tooldef…'`.
   - `scripts/affected-tests.mjs` — the map key `'packages/tooldef': ['@papercusp/tooldef']`
     → `'libs/generic/tooldef': ['@papercusp/tooldef']`.
   - `knip.json` — the `"packages/tooldef": { … }` key → `"libs/generic/tooldef"`.
   - **`package.json` workspaces** — `packages/tooldef` was covered by the `packages/*` glob;
     `libs/generic/tooldef` is **NOT** auto-globbed. Add `"libs/generic/tooldef"` to the
     `workspaces` array (mirrors `"libs/generic/ipc-endpoint-server"`, which IS listed). *(This
     was missed in the original D-011 step list — verify it's needed for your resolution path.)*
   - Re-point the symlink: `rm node_modules/@papercusp/tooldef && ln -s ../../libs/generic/tooldef node_modules/@papercusp/tooldef`.
5. **CI:** ensure `.github/workflows/*` checks out submodules (`submodules: recursive` or an
   explicit `git submodule update --init`). Verify the affected-tests walker + knip handle the
   new path.
6. **Verify before committing:** tooldef tsc 0 + 219 tests (from `libs/generic/tooldef`),
   tooldef-mcp 5/5, tooldef-http 3/3, `agent-mcp` tsc = 19 baseline (a resolution break would be
   100s of "Cannot find module '@papercusp/tooldef'"), operator typecheck no new errors, the
   P-051 standalone examples, `npm run test:affected`, and a live `:3070` boot.
7. **Commit atomically**, release locks.
8. **Post-conversion docs:** the agent-insight `tooldef-authorization-model.mdx` has a section
   "packages/tooldef is in-tree here; the shared mirror is peer-owned" that becomes FALSE —
   rewrite it. There are also ~30 `packages/tooldef/src/...` path pointers across
   `endpoint-system/*.mdx` + agent-insights that go stale (same kind of path-accuracy pass P-052
   did). Remember Starlight docs don't hot-reload: `cd apps/operator-docs && npm run build` and
   commit the regenerated `apps/operator/public/internal/docs/` mirror.
9. Update **`BORROWABLE.md`** + `scripts/gen-borrowable-catalog.mjs` (add a `libs/generic/tooldef`
   row, IPC/transport or its own group) and re-run `npm run gen:borrowable`.
10. Advance **Restart's** `libs/tooldef` pin to the reconciled shared main (or flag the Restart
    owner if that checkout isn't reachable).
11. Mark P-054 `done` in the extraction plan + `plans:lint { harness:'papercup' }` + coord broadcast.

## Why the move itself is sound (the mechanics verified before the sweep)

During the attempt, before the peer sweep, the converted state actually built clean: engine
resolved from `libs/generic/tooldef`, all ~42 direct + ~607 agent-mcp-re-export consumers
resolved (agent-mcp tsc stayed at the 19-error baseline, zero "Cannot find module"), tooldef
219 + tooldef-http 3 green. So the **conversion mechanics are correct**; only the shared-tree
*choreography* (atomic commit + reliable tooling + synced shared repo) failed. You're finishing
a proven move, not debugging an unknown one.

## Pointers

- Extraction plan + D-011 + the 2026-05-31 incident Progress entry:
  [[papercusp-tooldef-extraction-2026-05-29]]
- Original shared-repo brief: [[BRIEF-tooldef-shared-repo-2026-05-30]]
- Shared repo: `github.com/Papercusp/tooldef` (private). Restart wiring:
  `Restart:docs/plans/tooldef-adoption-restart-2026-05-30.md`.
- Drift discipline until conversion lands: any `packages/tooldef` edit must also reach
  `Papercusp/tooldef` (owner: `claude-su-dcc1793e`) or Restart goes stale.

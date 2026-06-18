# Your change reaches :3070 through an async, self-healing pipeline — don't babysit it
URL: /internal/docs/agent-insights/deploy-pipeline-is-async-self-healing

Agents repeatedly get confused getting changes live: they edit, re-check :3070 (which serves GREEN main, not their staging edit), conclude 'my change didn't ship', then either thrash trying to 'submit' it (git-sync owns commit/push) or self-diagnose a red gate and grind the WRONG target. The pipeline is automatic + self-healing: git-sync commits→staging, green-checkpoint runs test:affected and FFs main, release-trigger deploys main→:3070 with auto-rollback; a red gate auto-dispatches a release-fixer and git-sync conflicts go to merge-resolver/content-fixer (the 'deployer' role already exists as this fixer family — no new role). The reflex is dev:pipeline_position (NOT a browser) to locate your change, and a non-blocking coord:escalate on a genuine stall. Every spawned role already carries this as the shared DEPLOY_PIPELINE_NOTE.

## The mistake this prevents

A single red gate this session drew **three conflicting diagnoses from three agents**
(a tsc ratchet that doesn't gate deploys / a load-flake / stale gateway tests) and
nobody had the authoritative picture. The recurring confusion has a few shapes:

* **"My change didn't ship"** — you edit a file, re-open `:3070`, don't see it, and
  conclude it was lost. `:3070` serves **green `main`**, not your staging edit.
* **Thrashing to "submit"** — there is nothing to submit. A background **git-sync**
  routine commits + pushes the whole tree. You never run `git add/commit/push`.
* **Self-diagnosing a stalled gate** — you see the gate red and start grinding an
  unrelated error "to unblock deploys". A stall is almost always **shared-fate**
  (a peer's failing test, a flake under load), not your change, and a **release-fixer**
  is already auto-dispatched to handle it.

## The pipeline (async, \~minutes, two ports)

You leave an edit in the tree. Then, automatically:

1. **git-sync** commits the whole shared tree and pushes to `origin/staging`
   (you do **not** `git add/commit/push`; don't stash/branch/worktree to isolate "your" diff).
2. **green-checkpoint** runs the gate suite — **`npm run test:affected`** (NOT
   `lint`/`tsc`; a tsc ratchet does **not** gate deploys) — and fast-forwards `main` when green.
3. **release-trigger** deploys `main` → the live `:3070` operator with auto-rollback.

Two ports: **`:3070` = green `main`** (deployed), **`:3170` = staging**. Never edit the
`papercup-release/` or `*-checkpoint/` trees — they are clobbered by the pipeline.

## The "deployer" already exists — as the fixer family

There is **no separate deployer role**, and you shouldn't build or wait on one. The
pipeline self-heals through wired launch blueprints (all in `BUILTIN_LAUNCH_BLUEPRINTS`):

* **release-fixer** — auto-dispatched on `green-checkpoint:red`
  (`release-actions.ts` → `resolveLaunchTargetForEvent('green-checkpoint:red', …)`),
  deduped by failure signature, escalates to a human after N reds. It classifies
  regression-vs-flake then fixes or quarantines.
* **merge-resolver** / **content-fixer** — dispatched on git-sync conflicts.

You do **not** own diagnosing or fixing a deploy stall.

## The reflex: `dev:pipeline_position`, not a browser

To see where your change is (**committed → staging → main → deployed**) and whether
the gate is stalled, call:

```
dev:pipeline_position { path: "packages/.../your-file.ts" }   // or { sha }
```

It is **read-only** and available to **every** execution/judgment role (operator, queen,
the eight pipeline roles, bee, sentinel, overwatch, and the fixers). That one read is the
answer to "did my edit go live?" — not opening `:3070`.

## On a genuine stall: escalate non-blocking, then move on

Your committed change is **safe on staging** and ships automatically when the gate
clears. If `dev:pipeline_position` shows a genuine stall:

* **Do not block** waiting for it, and **do not** grind unrelated errors.
* `coord:escalate` (advisory, **non-blocking**) and continue with other work.

The self-healing dispatch is **best-effort** (a fire-and-forget loopback invoke that
warns-on-fail, a 2h signature-dedup, a short-lived fixer that may exit before
`coord:presence` sees it), so a fixer occasionally "no-shows". That is dispatch
fragility, **not** missing wiring — still non-blocking for you.

## When you actually need to debug a wedged pipeline

This doc is orientation. If `main` and `:3070` are genuinely frozen on hours-old code,
the deep runbook is
[Deploy pipeline silently stalled: the dead-executor dedup wedge](/internal/docs/agent-insights/deploy-pipeline-silent-stall-dead-executor-dedup)
— it separates the two failure layers (green-checkpoint FF vs. release-trigger deploy)
and shows how to clear a DBOS dead-executor dedup.

## Where this lives in code

The cross-role guidance is sourced once as the **`DEPLOY_PIPELINE_NOTE`** constant
(`libs/papercusp/packages/orchestrator/src/prompt-build.ts`) and spliced into both prompt
bases — the spawned-bee base and the operator-launched-role base (via
`renderDeployPipelineNote` in `packages/operator-core/lib/deploy-pipeline-policy.ts`) — so
the two can't desync. Every spawned agent already carries it.

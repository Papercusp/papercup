# Release gating — a green `ready` branch the restart script deploys

Implements plan **`release-gate-ready-branch-2026-06-04`**. Decouples *what the
fleet runs* from *the churning working tree*: a green **`ready`** ref accumulates
vetted commits, and a single **deploy chokepoint** moves it into a separate
**release checkout** the operator runs from — at a clean time, reversibly.

```
integration branch (main) ──git-sync (all WIP, every ~3 min)──►  churns continuously
      │  green-checkpoint: fast-forward `ready` to the latest GREEN commit
      ▼
   ready (green)  ──────────────────────────────────────────────►  the deployable state
      │  THE DEPLOY (the only path that changes what-runs):
      │    drain → snapshot → swap release checkout to ready → apply staged
      │    migrations → restart → health + path-verify → broadcast   (rollback on failure)
      ▼
   release checkout  ────────────────────────────────────────────►  what the operator runs
   (/home/marsh-office/papercupai-workspace/papercup-release)
```

A restart can **never** deploy raw churning HEAD by construction.

## Why a separate checkout works (Phase 0)

The operator has no hot-reload, so the runtime is already pinned to whatever was on
disk at its last restart. We formalize that into a separate git worktree at
`PAPERCUSP_RELEASE_ROOT`. Runtime file reads (prompts, SQL, docs) are all
`process.cwd()`/`__dirname`-relative with **no** hardcoded absolute repo paths, so
running the operator with `cwd = <release>/apps/operator` makes every read resolve
under the release checkout automatically. `verify-release-paths.ts` asserts this.

The checkout is built by `bin/release/setup-release-checkout.sh`:
- a `git worktree` (shares the object store → submodule pins that were never pushed
  to origin are still reachable),
- **submodule source** extracted at each pinned sha via `git archive` from the
  integration tree's local objects (real, isolated files — not hardlinks, because
  the fleet edits submodule source),
- **node_modules** hardlink-copied (cheap; safe because it isn't hand-edited; the
  relative workspace symlinks resolve intra-release-tree).

## The pieces (all `tsx`-runnable standalone, even when the operator is down)

| File | Role |
|---|---|
| `bin/release/setup-release-checkout.sh` | Build/sync the release (or checkpoint) checkout to a ref. |
| `lib/release/git-ops.ts` | Git primitives — `ready` only ever **fast-forwards**. |
| `lib/release/green-checkpoint.ts` | Phase 1: run the suite in an isolated checkout of the candidate; FF `ready` if green. |
| `lib/release/deploy.ts` + `deploy-deps.ts` + `deploy-cli.ts` | Phase 2: the chokepoint orchestration + real wiring + CLI. |
| `lib/release/migrate.ts` | D-007: deploy-time migration apply, **fail-loud**. |
| `lib/release/health-probe.ts` | D-011d: post-restart `/api/health` poll. |
| `lib/release/verify-release-paths.ts` | Phase 0: assert runtime reads resolve under the release checkout. |
| `lib/release/rollback.ts` | D-008: standalone revert (release ref + snapshot) + restart. |
| `lib/release/seed-release-routines.ts` | Seed the green-checkpoint + release-trigger routines (INACTIVE). |
| `packages/operator-core/lib/harness/routines/release-actions.ts` | The `system:green-checkpoint` + `system:release-trigger` handlers. |
| `libs/papercusp/packages/harness/prompts/release-manager.md` | D-011: the Opus-4.8-xhigh release-manager agent's playbook. |

## Operating it

```bash
# Review what would deploy (no side effects) — the release-manager reads this first:
npx tsx apps/operator/lib/release/deploy-cli.ts

# Deploy the green `ready` (needs PAPERCUSP_ALLOW_DEV_RESTART=1 for the real restart):
PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute

# D-009 escape hatch — deploy a specific UN-GREEN commit (loud + audited):
PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --deploy-commit <sha> --execute

# Advance `ready` to the latest green integration commit:
npx tsx apps/operator/lib/release/green-checkpoint.ts

# Roll back the last deploy:
PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/rollback.ts --execute
```

Agent-driven (D-011): the **release-manager** role (Claude Opus 4.8 @ `xhigh`, via
`AGENT_MODELS["release-manager"]`) owns the go/no-go + migration-risk + post-deploy
rollback judgment. Launch it interactively with `psu --role release-manager`, or let
the `system:release-trigger` routine dispatch it.

## Migration discipline (Phase 3)

- Allocate numbers with **`db:next-migration`** (atomic `migration_reservations` +
  advisory lock) — never hand-pick an `NNN` (it caused the `131` collision).
- Migrations apply **only at deploy** (fail-loud, atomically with their code) — stop
  running `psql -f` against the live DB out of band. The boot-time apply
  (`db-boot-migrate`) stays log-and-continue so a broken peer migration never wedges
  the shared dev-api; the **deploy** apply is fail-loud → a bad migration aborts the
  deploy and rolls back.

## ✅ The cutover happened (2026-06-05) — the standing two-port model

The live operator **runs from the release checkout**: `papercup-dev-api.service`
(`:3070`) has `WorkingDirectory=…/papercup-release/apps/operator` and
`PAPERCUSP_INTEGRATION_ROOT=…/papercup` in its unit env. A second **staging
operator** `papercup-staging-api.service` (`:3170`) runs from the integration
tree (`main`, DBOS/routines disabled) so server-side edits can be tested live
without touching the stable host:

- **Test a `lib/**` edit:** `systemctl --user restart papercup-staging-api.service`,
  probe `:3170`.
- **Promote to `:3070`:** the deploy chokepoint above (green-checkpoint → `deploy-cli
  --execute`). A raw `:3070` restart just reboots the same green snapshot.
- **Revert the cutover** (if ever needed): repoint `WorkingDirectory` back to
  `…/papercup/apps/operator`, `daemon-reload`, restart (≈30s recovery).

**Spawn-path invariant (step-4 audit, done 2026-06-05):** anything that spawns an
agent or resolves "the repo" must target the **integration tree**, not the release
checkout — `PAPERCUSP_INTEGRATION_ROOT` is the declared seam. `release-config.ts`,
`release-actions.ts`, `setup-release-checkout.sh`, `detectPapercupRoot()` (ambient
mode — covers `plans:launch/resume` cwd + harness registration) and
`console-launcher.ts`'s scripts-dir all honor it. Keep new spawn sites on that seam.

## Routine posture: deploys stay deliberate (decided 2026-06-05)

- **`green-checkpoint` — ACTIVE, hourly** (`0 15 * * * *`). It never deploys: it
  fast-forwards `ready` when `main` is green and broadcasts 🟩/🟥 — a continuous
  main-health signal plus a fresh `ready` for whenever a deliberate deploy happens.
  (Re-cadenced from the original 10-min seed to respect the shared box.)
- **`release-trigger` — INACTIVE.** This is the auto-deploy path (it dispatches the
  release-manager to make a go/no-go call). The owner's posture is that **deploys
  stay deliberate**: a human (or an explicitly-launched release-manager via
  `psu --role release-manager`) runs `deploy-cli --execute`. Graduate it later with
  `npx tsx apps/operator/lib/release/seed-release-routines.ts --active` once
  auto-deploy trust is earned (D-010).

`seed-release-routines.ts` encodes these per-routine defaults — running it with no
flags (re)applies the decided posture.

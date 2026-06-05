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

## ⚠ The cutover (owner-gated — NOT done automatically)

Everything above is built + tested, and the green-checkpoint / release-trigger
routines are seeded **INACTIVE**. The live operator still runs from the integration
tree. Flipping it to run from the release checkout changes deploy semantics for the
**whole running fleet** (a peer's `dev:restart` would stop picking up their lib edits
— they'd use the deploy/escape-hatch instead), so it should happen when the fleet is
quiesced and aware. The cutover is one reversible step:

1. Build/refresh the release checkout at the current `ready`:
   `bash apps/operator/bin/release/setup-release-checkout.sh --ref ready`
2. Repoint the systemd unit's `WorkingDirectory` to
   `…/papercup-release/apps/operator` (`systemctl --user edit papercup-dev-api.service`),
   `daemon-reload`, `restart`.
3. Health-check `/api/health`; if bad, revert `WorkingDirectory` to
   `…/papercup/apps/operator` + restart (≈30s recovery).
4. Audit the remaining `process.cwd()`-based agent-spawn paths
   (`console-launcher.ts`) to confirm spawned agents still work in the integration
   tree, not the release checkout.
5. Activate the routines: `npx tsx apps/operator/lib/release/seed-release-routines.ts --active`.

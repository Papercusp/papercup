/**
 * release-checkpoint-launch — the agent-facing "fire the green-checkpoint NOW" lever's
 * launch primitive (WI-1320 follow-up: deploy-trigger-and-gate-unblock-2026-06-21).
 *
 * The gap it closes: the DEPLOY has a manual trigger (release:deploy op:trigger/force) and the
 * COMMIT routine now has one (git-sync:run) — but the GATE's verdict producer, the
 * `system:green-checkpoint` routine, only ever runs on its hourly cron (or via routines:set
 * pause/retune). So after fixing/quarantining reds there was no way to force a FRESH green
 * verdict now; you waited up to an hour for the next tick. This fires the SAME suite the cron
 * tick runs (apps/operator/lib/release/green-checkpoint.ts) on demand.
 *
 * Why DETACHED (mirrors release-deploy-launch.ts): the green-checkpoint suite runs the full
 * test battery under load for up to ~55 min — far past any MCP call budget — so an awaited
 * child would time out the tool. We launch it as a transient systemd unit (bounded by
 * RuntimeMaxSec so a hung suite can't run forever) and return once systemd-run accepts it; the
 * OUTCOME lands on /admin/git (the pipeline event the CLI emits), not this caller.
 *
 * OOM-safety: green-checkpoint.ts self-locks (its status vocabulary includes 'skipped-locked'),
 * so firing this while the cron tick's suite is mid-run just no-ops the second run rather than
 * spawning a SECOND concurrent 8-fork suite (which would OOM the box — see release-actions.ts).
 *
 * Scope: the operator-home (papercusp) gate — root = integrationRoot(), the regression-safe
 * default the routine uses for the home harness (empty per-hive overlay). Per-hive manual
 * checkpoints can extend this later (they'd thread resolveCheckpointRouting's extraEnv).
 */

import { spawn } from 'node:child_process';
import { integrationRoot, tsxBin, type SpawnLike } from './release-deploy-launch';

/**
 * The transient systemd unit the detached manual checkpoint runs as. DISTINCT from the deploy
 * unit (a checkpoint and a deploy are independent) — but a second manual checkpoint while one
 * is active is refused by systemd-run (same-unit collision), and a manual-vs-cron collision is
 * absorbed by green-checkpoint.ts's own lock ('skipped-locked').
 */
export const CHECKPOINT_UNIT = 'papercup-green-checkpoint-manual';

/** Wall-clock ceiling for the detached suite (systemd kills the unit past this). Mirrors the
 *  routine's in-process GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (55m) so a hung suite self-reaps. */
export const CHECKPOINT_MAX_RUNTIME_SEC = 55 * 60;

export interface LaunchCheckpointResult {
  launched: boolean;
  unit: string;
  /** systemd-run argv actually run (or that would be run). */
  argv: string[];
  logPath: string;
  /** Present on a launch failure (e.g. the unit already exists ⇒ a manual checkpoint is running). */
  reason?: string;
}

/** Pure: the full `systemd-run` argv for the detached green-checkpoint suite. Mirrors
 *  release-deploy-launch.ts's buildSystemdRunArgv (PATH passthrough so the unit doesn't depend
 *  on the systemd-manager env; PAPERCUSP_INTEGRATION_ROOT explicit like the deploy). Exported
 *  for unit-testing the command construction. */
export function buildCheckpointSystemdArgv(
  root: string,
  logPath: string,
  pathEnv: string,
  partialGreenGate = false,
): string[] {
  // Mirror the PERIODIC gate: the routine spawns green-checkpoint.ts with { ...process.env } so it
  // inherits PAPERCUSP_PARTIAL_GREEN_GATE (the longest-green-prefix FF). A MANUAL checkpoint runs via
  // `systemd-run --user`, which does NOT inherit the launching process env — so without this it always
  // ran whole-batch. Forward the flag into the inner command when the launcher itself has it set, so
  // release:checkpoint-run behaves the same as the scheduled gate.
  const gateEnv = partialGreenGate ? `PAPERCUSP_PARTIAL_GREEN_GATE='1' ` : '';
  const inner =
    `${gateEnv}PAPERCUSP_INTEGRATION_ROOT='${root}' '${tsxBin(root)}' ` +
    `apps/operator/lib/release/green-checkpoint.ts > ${logPath} 2>&1`;
  return [
    '--user',
    '--collect',
    `--unit=${CHECKPOINT_UNIT}`,
    `--property=RuntimeMaxSec=${CHECKPOINT_MAX_RUNTIME_SEC}`,
    `--working-directory=${root}`,
    `--setenv=PATH=${pathEnv}`,
    'bash',
    '-c',
    inner,
  ];
}

export interface LaunchCheckpointOpts {
  /** Integration tree root (default integrationRoot()). */
  root?: string;
}

/**
 * Fire the green-checkpoint suite as a DETACHED transient systemd unit. Returns once systemd-run
 * has accepted/refused the unit — the suite's VERDICT is reported on /admin/git (the pipeline
 * event green-checkpoint.ts emits), NOT by this caller.
 *
 * `spawnFn` is injectable so the tool handler is unit-testable without launching anything.
 */
export function launchDetachedCheckpoint(opts: LaunchCheckpointOpts = {}, spawnFn: SpawnLike = spawn): Promise<LaunchCheckpointResult> {
  const root = opts.root ?? integrationRoot();
  const logPath = `/tmp/${CHECKPOINT_UNIT}.log`;
  const argv = buildCheckpointSystemdArgv(
    root,
    logPath,
    process.env.PATH ?? '',
    process.env.PAPERCUSP_PARTIAL_GREEN_GATE === '1',
  );

  return new Promise<LaunchCheckpointResult>((resolve) => {
    const base: LaunchCheckpointResult = { launched: false, unit: CHECKPOINT_UNIT, argv, logPath };
    let stderr = '';
    const child = spawnFn('systemd-run', argv);
    child.stderr?.on('data', (d: unknown) => (stderr += String(d)));
    child.on('error', (e: unknown) => {
      resolve({ ...base, launched: false, reason: e instanceof Error ? e.message : String(e) });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ ...base, launched: true });
      } else {
        // Most common cause: the unit already exists ⇒ a manual checkpoint is already in flight.
        resolve({
          ...base,
          launched: false,
          reason: `systemd-run exited ${code} (a manual checkpoint may already be running): ${stderr.trim().slice(0, 200)}`,
        });
      }
    });
  });
}

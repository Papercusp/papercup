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

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { integrationRoot, tsxBin, type SpawnLike } from './release-deploy-launch';

/**
 * The transient systemd unit the detached manual checkpoint runs as. DISTINCT from the deploy
 * unit (a checkpoint and a deploy are independent) — but a second manual checkpoint while one
 * is active is refused by systemd-run (same-unit collision), and a manual-vs-cron collision is
 * absorbed by green-checkpoint.ts's own lock ('skipped-locked').
 */
export const CHECKPOINT_UNIT = 'papercup-green-checkpoint-manual';

/** PER-ROOT manual-checkpoint unit name (2026-07-01): the bare CHECKPOINT_UNIT
 *  made every repo's manual gate serialize on ONE systemd unit name — a peer
 *  hive's 55-minute run held THIS repo's `release:checkpoint-run` hostage (and
 *  vice versa), observed live when papercup's manual run blocked papercusp's
 *  post-fix re-verdict for ~an hour. Suffixing a short root hash keeps the
 *  same-root duplicate guard ("unit already exists ⇒ a run is in flight")
 *  while letting DIFFERENT roots run concurrently — they already isolate via
 *  their own checkouts + MemoryMax'd transient units. Exported for tests. */
export function checkpointUnitForRoot(root: string): string {
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) >>> 0;
  return `${CHECKPOINT_UNIT}-${h.toString(36)}`;
}

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
  /** Present when `reason === 'already_running'` — the structured detail of the live run
   *  (WI-1562: a bare `reason` string left concurrent callers with no clean way to tell
   *  "this refused because one is already in flight, don't retry" from a transient spawn
   *  failure — they'd retry / manually kill what they assumed was stuck). */
  alreadyRunning?: ActiveCheckpointCheck;
}

/** Detail of a live (already-active) manual checkpoint run for THIS root, or its absence. */
export interface ActiveCheckpointCheck {
  active: boolean;
  unit: string;
  /** Best-effort candidate sha the live run is judging (parsed from its log's first
   *  "checkpointing candidate <sha>" line) — null if the log isn't readable yet/at all. */
  candidate?: string | null;
  /** Current integration checkout HEAD at status-read time. */
  current_head?: string | null;
  /** Current quiet-cut-eligible candidate at status-read time. May differ from `candidate`
   *  while a long checkpoint run is active and newer quiet commits landed after it started. */
  current_candidate?: string | null;
  /** True when the active run's parsed candidate is older/different than the current
   *  quiet-cut-eligible candidate. */
  candidate_stale?: boolean;
  /** Quiet-cut window used to resolve `current_candidate`; null when it could not be checked. */
  quiet_cut_sec?: number | null;
  /** ISO timestamp the unit actually started running (systemd ExecMainStartTimestamp). */
  started_at?: string | null;
  /** Seconds remaining before the suite's own runtime ceiling (CHECKPOINT_MAX_RUNTIME_SEC)
   *  would kill it — a rough "how much longer" estimate, not a promise. */
  eta_sec?: number | null;
}

/** Minimal shape of a `child_process.spawnSync` result — injectable so
 *  `checkActiveCheckpointRun` is unit-testable without a real systemctl call. */
export type ExecSyncLike = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

function defaultExecSync(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function defaultReadLogHead(logPath: string): string | null {
  try {
    // The candidate line is emitted first (`[green-checkpoint] checkpointing candidate …`);
    // a small head-read is enough and stays cheap even for a large/rotating log.
    return readFileSync(logPath, { encoding: 'utf8' }).slice(0, 4096);
  } catch {
    return null;
  }
}

function parseSystemctlShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function quietCutSecFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  if (env.PAPERCUSP_QUIET_CUT === '0') return 0;
  const v = Number(env.PAPERCUSP_QUIET_CUT_SEC);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 240;
}

function gitOutput(root: string, args: string[], execFn: ExecSyncLike): string | null {
  const r = execFn('git', ['-C', root, ...args]);
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}

function gitOk(root: string, args: string[], execFn: ExecSyncLike): boolean {
  return execFn('git', ['-C', root, ...args]).status === 0;
}

function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function currentCheckpointCandidate(root: string, execFn: ExecSyncLike): {
  current_head: string | null;
  current_candidate: string | null;
  quiet_cut_sec: number | null;
} {
  const currentHead = gitOutput(root, ['rev-parse', 'HEAD'], execFn);
  if (!currentHead) return { current_head: null, current_candidate: null, quiet_cut_sec: null };

  const quietSec = quietCutSecFromEnv();
  if (quietSec <= 0) return { current_head: currentHead, current_candidate: currentHead, quiet_cut_sec: quietSec };

  const tipTimeRaw = gitOutput(root, ['show', '-s', '--format=%ct', currentHead], execFn);
  const tipTime = tipTimeRaw == null ? NaN : Number(tipTimeRaw);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tipTime) || nowSec - tipTime >= quietSec) {
    return { current_head: currentHead, current_candidate: currentHead, quiet_cut_sec: quietSec };
  }

  const cutoff = String(nowSec - quietSec);
  const aged = gitOutput(root, ['rev-list', '-1', `--before=@${cutoff}`, 'HEAD'], execFn);
  if (!aged || aged === currentHead) return { current_head: currentHead, current_candidate: currentHead, quiet_cut_sec: quietSec };

  const ready = gitOutput(root, ['rev-parse', '--verify', 'ready'], execFn);
  if (ready && !gitOk(root, ['merge-base', '--is-ancestor', ready, aged], execFn)) {
    return { current_head: currentHead, current_candidate: currentHead, quiet_cut_sec: quietSec };
  }

  return { current_head: currentHead, current_candidate: aged, quiet_cut_sec: quietSec };
}

/**
 * Detect whether a manual checkpoint run for `root` is CURRENTLY ACTIVE, before we'd try to
 * launch a new one (WI-1562). Reads systemd's live unit state directly — rather than firing
 * `systemd-run` and parsing its refusal — so the caller gets a STRUCTURED answer (unit,
 * candidate, started_at, eta_sec) proactively instead of a bare "exited 1" string, and so
 * `launchDetachedCheckpoint` never has to attempt (and fail) the spawn just to find out.
 */
export function checkActiveCheckpointRun(
  root: string,
  execFn: ExecSyncLike = defaultExecSync,
  readLogHead: (logPath: string) => string | null = defaultReadLogHead,
): ActiveCheckpointCheck {
  const unit = checkpointUnitForRoot(root);
  const r = execFn('systemctl', [
    '--user',
    'show',
    `${unit}.service`,
    '--property=ActiveState',
    '--property=ExecMainStartTimestamp',
  ]);
  const props = parseSystemctlShow(r.stdout);
  const activeState = props.ActiveState ?? '';
  // 'active' = running; 'activating'/'reloading' = transient states of the same live unit.
  // A NEVER-STARTED or GC'd unit shows 'inactive' (or systemctl exits non-zero with empty
  // output for a truly unknown unit) — either way activeState won't be in this set.
  if (activeState !== 'active' && activeState !== 'activating' && activeState !== 'reloading') {
    return { active: false, unit };
  }
  const startedAt = props.ExecMainStartTimestamp && props.ExecMainStartTimestamp !== '' ? props.ExecMainStartTimestamp : null;
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : null;
  const etaSec = elapsedSec != null ? Math.max(0, CHECKPOINT_MAX_RUNTIME_SEC - elapsedSec) : null;
  const logHead = readLogHead(`/tmp/${unit}.log`);
  const candidateMatch = logHead?.match(/checkpointing candidate (\S+)/);
  const candidate = candidateMatch ? candidateMatch[1] : null;
  const current = currentCheckpointCandidate(root, execFn);
  return {
    active: true,
    unit,
    candidate,
    ...current,
    candidate_stale: Boolean(candidate && current.current_candidate && !shaMatches(candidate, current.current_candidate)),
    started_at: startedAt,
    eta_sec: etaSec,
  };
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
    `--unit=${checkpointUnitForRoot(root)}`,
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
  /** Skip the pre-launch active-run check (WI-1562) and attempt the launch regardless.
   *  systemd's own same-unit collision guard is still the final backstop — force does NOT
   *  stop/replace a genuinely active run, it only bypasses OUR proactive refusal. */
  force?: boolean;
}

/**
 * Fire the green-checkpoint suite as a DETACHED transient systemd unit. Returns once systemd-run
 * has accepted/refused the unit — the suite's VERDICT is reported on /admin/git (the pipeline
 * event green-checkpoint.ts emits), NOT by this caller.
 *
 * WI-1562: BEFORE spawning, check whether a run for this root is already active and, unless
 * `force:true`, refuse with a STRUCTURED `alreadyRunning` detail (unit/candidate/started_at/
 * eta_sec) instead of letting the caller find out only via systemd-run's bare exit-1 string.
 * Two sus firing this ~8 minutes apart with no clear "don't retry" signal is exactly the
 * starvation this closes — the newest tip is auto-judged by the in-flight run's quiet-cut
 * anyway, so a re-fire is usually unnecessary (see the tool's guidance).
 *
 * `spawnFn`/`execFn`/`readLogHead` are injectable so the tool handler is unit-testable without
 * launching anything or shelling out to systemctl.
 */
export function launchDetachedCheckpoint(
  opts: LaunchCheckpointOpts = {},
  spawnFn: SpawnLike = spawn,
  execFn: ExecSyncLike = defaultExecSync,
  readLogHead: (logPath: string) => string | null = defaultReadLogHead,
): Promise<LaunchCheckpointResult> {
  const root = opts.root ?? integrationRoot();
  const unit = checkpointUnitForRoot(root);
  const logPath = `/tmp/${unit}.log`;

  if (!opts.force) {
    const active = checkActiveCheckpointRun(root, execFn, readLogHead);
    if (active.active) {
      return Promise.resolve({
        launched: false,
        unit,
        argv: [],
        logPath,
        reason: 'already_running',
        alreadyRunning: active,
      });
    }
  }

  const argv = buildCheckpointSystemdArgv(
    root,
    logPath,
    process.env.PATH ?? '',
    process.env.PAPERCUSP_PARTIAL_GREEN_GATE === '1',
  );

  return new Promise<LaunchCheckpointResult>((resolve) => {
    const base: LaunchCheckpointResult = { launched: false, unit, argv, logPath };
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

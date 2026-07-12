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
 * child would time out the tool. We launch it as a transient systemd unit with a loose
 * RuntimeMaxSec backstop (well above the suite timeout) so systemd never preempts a healthy
 * long run; the suite's own timeout still produces the verdict if it truly runs too long.
 * The OUTCOME lands on /admin/git (the pipeline event the CLI emits), not this caller.
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

/** Wall-clock ceiling for the detached suite's systemd backstop.
 *
 * Keep this strictly ABOVE the suite's own in-process timeout (55m) so the suite itself
 * still emits a red/verdict path if it genuinely overruns; the systemd cap is only a guard
 * against a truly wedged launch path, not the primary timeout.
 */
export const CHECKPOINT_MAX_RUNTIME_SEC = 3 * 60 * 60;

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
  /** EI-9672: set when `replaceStale:true` found the active run CONFIRMED stale and stopped
   *  it before this launch — the detail of what was stopped, for the caller's audit trail. */
  replacedStale?: ActiveCheckpointCheck;
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
  /** Seconds remaining before the systemd backstop (CHECKPOINT_MAX_RUNTIME_SEC)
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

/** Default MainPID liveness probe: `kill(pid, 0)` — succeeds iff a process with that PID
 *  currently exists (and we have permission to signal it), without actually signalling it.
 *  Injectable so `checkActiveCheckpointRun` is unit-testable without touching real PIDs. */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (genuinely dead). EPERM means a process WITH that PID exists
    // but we can't signal it (e.g. owned by another user) — that still proves it's alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Detect whether a manual checkpoint run for `root` is CURRENTLY ACTIVE, before we'd try to
 * launch a new one (WI-1562). Reads systemd's live unit state directly — rather than firing
 * `systemd-run` and parsing its refusal — so the caller gets a STRUCTURED answer (unit,
 * candidate, started_at, eta_sec) proactively instead of a bare "exited 1" string, and so
 * `launchDetachedCheckpoint` never has to attempt (and fail) the spawn just to find out.
 *
 * EI-9180: under extreme host load, systemd's own `--user` manager bookkeeping can lag well
 * behind reality (observed: an 18h phantom-wedge — ActiveState kept reading 'active' for a run
 * whose process was already gone, and every re-fire got refused with a stable, unchanging
 * started_at/eta_sec from the original dead run). Trusting ActiveState alone lets a KILLED run
 * (OOM, a manual `kill -9` outside systemd, a host-load-starved systemd manager that hasn't
 * processed the child's SIGCHLD yet) permanently wedge the gate — nothing self-heals it short of
 * an agent noticing and passing `force:true`. Cross-check with a real OS-level liveness probe
 * (`kill(pid, 0)`) on the unit's own MainPID: if systemd still claims 'active' but the PID it
 * itself reports is provably gone, the ActiveState is stale — treat the run as NOT active so the
 * gate self-heals on the very next fire instead of staying wedged until someone force-bypasses it.
 */
export function checkActiveCheckpointRun(
  root: string,
  execFn: ExecSyncLike = defaultExecSync,
  readLogHead: (logPath: string) => string | null = defaultReadLogHead,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
): ActiveCheckpointCheck {
  const unit = checkpointUnitForRoot(root);
  const r = execFn('systemctl', [
    '--user',
    'show',
    `${unit}.service`,
    '--property=ActiveState',
    '--property=ExecMainStartTimestamp',
    '--property=MainPID',
  ]);
  const props = parseSystemctlShow(r.stdout);
  const activeState = props.ActiveState ?? '';
  // 'active' = running; 'activating'/'reloading' = transient states of the same live unit.
  // A NEVER-STARTED or GC'd unit shows 'inactive' (or systemctl exits non-zero with empty
  // output for a truly unknown unit) — either way activeState won't be in this set.
  if (activeState !== 'active' && activeState !== 'activating' && activeState !== 'reloading') {
    return { active: false, unit };
  }
  // EI-9180 self-heal: MainPID=0 means systemd has no main process to report (nothing to
  // cross-check — fall through and trust ActiveState as before). A NONZERO MainPID that
  // `kill(pid, 0)` proves is gone means systemd's ActiveState is stale — don't trust it.
  const mainPid = Number(props.MainPID ?? '0');
  if (Number.isFinite(mainPid) && mainPid > 0 && !pidAlive(mainPid)) {
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
/** The stable, well-known path readers poll (`/tmp/<unit>.log`). It is a SYMLINK to the
 *  newest run's own log — see checkpointRunLogPath. */
export function checkpointLatestLogPath(unit: string): string {
  return `/tmp/${unit}.log`;
}

/** A PER-RUN log path. The gate used to write every run to `/tmp/<unit>.log`, so the
 *  natural response to a red — re-fire — truncated the very output the red was telling
 *  you to read (2026-07-10: run #5's failure detail destroyed by the re-fire it
 *  prompted). Each run now owns a timestamped file; `checkpointLatestLogPath` symlinks
 *  to it, so every existing reader of the stable path keeps working. */
export function checkpointRunLogPath(unit: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `/tmp/${unit}-${stamp}.log`;
}

export function buildCheckpointSystemdArgv(
  root: string,
  logPath: string,
  pathEnv: string,
  partialGreenGate = false,
  /** When given, the run writes HERE and `logPath` is repointed at it as a symlink. */
  runLogPath?: string,
): string[] {
  // Mirror the PERIODIC gate: the routine spawns green-checkpoint.ts with { ...process.env } so it
  // inherits PAPERCUSP_PARTIAL_GREEN_GATE (the longest-green-prefix FF). A MANUAL checkpoint runs via
  // `systemd-run --user`, which does NOT inherit the launching process env — so without this it always
  // ran whole-batch. Forward the flag into the inner command when the launcher itself has it set, so
  // release:checkpoint-run behaves the same as the scheduled gate.
  const gateEnv = partialGreenGate ? `PAPERCUSP_PARTIAL_GREEN_GATE='1' ` : '';
  // Write to the per-run file and point the stable path at it (`ln -sfn`, so a symlink
  // left by a previous run is replaced, not followed into). The redirect binds to the
  // green-checkpoint command only — the symlink is created first, so a reader polling
  // the stable path during startup follows it to the file this run is about to fill.
  const target = runLogPath ?? logPath;
  const link = runLogPath ? `ln -sfn '${runLogPath}' '${logPath}' && ` : '';
  const inner =
    `${link}${gateEnv}PAPERCUSP_INTEGRATION_ROOT='${root}' '${tsxBin(root)}' ` +
    `apps/operator/lib/release/green-checkpoint.ts > ${target} 2>&1`;
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
  /** EI-9672: when the active run is CONFIRMED stale (`candidate_stale` — it's judging an
   *  older candidate than the current quiet-cut-eligible staging state, e.g. it's deep in
   *  post-verdict work like the longest-green-prefix salvage or an auto-refire chain on a
   *  candidate a newer commit has since superseded), stop that unit and launch a fresh run
   *  for the current candidate instead of refusing. Distinct from — and safer than — `force`:
   *  `force` blindly attempts a launch that systemd still refuses (the WI-1562/EI-9672
   *  repro — "force still failed because systemd refused the loaded singleton"); this
   *  actually frees the singleton, but ONLY for the stale case. A run judging the CURRENT
   *  candidate is never stopped, even with replaceStale:true — that's the CRITICAL danger
   *  the original investigation flagged (never suppress/kill a legitimately in-flight,
   *  still-relevant verdict). No supported "cancel" existed before this; the only prior path
   *  was a human running `systemctl --user stop` by hand, then relaunching. */
  replaceStale?: boolean;
}

/** EI-9672: best-effort `systemctl --user stop` on a checkpoint unit — the piece that was
 *  previously ONLY a manual, undocumented escape hatch ("no checkpoint cancel verb exists").
 *  Never throws; a failure just means the subsequent launch attempt sees the same collision
 *  it would have seen anyway (no regression vs today). */
export function stopActiveCheckpointUnit(
  unit: string,
  execFn: ExecSyncLike = defaultExecSync,
): { stopped: boolean; reason?: string } {
  const r = execFn('systemctl', ['--user', 'stop', `${unit}.service`]);
  if (r.status === 0) return { stopped: true };
  return { stopped: false, reason: r.stderr.trim().slice(0, 300) || `systemctl stop exited ${r.status}` };
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
  // `logPath` stays the stable, well-known path (readers + the alreadyRunning probe use
  // it); the run itself writes to its own timestamped file behind that symlink.
  const logPath = checkpointLatestLogPath(unit);
  const runLogPath = checkpointRunLogPath(unit);
  let replacedStale: ActiveCheckpointCheck | undefined;

  if (!opts.force) {
    const active = checkActiveCheckpointRun(root, execFn, readLogHead);
    if (active.active) {
      // EI-9672: a CONFIRMED-stale active run (judging an older candidate than the current
      // quiet-cut-eligible staging state — e.g. deep in post-verdict salvage/refire on a
      // superseded candidate) can be replaced instead of refused. Deliberately narrow: a
      // run judging the CURRENT candidate is never touched, replaceStale or not.
      if (opts.replaceStale && active.candidate_stale) {
        const stop = stopActiveCheckpointUnit(unit, execFn);
        if (stop.stopped) {
          // Re-check right before launching — a race where the run finished/advanced
          // between our stop and now is handled by the normal already_running path below
          // (systemd-run's own collision refusal is still the final backstop either way).
          replacedStale = active;
        } else {
          return Promise.resolve({
            launched: false,
            unit,
            argv: [],
            logPath,
            reason: 'already_running',
            alreadyRunning: active,
          });
        }
      } else {
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
  }

  const argv = buildCheckpointSystemdArgv(
    root,
    logPath,
    process.env.PATH ?? '',
    process.env.PAPERCUSP_PARTIAL_GREEN_GATE === '1',
    runLogPath,
  );

  return new Promise<LaunchCheckpointResult>((resolve) => {
    // Report the RUN's own path: it is the file that survives the next re-fire, and the
    // one an agent should quote when triaging this verdict.
    const base: LaunchCheckpointResult = {
      launched: false,
      unit,
      argv,
      logPath: runLogPath,
      ...(replacedStale ? { replacedStale } : {}),
    };
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

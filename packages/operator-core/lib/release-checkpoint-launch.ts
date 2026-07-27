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
import { homedir } from 'node:os';
import * as path from 'node:path';
import { integrationRoot, tsxBin, type SpawnLike } from './release-deploy-launch';
import { gateVerdictEnv, type GateVerdictTarget } from './release/gate-verdict-target';
import {
  callerEditsInCandidate,
  excludedCommitsTouchingPath,
  gitReadFromExecSync,
  uncommittedPaths,
  type MissingReason,
  type PathContainment,
} from './candidate-contains';

/**
 * WI-4494: the harness whose gate a MANUAL checkpoint run judges — stamped into the detached unit's
 * env so the run RECORDS ITS OWN VERDICT instead of discarding it.
 *
 * This is the launcher whose verdicts were being thrown on the floor: it fires the full suite,
 * green-checkpoint.ts computes a real green/red — and, because only ROUTINE-invoked runs wrote
 * gate_health, nobody wrote it down. Meanwhile this run holds the run-lock, so the hourly routine
 * fire that COULD have recorded one gets `skipped-locked` instead. The gate then can't produce a
 * verdict at all while manual runs are in flight (observed live 2026-07-12: 3 consecutive fires
 * skipped, release pin frozen ~10h). See release/gate-verdict-target.ts.
 *
 * Scope matches this module's: the operator-home gate (root = integrationRoot()), so the target is
 * the operator-home harness. Fail-safe — if either half won't resolve we stamp nothing, the run
 * doesn't record, and the routine records exactly as it did before.
 */
function resolveHomeGateTarget(): GateVerdictTarget | null {
  try {
    const { activeWorkspaceId } = require('./workspace-registry') as typeof import('./workspace-registry');
    const { operatorHomeHarnessSlug } = require('./harness/operator-home-harness') as typeof import('./harness/operator-home-harness');
    const workspaceId = activeWorkspaceId();
    const installSlug = operatorHomeHarnessSlug();
    if (!workspaceId || !installSlug) return null;
    return { workspaceId, installSlug };
  } catch {
    return null;
  }
}

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
  /** WI-5124: which commit this launch will ACTUALLY judge, computed the same way the run
   *  itself resolves it (quiet-cut applied) — set on every launch attempt (successful or
   *  refused), so a caller who just committed a fix and re-fires can see, from the REPLY
   *  alone, whether their fix is IN or EXCLUDED from this run. Absent only if the git reads
   *  themselves failed (current_head null). */
  willJudge?: {
    /** The commit that will be judged (post quiet-cut). */
    candidate: string | null;
    /** The true tip of the integration branch BEFORE any quiet-cut step-back. */
    tip: string | null;
    /** Did the quiet-cut step the candidate back from the tip? */
    quietCutApplied: boolean;
    /** The quiet window (seconds) in effect; 0/null when disabled. */
    quietCutSec: number | null;
    /** One-line `sha subject` entries for commits strictly newer than `candidate` — i.e. NOT
     *  judged by this run (your just-landed fix may be in here). Empty when quietCutApplied
     *  is false. Best-effort (BENIGN RACE, WI-5124): computed at launch time; the detached
     *  process re-resolves its own candidate ~1-2s later and a git-sync tick in that gap can
     *  shift it — this is "will judge as of launch", not a guarantee. */
    excludedCommits: string[];
  };
}

/** Detail of a live (already-active) manual checkpoint run for THIS root, or its absence. */
export interface ActiveCheckpointCheck {
  active: boolean;
  unit: string;
  /** Best-effort candidate sha the live run is judging. For the manual-unit case, parsed
   *  from its log's first "checkpointing candidate <sha>" line (null if the log isn't
   *  readable yet/at all). For the `held_externally` case (see below), resolved instead
   *  from the isolated checkpoint checkout's own HEAD — null only if THAT tree doesn't
   *  exist or isn't readable. Either way: the sha this field reports IS what the live run
   *  is judging, never a hypothetical "if launched now" value (see `current_candidate`). */
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
  /** Seconds since the unit started — null when systemd did not report a start timestamp. */
  elapsed_sec?: number | null;
  /** Seconds remaining before the systemd backstop (CHECKPOINT_MAX_RUNTIME_SEC)
   *  would kill it — a rough "how much longer" estimate, not a promise. */
  eta_sec?: number | null;
  /** EI-11667: set when a `replaceStale:true` request found the run stale but YOUNGER than
   *  REPLACE_STALE_MIN_AGE_SEC — the stop was refused (a young stale run is healthy-in-progress
   *  on a busy tree, not wedged; see the constant's doc for the 2026-07-13 replace-storm). */
  replace_refused_young?: boolean;
  /** WI-5685: true when this active run was detected via the shared file-based RUN LOCK, not
   *  the manual systemd unit — almost certainly the hourly cron tick (or another out-of-band
   *  invocation). The holder's own log path isn't known, so `candidate` is instead resolved
   *  from the checkpoint checkout's own HEAD (best-effort — see `candidate`'s doc comment);
   *  `candidate_stale` is HARD-CODED false regardless of what that resolves to (EI-11667/
   *  EI-18695275971973546 safety: even a genuinely-stale externally-held run must never be
   *  reported replaceable — there is no manual unit here to stop, so `force`/`replaceStale`
   *  CANNOT free this slot; either would just spawn a second process that loses the exact
   *  same lock race a moment later and produces no verdict either). The only remedy is to
   *  wait for it (checkpoint:await, no candidateSha — its outcome covers your commit too as
   *  long as your commit is an ancestor of whatever it judges). `current_candidate`/
   *  `candidate_stale` describe a HYPOTHETICAL fresh launch, never this in-flight run. */
  held_externally?: boolean;
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

/** WI-5124: one-line `sha subject` entries for commits strictly newer than `from` up to (and
 *  including) `to` — the sync/execFn counterpart of git-ops.ts's async `commitsBetween`, for
 *  reporting `willJudge.excludedCommits` on a launch. `from === to` (nothing excluded) short-
 *  circuits without a git call. */
function commitsBetweenSync(root: string, from: string, to: string, execFn: ExecSyncLike): string[] {
  if (from === to) return [];
  const out = gitOutput(root, ['log', '--oneline', '--no-decorate', `${from}..${to}`], execFn);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** WI-5124: exported so `launchDetachedCheckpoint` can report `willJudge` on a fresh launch,
 *  not just (via `checkActiveCheckpointRun`) on an already-running refusal. Same quiet-cut
 *  resolution the run itself applies (green-checkpoint.ts's inline logic) — kept as a
 *  SEPARATE sync/execFn-based implementation rather than importing apps/operator/lib/release's
 *  async git-ops one: this operator-core module must not depend on apps/operator (the wrong
 *  dependency direction — see checkpointPipelineName's comment for the same constraint). */
export function currentCheckpointCandidate(root: string, execFn: ExecSyncLike): {
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

/** Mirrors green-checkpoint.ts's PER-ROOT run-lock dir hash+path
 *  (apps/operator/lib/release/green-checkpoint.ts's `checkpointRunLockDir`) — duplicated here,
 *  READ-ONLY, for the same "operator-core must not depend on apps/operator" reason
 *  `checkpointPipelineName`/`checkpointUnitForRoot` already duplicate their own hash (see
 *  those doc comments). Keep the hash algorithm and the `.green-checkpoint-run-<hash>.lock`
 *  name in sync BY HAND with green-checkpoint.ts — a drift here means this probe silently
 *  checks the wrong path and always reports "not held", even while a real run holds the lock. */
function checkpointRunLockDirMirror(logDir: string, root: string): string {
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) >>> 0;
  return path.join(logDir, `.green-checkpoint-run-${h.toString(36)}.lock`);
}

/** Mirrors release-config.ts's `checkpointLogDir` default resolution (env override, else
 *  `~/.papercusp/checkpoint-logs`) — same duplication rationale as the lock-dir mirror above. */
function checkpointLogDirFromEnv(): string {
  return process.env.PAPERCUSP_CHECKPOINT_LOG_DIR ?? path.join(homedir(), '.papercusp', 'checkpoint-logs');
}

/** Mirrors release-config.ts's `checkpointRoot` derivation (env override, else
 *  `<parent-of-root>/<basename(root)>-checkpoint`) — same duplication rationale as the
 *  log-dir/lock-dir mirrors above (operator-core must not depend on apps/operator).
 *
 * EI-18695275971973546: used ONLY to resolve the ACTUAL in-flight candidate when a run is
 * `held_externally` (the hourly cron tick holds the run-lock, not our manual unit, so we have
 * no log to parse a candidate from). The isolated checkpoint checkout is pinned to its judged
 * candidate for the run's WHOLE duration (green-checkpoint.ts's setupTree checks it out once,
 * up front, before the suite runs) — so reading that tree's HEAD *is* reading the true judged
 * candidate, not a guess. Best-effort: a missing/mid-checkout tree just means `candidate` stays
 * null, same as before this fix. */
function checkpointRootMirror(root: string): string {
  return process.env.PAPERCUSP_CHECKPOINT_ROOT ?? path.join(path.dirname(root), `${path.basename(root)}-checkpoint`);
}

/** Default reader for the run-lock's `owner.json` — real fs; injectable for tests. Never
 *  throws: a missing/unreadable/malformed lock file just means "not held" (the common case —
 *  most of the time nothing is running). */
function defaultReadLockOwner(lockDir: string): { pid?: number; startedAt?: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')) as { pid?: number; startedAt?: string };
  } catch {
    return null;
  }
}

/**
 * WI-5685 root fix: is the green-checkpoint RUN LOCK — the file-based, per-root lock
 * `acquireCheckpointRunLock` in green-checkpoint.ts serializes EVERY invocation on, cron
 * (spawned as a plain child by release-actions.ts's `runScript`, no systemd unit at all) and
 * manual (`release:checkpoint-run`'s detached systemd unit) alike — currently held by a LIVE
 * process, regardless of whether that process is the manual unit `checkActiveCheckpointRun`
 * already knows how to see?
 *
 * This is the check `checkActiveCheckpointRun` was missing: it only ever probed the MANUAL
 * unit's own systemd state, so a launch fired while the HOURLY CRON tick held the (unit-less)
 * run lock sailed straight past that probe, `systemd-run` happily started a brand-new detached
 * process, and THAT process immediately lost the race for the exact same lock file and exited
 * `skipped-locked` within about a second — after `release:checkpoint-run` had already replied
 * `launched:true`. Two consecutive manual fires burned two full `checkpoint:await` windows this
 * way with zero verdict ever produced (WI-5685 evidence, 2026-07-20/21).
 */
function checkRunLockHeld(
  root: string,
  pidAlive: (pid: number) => boolean,
  readLockOwner: (lockDir: string) => { pid?: number; startedAt?: string } | null,
): { held: boolean; pid?: number | null; started_at?: string | null; elapsed_sec?: number | null } {
  const lockDir = checkpointRunLockDirMirror(checkpointLogDirFromEnv(), root);
  const owner = readLockOwner(lockDir);
  if (!owner || typeof owner.pid !== 'number' || !pidAlive(owner.pid)) return { held: false };
  const startedMs = owner.startedAt ? Date.parse(owner.startedAt) : NaN;
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : null;
  return { held: true, pid: owner.pid, started_at: owner.startedAt ?? null, elapsed_sec: elapsedSec };
}

/**
 * WI-4310: a CHEAP (no subprocess) "is a green-checkpoint run active right now" probe —
 * just `checkRunLockHeld` with real defaults wired in. Unlike `checkActiveCheckpointRun`
 * below (which forks `systemctl show` for the manual-unit ActiveState check), this reads
 * only the file-based run-lock's `owner.json`, so it is cheap enough for a HOT health-panel
 * read path (git-pipeline-stats.ts's `includeActiveRun` gate exists precisely because the
 * systemctl fork is NOT cheap enough for that — see its doc comment) — e.g. the workFeed
 * dead-routine window (system-health/compute.ts), which needs "is the checkpoint's known,
 * self-recovering resource footprint active right now" on every computation, not just an
 * opt-in background snapshot.
 *
 * Deliberately narrower than `checkActiveCheckpointRun`: it misses a manual-unit run that
 * hasn't (yet) raced for the shared run-lock, but every run — manual or cron — holds the
 * SAME lock for the run's whole duration (`acquireCheckpointRunLock` in green-checkpoint.ts),
 * so in practice this sees every genuinely in-flight suite. Fail-soft: `defaultReadLockOwner`
 * never throws (a missing/unreadable lock file just reads as "not held").
 */
export function isCheckpointRunLockHeldCheap(
  root: string,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
  readLockOwner: (lockDir: string) => { pid?: number; startedAt?: string } | null = defaultReadLockOwner,
): { held: boolean; elapsedSec: number | null } {
  const r = checkRunLockHeld(root, pidAlive, readLockOwner);
  return { held: r.held, elapsedSec: r.elapsed_sec ?? null };
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
  readLockOwner: (lockDir: string) => { pid?: number; startedAt?: string } | null = defaultReadLockOwner,
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
    // WI-5685: the manual unit isn't active, but the shared RUN LOCK might still be held by a
    // process that never went through the manual unit at all (the hourly cron tick — see the
    // checkRunLockHeld doc comment). Cross-check it before declaring nothing active.
    const lockHeld = checkRunLockHeld(root, pidAlive, readLockOwner);
    if (lockHeld.held) {
      const current = currentCheckpointCandidate(root, execFn);
      // EI-18695275971973546: resolve the REAL in-flight candidate from the isolated
      // checkpoint checkout's own HEAD (see checkpointRootMirror's doc comment) instead of
      // reporting `candidate: null` — a null here was being misread as "this run's candidate
      // is unknowable", pushing callers toward `current_candidate` (a HYPOTHETICAL fresh-launch
      // value) as if it described the running suite, which cost a wrong "this can go green"
      // broadcast to the whole fleet. Best-effort: stays null if the checkpoint tree can't be read.
      const externalCandidate = gitOutput(checkpointRootMirror(root), ['rev-parse', 'HEAD'], execFn);
      return {
        active: true,
        unit: `${unit} (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)`,
        candidate: externalCandidate,
        ...current,
        // Deliberately NOT derived from externalCandidate vs current_candidate — see the
        // held_externally doc comment (EI-11667 safety): even a genuinely-stale externally-held
        // run must never be reported replaceable.
        candidate_stale: false,
        started_at: lockHeld.started_at ?? null,
        elapsed_sec: lockHeld.elapsed_sec ?? null,
        eta_sec: lockHeld.elapsed_sec != null ? Math.max(0, CHECKPOINT_MAX_RUNTIME_SEC - lockHeld.elapsed_sec) : null,
        held_externally: true,
      };
    }
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
    elapsed_sec: elapsedSec,
    eta_sec: etaSec,
  };
}

/** EI-11667 replace-storm guard: an in-flight run judging a "stale" candidate is the NORMAL
 *  state of a HEALTHY young run on a busy tree — the suite needs ~20-55 min while the tip moves
 *  every few minutes, so `candidate_stale` alone is not evidence of a wedged run. On 2026-07-13
 *  four sus each followed the "pass replaceStale:true" nudge and serially killed each other's
 *  runs (21:25→22:02); no verdict landed and the green pin froze for 2h. replaceStale therefore
 *  only unlocks once the run is old enough that it plausibly SHOULD have verdicted already (the
 *  true EI-9672 wedged-salvage case); younger runs — and runs whose age systemd cannot report —
 *  are refused with `replace_refused_young` so callers wait for the verdict instead. */
export const REPLACE_STALE_MIN_AGE_SEC = 20 * 60;

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
  /** WI-4494: when given, the run RECORDS ITS OWN VERDICT for this harness (gate_health + the
   *  pipeline event) instead of discarding it. Omitted ⇒ pre-WI-4494 behaviour (the caller records
   *  — which for a detached manual run meant nobody did). */
  verdictTarget?: GateVerdictTarget | null,
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
  // WI-4494: a detached unit does NOT inherit the launcher's env (same reason the partial-green
  // flag above has to be forwarded explicitly), so the record target must be passed as --setenv or
  // the run has no idea whose gate it is judging and silently declines to record.
  const verdictEnv = verdictTarget
    ? Object.entries(gateVerdictEnv(verdictTarget)).map(([k, v]) => `--setenv=${k}=${v}`)
    : [];
  return [
    '--user',
    '--collect',
    `--unit=${checkpointUnitForRoot(root)}`,
    `--property=RuntimeMaxSec=${CHECKPOINT_MAX_RUNTIME_SEC}`,
    `--working-directory=${root}`,
    `--setenv=PATH=${pathEnv}`,
    ...verdictEnv,
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
  /** WI-4494: the harness whose gate this run judges — the run stamps its OWN verdict into that
   *  harness's gate_health + pipeline history instead of discarding it. Omitted ⇒ the operator-home
   *  gate (this launcher's scope). Pass `null` to explicitly launch a NON-recording run. */
  target?: GateVerdictTarget | null;
}

/**
 * P-004 (EI-18752644493166307) — "does the candidate this run judges contain MY edits?"
 *
 * The reply already names the candidate. Naming a sha answers a question the caller
 * cannot check: an agent knows exactly which FILES it edited and nothing about which
 * commit carries them. So the answer is computed here, in path-space, and returned
 * with the launch — the moment of the mistake, which is the only place it helps.
 * (Prose could not: the filer of EI-18752644493166307 had restated the correct rule
 * to the owner an hour before making both mistakes.)
 *
 * Deliberately a SEPARATE async function rather than folded into
 * `launchDetachedCheckpoint`: that function's steps from the active-run check to
 * `spawnFn` must stay in ONE tick (see the `cancelStaleAwaits` comment — a caller that
 * spawns and immediately drives the child's events would otherwise race a listener
 * that is not attached yet). An `await` in there would break every test in that file
 * and, worse, intermittently in production. So the tool calls this AFTER the launch
 * resolves.
 */
export interface CheckpointContainment {
  /** The commit whose containment these verdicts describe. */
  candidateSha: string | null;
  /** The integration tip at the time of the check (null when unresolvable). */
  tipSha: string | null;
  /** Where the checked path-set came from — caller-declared beats inferred. */
  source: 'caller-supplied' | 'uncommitted-working-tree';
  /** Paths the candidate carries byte-identically to the working tree. */
  included: string[];
  /** Paths it does NOT carry. A red on any of these is NOT evidence your fix failed. */
  missing: string[];
  /** Paths whose containment could not be determined — never counted as included. */
  unknown: string[];
  /** Per-path verdict + the lever for each miss. */
  paths: PathContainment[];
  /**
   * The RESOLUTION of the old "if your fix is among them": for each checked path, the
   * excluded commits (candidate..tip) that actually touch it. Empty when the quiet-cut
   * excluded nothing, or excluded nothing of yours.
   */
  excludedCommitsTouchingYourFiles: { path: string; commits: string[] }[];
  /** One hard-warning line when `missing` is non-empty; null when everything is in. */
  warning: string | null;
}

export async function checkpointCandidateContainment(args: {
  root?: string;
  candidateSha: string | null;
  tipSha?: string | null;
  /** The files the caller's change touches. Omitted ⇒ inferred from the working tree. */
  paths?: string[];
  execFn?: ExecSyncLike;
}): Promise<CheckpointContainment> {
  const root = args.root ?? integrationRoot();
  const execFn = args.execFn ?? defaultExecSync;
  const git = gitReadFromExecSync(execFn, root);

  // A caller that names its files gets an EXACT answer. One that doesn't gets the
  // objectively-hazardous set instead: anything uncommitted is invisible to every
  // committed candidate, so it needs no attribution to be worth warning about. That
  // inference is what makes this fire for the caller who did not know to ask.
  const source: CheckpointContainment['source'] = args.paths?.length ? 'caller-supplied' : 'uncommitted-working-tree';
  const paths = args.paths?.length ? args.paths : await uncommittedPaths(git);

  const verdict = await callerEditsInCandidate(git, args.candidateSha, paths);
  const tipSha = args.tipSha ?? null;

  const excludedCommitsTouchingYourFiles: { path: string; commits: string[] }[] = [];
  if (args.candidateSha && tipSha && args.candidateSha !== tipSha) {
    for (const p of verdict.missing) {
      const commits = await excludedCommitsTouchingPath(git, args.candidateSha, tipSha, p);
      if (commits.length) excludedCommitsTouchingYourFiles.push({ path: p, commits });
    }
  }

  return {
    candidateSha: args.candidateSha,
    tipSha,
    source,
    included: verdict.included,
    missing: verdict.missing,
    unknown: verdict.unknown,
    paths: verdict.paths,
    excludedCommitsTouchingYourFiles,
    warning: verdict.missing.length ? renderContainmentWarning(verdict.missing, verdict.paths, excludedCommitsTouchingYourFiles, source) : null,
  };
}

/**
 * The warning text. Kept pure + exported so the PHRASING — which is the entire
 * deliverable of P-004 — is unit-testable without a repo, a systemd unit, or a launch.
 *
 * It must do one thing above all: pre-empt the misread. A candidate without your fix
 * reds on the pre-fix failure with the pre-fix count, and the natural reading of that
 * is "my fix didn't work". Every branch below therefore says, explicitly, that a red
 * from this run is not evidence about your change.
 */
export function renderContainmentWarning(
  missing: string[],
  paths: PathContainment[],
  excluded: { path: string; commits: string[] }[],
  source: CheckpointContainment['source'],
): string {
  const byReason = (r: MissingReason) => missing.filter((p) => paths.find((x) => x.path === p)?.reason === r);
  const uncommitted = [...byReason('uncommitted'), ...byReason('absent')];
  const newer = byReason('newer-commit');
  const list = (xs: string[]) => `${xs.slice(0, 6).join(', ')}${xs.length > 6 ? ` (+${xs.length - 6} more)` : ''}`;

  const parts: string[] = [
    `⚠ THIS RUN WILL NOT SEE ${missing.length} of your file(s). A RED from it is NOT evidence your change failed — the suite is testing code WITHOUT it, so it reds on the ORIGINAL failure with the ORIGINAL count.`,
  ];
  if (uncommitted.length) {
    parts.push(
      `NOT COMMITTED (invisible to the gate, which checks out a commit and cannot see the working tree): ${list(uncommitted)}. Fix: git-sync:run, then re-fire.`,
    );
  }
  if (newer.length) {
    parts.push(
      `COMMITTED BUT NEWER THAN THE CANDIDATE (the quiet-cut stepped the judged commit back): ${list(newer)}. Fix: wait out the quiet window (~4 min) and re-fire, or let the next run pick it up.`,
    );
  }
  for (const e of excluded.slice(0, 4)) {
    parts.push(`'${e.path}' is carried by EXCLUDED commit(s): ${e.commits.slice(0, 3).join(' | ')}`);
  }
  if (source === 'uncommitted-working-tree') {
    parts.push(
      'These were inferred from the working tree, not declared — pass `paths: [...]` naming the files your change touches for an exact verdict.',
    );
  }
  return parts.join(' ');
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

/** WI-4957: local mirror of green-checkpoint.ts's `pipelineName` — this operator-core module
 *  must not depend on apps/operator (wrong dependency direction; apps/operator depends on
 *  operator-core, not the reverse), so the tiny pure sanitizer is duplicated here exactly like
 *  agent-tools/release/trace.ts already does for the identical reason. Keep in sync by hand;
 *  it is a one-line sanitizer that changes essentially never. */
function checkpointPipelineName(root: string): string {
  return (path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9_-]/g, '-') || 'default').slice(0, 64);
}

/**
 * WI-4957 — retire pending checkpoint-family `events:await` registrations bound (via
 * candidateSha payload_filter) to a candidate whose run we just KILLED (the EI-9672
 * `replaceStale` stop below) before it could ever produce a verdict.
 *
 * Without this, `checkpoint:await { candidateSha }` registered against that exact
 * candidate has no way to learn its run is dead — it sleeps on, indistinguishable from
 * "still judging", until its own timeout. That indistinguishable window is the hazard:
 * a stray/out-of-order delivery for a sha whose run was superseded must never be
 * mistakable for a live verdict that could authorize a deploy. See
 * events/await/engine.ts's cancelSupersededCandidateAwaits for the exact (narrow,
 * payload-filter-matched) cancellation rule.
 *
 * Exported + the 5th positional param of launchDetachedCheckpoint below so this is
 * injectable/unit-testable without a real events:await store. Best-effort/fail-soft:
 * never blocks the fresh launch it runs ahead of.
 */
export async function cancelStaleCheckpointAwaits(
  root: string,
  staleCandidateSha: string,
): Promise<{ cancelled: number }> {
  try {
    // Dynamic ESM import, not require(): a runtime `require()` of a sibling TS module is
    // NOT reliably resolvable under this repo's ESM/vitest module graph (confirmed live —
    // it threw `Cannot find module` under vitest even though the file exists, and a
    // vi.mock on this path silently never applied to it either, since vi.mock only
    // intercepts the import graph). `import()` is the same seam every other lazy
    // cross-module load in this release/* code already uses (see green-checkpoint.ts's
    // deps.emitEvent).
    const { cancelSupersededCandidateAwaits } = await import('./events/await/engine');
    const pipeline = checkpointPipelineName(root);
    const result = await cancelSupersededCandidateAwaits({
      keys: ['release:green', `release:green:${pipeline}`, 'green-checkpoint:red', `green-checkpoint:red:${pipeline}`],
      staleCandidateSha,
    });
    return { cancelled: result.cancelled };
  } catch (e) {
    console.error(
      `[release-checkpoint-launch] stale-await cancellation failed (non-fatal — the fresh run still launches): ${e instanceof Error ? e.message : e}`,
    );
    return { cancelled: 0 };
  }
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
 * launching anything or shelling out to systemctl. `cancelStaleAwaits` (WI-4957) is likewise
 * injectable so the replaceStale path's await-cancellation is testable without a real DB.
 */
export function launchDetachedCheckpoint(
  opts: LaunchCheckpointOpts = {},
  spawnFn: SpawnLike = spawn,
  execFn: ExecSyncLike = defaultExecSync,
  readLogHead: (logPath: string) => string | null = defaultReadLogHead,
  cancelStaleAwaits: (root: string, staleCandidateSha: string) => Promise<{ cancelled: number }> = cancelStaleCheckpointAwaits,
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
        // EI-11667: only a run OLD enough to plausibly be wedged (past the fastest full-suite
        // duration) may be replaced. A young stale run is healthy-in-progress on a busy tree;
        // stopping it is how the 2026-07-13 replace-storm starved the gate of every verdict.
        const oldEnough =
          typeof active.elapsed_sec === 'number' && active.elapsed_sec >= REPLACE_STALE_MIN_AGE_SEC;
        if (!oldEnough) {
          return Promise.resolve({
            launched: false,
            unit,
            argv: [],
            logPath,
            reason: 'already_running',
            alreadyRunning: { ...active, replace_refused_young: true },
          });
        }
        const stop = stopActiveCheckpointUnit(unit, execFn);
        if (stop.stopped) {
          // Re-check right before launching — a race where the run finished/advanced
          // between our stop and now is handled by the normal already_running path below
          // (systemd-run's own collision refusal is still the final backstop either way).
          replacedStale = active;
          // WI-4957: the run we just killed will NEVER produce a verdict for its candidate —
          // retire any events:await bound to it now, rather than leaving a wait that can only
          // ever time out (and, until it does, is indistinguishable from "still judging").
          // Deliberately NOT awaited: this function's remaining synchronous steps (build argv,
          // spawn, attach the child's event listeners) must run in the SAME tick — a caller
          // that spawns the child and immediately drives its events (every test in this file
          // does exactly that) would otherwise race a listener that isn't attached yet. The
          // cancellation itself is already fail-soft/best-effort (see cancelStaleCheckpointAwaits),
          // so firing it without blocking loses nothing.
          if (active.candidate) {
            void cancelStaleAwaits(root, active.candidate).catch(() => {});
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
    // WI-4494: this run records its own verdict. Explicit opt-out (`target: null`) is honoured;
    // omitted ⇒ the operator-home gate, which is this launcher's documented scope.
    opts.target === undefined ? resolveHomeGateTarget() : opts.target,
  );

  // WI-5124: resolve — right before launch, so it's as fresh as possible — which commit this
  // run will ACTUALLY judge, so the caller sees it in the REPLY instead of having to read the
  // detached process's own log to discover their just-landed fix was quiet-cut EXCLUDED. See
  // the LaunchCheckpointResult.willJudge doc for the benign launch-time-vs-run-time race this
  // does not (and cannot) close.
  const current = currentCheckpointCandidate(root, execFn);
  const willJudge: LaunchCheckpointResult['willJudge'] = {
    candidate: current.current_candidate,
    tip: current.current_head,
    quietCutApplied: Boolean(
      current.current_head && current.current_candidate && current.current_head !== current.current_candidate,
    ),
    quietCutSec: current.quiet_cut_sec,
    excludedCommits:
      current.current_head && current.current_candidate && current.current_head !== current.current_candidate
        ? commitsBetweenSync(root, current.current_candidate, current.current_head, execFn)
        : [],
  };

  return new Promise<LaunchCheckpointResult>((resolve) => {
    // Report the RUN's own path: it is the file that survives the next re-fire, and the
    // one an agent should quote when triaging this verdict.
    const base: LaunchCheckpointResult = {
      launched: false,
      unit,
      argv,
      logPath: runLogPath,
      willJudge,
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

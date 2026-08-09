/**
 * task-manager/control — the verbs (task-manager-no-escape-2026-07-27, P-014).
 *
 * Every destructive path in here exists to make ONE class of accident impossible.
 * On this box, killing processes has twice gone wrong the same way: a pattern
 * match (`pkill -f '<binary>'`) treated "looks like mine" as "is mine" and took
 * out the owner's live desktop window plus peer agents' test instances. And PID
 * wrap happens roughly daily under fleet load, so a recorded pid is not an
 * identity either.
 *
 * So there are exactly two ways to signal something here, and neither can hit a
 * stranger:
 *
 *   CONFINED   -> `systemctl --user kill <pc-taskId.scope>`. Addressed by CGROUP.
 *                 It takes the whole subtree (no orphaned grandchildren), and a
 *                 recycled pid is not reachable through it at all.
 *   UNCONFINED -> `process.kill(pid)` ONLY after re-reading the kernel identity
 *                 and confirming it still matches what the row recorded. A
 *                 mismatch REFUSES rather than proceeding.
 *
 * There is deliberately no third way, and no name/pattern matching anywhere.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readProcessIdentity } from '../process-identity';
import { absCgroupDir, nodeCgroupFs, walkCgroupTree, type CgroupFs } from './cgroup-read';
import { closeTask, getSubtree, getTask } from './store';
import { isLiveOwnedState, type TaskRow } from './types';

// Lazily promisified (NOT `const execFileAsync = promisify(execFile)` at module
// scope): this module is reachable via a transitive import chain from test files
// that narrowly mock `node:child_process` for their own subprocess assertions —
// under such a mock the `execFile` import binding resolves to `undefined`, and
// eagerly calling `promisify(undefined)` at module-eval time throws for every such
// suite, even ones that never call `systemctl` (lint:no-eager-execfile-promisify /
// EI-10161; same pattern as watchdog.ts's `execFileP`). Deferring the promisify to
// first actual call means a transitive importer that never exercises this function
// never pays the cost. The function form (not a `const`) is also what lets
// `ControlDeps.execFileAsync?: typeof execFileAsync` keep working unchanged below.
type ExecFileAsync = (
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let cachedExecFileAsync: ExecFileAsync | null = null;
function execFileAsync(file: string, args: string[], opts?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  if (!cachedExecFileAsync) cachedExecFileAsync = promisify(execFile) as unknown as ExecFileAsync;
  return cachedExecFileAsync(file, args, opts);
}

export type ControlOutcome =
  | { ok: true; taskId: string; action: string; detail?: string }
  | { ok: false; taskId: string; action: string; error: ControlError; detail?: string };

export type ControlError =
  | 'task_not_found'
  | 'not_live' // already ended, or a residue classification we do not own
  | 'identity_mismatch' // the pid now belongs to something else — REFUSED
  | 'no_target' // neither a scope nor a verifiable pid
  | 'unsupported' // e.g. freeze on an unconfined task
  | 'command_failed'
  | 'incomplete'; // signal(s) sent, but the scope still holds processes after the verification window (EI-19478780721557822) — never `ok:true` on a bare "signalled"

export interface ControlDeps {
  execFileAsync?: typeof execFileAsync;
  fs?: CgroupFs;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  readIdentity?: (pid: number) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function deps(d: ControlDeps = {}): Required<Omit<ControlDeps, 'now'>> & { now: () => number } {
  return {
    execFileAsync: d.execFileAsync ?? execFileAsync,
    fs: d.fs ?? nodeCgroupFs,
    kill: d.kill ?? ((pid, signal) => process.kill(pid, signal)),
    readIdentity: d.readIdentity ?? readProcessIdentity,
    now: d.now ?? Date.now,
    sleep: d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

async function systemctl(args: string[], d: ReturnType<typeof deps>): Promise<{ ok: boolean; detail?: string }> {
  try {
    await d.execFileAsync('systemctl', ['--user', ...args], { timeout: 15_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 300) };
  }
}

/**
 * Verify a row's pid still IS the process the row describes.
 *
 * Returns the pid when safe to signal, or an error. A row that never captured an
 * identity is allowed through with `weak: true` — that is the honest state of
 * affairs for a pre-existing unconfined process, and the caller surfaces it —
 * but a row that HAS an identity and no longer matches is refused outright.
 */
export function verifyPidStillOurs(
  row: TaskRow,
  d: ReturnType<typeof deps>,
): { ok: true; pid: number; weak: boolean } | { ok: false; error: ControlError; detail?: string } {
  if (!row.pid) return { ok: false, error: 'no_target', detail: 'row has no pid' };
  const current = d.readIdentity(row.pid);
  if (row.processIdentity) {
    if (!current) {
      return { ok: false, error: 'identity_mismatch', detail: `pid ${row.pid} is gone` };
    }
    if (current !== row.processIdentity) {
      return {
        ok: false,
        error: 'identity_mismatch',
        detail: `pid ${row.pid} now holds identity ${current}, row recorded ${row.processIdentity} — refusing to signal a recycled pid`,
      };
    }
    return { ok: true, pid: row.pid, weak: false };
  }
  if (!current) return { ok: false, error: 'identity_mismatch', detail: `pid ${row.pid} is gone` };
  return { ok: true, pid: row.pid, weak: true };
}

export interface KillTaskOptions extends ControlDeps {
  /** Escalate SIGTERM -> SIGKILL after this long. 0 disables escalation. */
  escalateAfterMs?: number;
  signal?: NodeJS.Signals;
  /** Also signal every descendant TASK in the ledger tree. The cgroup kill already
   *  takes OS descendants; this is for logically-nested tasks that got their own
   *  scope (an agent's spawned children are their own scopes, not sub-cgroups). */
  includeSubtree?: boolean;
  /**
   * WI-37521: opt-in escape hatch for a TERMINAL ledger row whose cgroup scope
   * positively still holds live processes (the row closed — e.g. the launching
   * client exited — while its payload kept running; WI-37509 is the confirmed
   * source of this class). Without this flag a terminal row is refused exactly as
   * before (`not_live`) — this never widens the DEFAULT behaviour.
   *
   * Deliberately narrower than the live path in two ways, both load-bearing:
   *   1. Confined (cgroup-scope) rows ONLY. A terminal row's `pid` is not
   *      re-verifiable the way `verifyPidStillOurs` re-verifies a LIVE row's pid
   *      (a terminal row's `processIdentity` describes a process we already know
   *      exited under that scope; trusting a bare `pid` on it is exactly the
   *      recycled-pid hazard this module exists to prevent) — so the unconfined
   *      path stays refused unconditionally, reap or not.
   *   2. The scope must be POSITIVELY re-verified non-empty IN THIS CALL
   *      (`countScopeProcesses`, the same live cgroup walk `processes:list` uses)
   *      before anything is signalled — a terminal row whose scope has already
   *      gone quiet is not residue, it is just a terminal row, and stays refused.
   *
   * The row's OWN state is left untouched on success: `closeTask` is a no-op on
   * an already-`ended_at` row by design, and rewriting a `killed`/`exited`/etc.
   * row's terminal state to describe a LATER reap would misattribute history
   * rather than clarify it. The reap is reported in the outcome's `detail` and
   * (like every `processes:kill` call) in the audit log.
   */
  reapTerminalResidue?: boolean;
}

export async function killTask(taskId: string, opts: KillTaskOptions = {}): Promise<ControlOutcome> {
  const d = deps(opts);
  const row = await getTask(taskId);
  if (!row) return { ok: false, taskId, action: 'kill', error: 'task_not_found' };

  // Terminal row: refused by default (D-010 — residue is report-only unless a
  // caller explicitly asks to reap it AND we can positively re-verify it's real).
  let reapingResidue = false;
  if (!isLiveOwnedState(row.state)) {
    if (!opts.reapTerminalResidue) {
      return {
        ok: false,
        taskId,
        action: 'kill',
        error: 'not_live',
        detail: `state is ${row.state} — a residue or terminal row is never ours to signal`,
      };
    }
    if (!row.confined || !row.scopeUnit) {
      return {
        ok: false,
        taskId,
        action: 'kill',
        error: 'not_live',
        detail: `state is ${row.state} — reapTerminalResidue only supports a confined (cgroup) scope; this row is unconfined, so its pid cannot be safely re-verified`,
      };
    }
    if (countScopeProcesses(row, d) === 0) {
      return {
        ok: false,
        taskId,
        action: 'kill',
        error: 'not_live',
        detail: `state is ${row.state} — reap requested but scope ${row.scopeUnit} holds no live process right now; nothing to reap`,
      };
    }
    reapingResidue = true;
  }

  const signal = opts.signal ?? 'SIGTERM';

  if (opts.includeSubtree) {
    const tree = await getSubtree(row.rootTaskId);
    const descendants = tree.filter(
      (t) => t.taskId !== taskId && (isLiveOwnedState(t.state) || opts.reapTerminalResidue),
    );
    for (const t of descendants) {
      await killTask(t.taskId, { ...opts, includeSubtree: false });
    }
  }

  // ── the trustworthy path ────────────────────────────────────────────────
  if (row.confined && row.scopeUnit) {
    const res = await systemctl(['kill', `--signal=${signal}`, row.scopeUnit], d);
    if (!res.ok) {
      return { ok: false, taskId, action: 'kill', error: 'command_failed', detail: res.detail };
    }
    let escalated = false;
    if (opts.escalateAfterMs && opts.escalateAfterMs > 0) {
      await d.sleep(opts.escalateAfterMs);
      if (countScopeProcesses(row, d) > 0) {
        escalated = true;
        await systemctl(['kill', '--signal=SIGKILL', row.scopeUnit], d);
      }
    }
    // EI-19478780721557822: a `systemctl kill` exit code only proves the SIGNAL was
    // delivered, never that the subtree actually died — a re-parented / D-state /
    // otherwise unkillable descendant can survive both SIGTERM and an escalated
    // SIGKILL. Re-probe (bounded, not wall-clock — see waitForScopeEmpty) before
    // reporting anything, and never close the row as `killed` while it is not.
    const { empty, survivors } = await waitForScopeEmpty(row, d);
    if (!empty) {
      return {
        ok: false,
        taskId,
        action: 'kill',
        error: 'incomplete',
        detail: `scope ${row.scopeUnit} signalled ${signal}${escalated ? ' (escalated to SIGKILL)' : ''} but ${survivors} process(es) still alive after the verification window — task left LIVE (not closed) so a retry or a fresh listing can still find it`,
      };
    }
    if (reapingResidue) {
      // The row was ALREADY terminal (that's what let us reach this branch at
      // all) — `closeTask` no-ops on an `ended_at`-set row by design, and
      // rewriting its terminal state to describe a reap that happened LATER
      // would misattribute history rather than clarify it. Report the reap in
      // `detail` instead; the row's own state/exitReason stay exactly as they
      // were.
      return {
        ok: true,
        taskId,
        action: 'kill',
        detail: `TERMINAL-ROW REAP (WI-37521): scope ${row.scopeUnit} was verified holding live process(es) despite ledger state '${row.state}', signalled ${signal}${escalated ? ' (escalated to SIGKILL)' : ''} — now verified empty. The row's own state is left unchanged (already terminal).`,
      };
    }
    await closeTask(taskId, { state: 'killed', exitReason: `scope kill ${signal}${escalated ? ' (escalated)' : ''}` });
    return {
      ok: true,
      taskId,
      action: 'kill',
      detail: `scope ${row.scopeUnit} signalled ${signal}${escalated ? ' (escalated to SIGKILL)' : ''} — verified empty`,
    };
  }

  // ── the verified-pid path ───────────────────────────────────────────────
  const verdict = verifyPidStillOurs(row, d);
  if (!verdict.ok) {
    // The pid being GONE means the task already ended — close the row honestly
    // rather than reporting a failure the caller can do nothing about.
    if (verdict.error === 'identity_mismatch' && verdict.detail?.includes('is gone')) {
      await closeTask(taskId, { state: 'stranded', exitReason: 'process gone at kill time' });
    }
    return { ok: false, taskId, action: 'kill', error: verdict.error, detail: verdict.detail };
  }
  try {
    d.kill(verdict.pid, signal);
  } catch (e) {
    return { ok: false, taskId, action: 'kill', error: 'command_failed', detail: (e as Error).message };
  }
  await closeTask(taskId, { state: 'killed', exitReason: `pid kill ${signal}` });
  return {
    ok: true,
    taskId,
    action: 'kill',
    detail: verdict.weak
      ? `pid ${verdict.pid} signalled ${signal} (WEAK: row never captured a kernel identity)`
      : `pid ${verdict.pid} signalled ${signal}`,
  };
}

/** How many bounded re-probe retries to give a scope to actually empty after the
 *  final signal, and how long to wait between them. Retry-COUNT bounded, not
 *  wall-clock bounded, so a mocked `sleep` in tests resolves this instantly
 *  instead of busy-spinning against real `Date.now()`. 5×100ms = 500ms of real
 *  grace in production — SIGKILL reaping is normally sub-millisecond; this is
 *  slack for a loaded box, not an expectation of slow exits. */
const REPROBE_RETRIES = 5;
const REPROBE_POLL_MS = 100;

/** Deep pid count under a task's cgroup — walks nested child cgroups too (unlike
 *  a bare `readCgroupProcs`, which only reads the ONE directory named by
 *  `cgroupPath` and would miss anything a descendant delegated into a sub-cgroup
 *  of its own). This is the same walk `processes:list` uses to enumerate what is
 *  actually alive, so "did the kill work" and "what's running" can't disagree. */
function countScopeProcesses(row: TaskRow, d: ReturnType<typeof deps>): number {
  if (!row.cgroupPath) return 0;
  const pids = new Set<number>();
  for (const node of walkCgroupTree(absCgroupDir(row.cgroupPath), d.fs)) {
    for (const pid of node.pids) pids.add(pid);
  }
  return pids.size;
}

/** Re-probe up to REPROBE_RETRIES times (REPROBE_POLL_MS apart) for the scope to
 *  actually empty. Returns the LAST observed survivor count so a non-empty
 *  outcome can be reported honestly instead of as a bare "signalled". */
async function waitForScopeEmpty(
  row: TaskRow,
  d: ReturnType<typeof deps>,
): Promise<{ empty: boolean; survivors: number }> {
  let survivors = countScopeProcesses(row, d);
  for (let i = 0; i < REPROBE_RETRIES && survivors > 0; i++) {
    await d.sleep(REPROBE_POLL_MS);
    survivors = countScopeProcesses(row, d);
  }
  return { empty: survivors === 0, survivors };
}

/**
 * Pause / resume — the verb a process table cannot offer and a cgroup gives away
 * free. Under memory pressure, freezing the three fattest test runs beats killing
 * them: the work is not lost, and the box stops thrashing immediately.
 */
export async function freezeTask(taskId: string, opts: ControlDeps = {}): Promise<ControlOutcome> {
  return setFrozen(taskId, true, opts);
}

export async function thawTask(taskId: string, opts: ControlDeps = {}): Promise<ControlOutcome> {
  return setFrozen(taskId, false, opts);
}

async function setFrozen(taskId: string, frozen: boolean, opts: ControlDeps): Promise<ControlOutcome> {
  const d = deps(opts);
  const action = frozen ? 'freeze' : 'thaw';
  const row = await getTask(taskId);
  if (!row) return { ok: false, taskId, action, error: 'task_not_found' };
  if (!isLiveOwnedState(row.state)) {
    return { ok: false, taskId, action, error: 'not_live', detail: `state is ${row.state}` };
  }
  if (!row.confined || !row.scopeUnit) {
    return {
      ok: false,
      taskId,
      action,
      error: 'unsupported',
      // SIGSTOP would "work" on the leader and leave every child running — a
      // half-frozen subtree is worse than an honest refusal.
      detail: 'freeze requires a cgroup scope; this task is unconfined',
    };
  }
  const res = await systemctl([action, row.scopeUnit], d);
  return res.ok
    ? { ok: true, taskId, action, detail: `scope ${row.scopeUnit} ${frozen ? 'frozen' : 'thawed'}` }
    : { ok: false, taskId, action, error: 'command_failed', detail: res.detail };
}

export interface LimitInput {
  memoryMaxBytes?: number | null;
  cpuWeight?: number | null;
  tasksMax?: number | null;
}

/** Change a live task's budget without restarting it. */
export async function limitTask(
  taskId: string,
  limits: LimitInput,
  opts: ControlDeps = {},
): Promise<ControlOutcome> {
  const d = deps(opts);
  const row = await getTask(taskId);
  if (!row) return { ok: false, taskId, action: 'limit', error: 'task_not_found' };
  if (!isLiveOwnedState(row.state)) {
    return { ok: false, taskId, action: 'limit', error: 'not_live', detail: `state is ${row.state}` };
  }
  if (!row.confined || !row.scopeUnit) {
    return {
      ok: false,
      taskId,
      action: 'limit',
      error: 'unsupported',
      detail: 'budgets are systemd scope properties; this task is unconfined',
    };
  }
  const props: string[] = [];
  if (limits.memoryMaxBytes != null) props.push(`MemoryMax=${Math.floor(limits.memoryMaxBytes)}`);
  if (limits.cpuWeight != null) props.push(`CPUWeight=${Math.floor(limits.cpuWeight)}`);
  if (limits.tasksMax != null) props.push(`TasksMax=${Math.floor(limits.tasksMax)}`);
  if (props.length === 0) {
    return { ok: false, taskId, action: 'limit', error: 'no_target', detail: 'no limits supplied' };
  }
  const res = await systemctl(['set-property', '--runtime', row.scopeUnit, ...props], d);
  return res.ok
    ? { ok: true, taskId, action: 'limit', detail: props.join(' ') }
    : { ok: false, taskId, action: 'limit', error: 'command_failed', detail: res.detail };
}

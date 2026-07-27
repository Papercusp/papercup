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
import { absCgroupDir, nodeCgroupFs, readCgroupProcs, type CgroupFs } from './cgroup-read';
import { closeTask, getSubtree, getTask } from './store';
import { isLiveOwnedState, type TaskRow } from './types';

const execFileAsync = promisify(execFile);

export type ControlOutcome =
  | { ok: true; taskId: string; action: string; detail?: string }
  | { ok: false; taskId: string; action: string; error: ControlError; detail?: string };

export type ControlError =
  | 'task_not_found'
  | 'not_live' // already ended, or a residue classification we do not own
  | 'identity_mismatch' // the pid now belongs to something else — REFUSED
  | 'no_target' // neither a scope nor a verifiable pid
  | 'unsupported' // e.g. freeze on an unconfined task
  | 'command_failed';

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
}

export async function killTask(taskId: string, opts: KillTaskOptions = {}): Promise<ControlOutcome> {
  const d = deps(opts);
  const row = await getTask(taskId);
  if (!row) return { ok: false, taskId, action: 'kill', error: 'task_not_found' };
  if (!isLiveOwnedState(row.state)) {
    return {
      ok: false,
      taskId,
      action: 'kill',
      error: 'not_live',
      detail: `state is ${row.state} — a residue or terminal row is never ours to signal`,
    };
  }

  const signal = opts.signal ?? 'SIGTERM';

  if (opts.includeSubtree) {
    const tree = await getSubtree(row.rootTaskId);
    const descendants = tree.filter((t) => t.taskId !== taskId && isLiveOwnedState(t.state));
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
    if (opts.escalateAfterMs && opts.escalateAfterMs > 0) {
      await d.sleep(opts.escalateAfterMs);
      if (scopeStillHasProcesses(row, d)) {
        await systemctl(['kill', '--signal=SIGKILL', row.scopeUnit], d);
      }
    }
    await closeTask(taskId, { state: 'killed', exitReason: `scope kill ${signal}` });
    return { ok: true, taskId, action: 'kill', detail: `scope ${row.scopeUnit} signalled ${signal}` };
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

function scopeStillHasProcesses(row: TaskRow, d: ReturnType<typeof deps>): boolean {
  if (!row.cgroupPath) return false;
  return readCgroupProcs(absCgroupDir(row.cgroupPath), d.fs).length > 0;
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

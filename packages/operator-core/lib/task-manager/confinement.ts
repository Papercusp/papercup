/**
 * task-manager/confinement — "what confines this task, and therefore what can kill it?"
 *
 * P-023 asked for that question to become a READ instead of a shell excursion. Diagnosing
 * it by hand required `cat /proc/<pid>/cgroup`, and finding the pid required
 * `pgrep -f <ownerId>`, which self-matches the caller's own command line — the documented
 * `pkill -f` trap, returning the caller's pid as if it were the target's.
 *
 * ── WHY THIS IS A RESOLVER AND NOT A COLUMN READ (D-111) ─────────────────────
 *
 * The obvious implementation — surface the ledger's stored `cgroup_path` — ships a wrong
 * answer, which is why this module exists. `completeSyncEnrolment` wrote that column as an
 * unconditional `/proc/<client-pid>/cgroup` read while recording `confined: true`.
 * `systemd-run --scope` FORKS the payload, so that read returns the SPAWNER's cgroup, not
 * the task's. Measured 2026-09-02 over `harness_shared.task_ledger` (confined rows whose
 * stored path does not contain their own `scope_unit`):
 *
 *   agent-session 1326/2373 wrong · bash-job 2773/2856 · test-run 62/85
 *   sidecar 0/601 · desktop 0/142 · build 0/124 · deploy 0/3   ← the calibration
 *
 * The four zero classes go through `managed-spawn`, which derives the path (WI-37509). The
 * same predicate returns zero wherever the derivation is used, so it separates the mechanism
 * rather than measuring itself.
 *
 * That stored value is not merely imprecise. It is the PRE-EI-9748 answer: it names
 * `papercup-dev-api.service`, the operator's own cgroup, when EI-9748 Route A moved agent
 * sessions into `papercusp-agent-session.slice` precisely so an operator restart stops
 * killing them. A reader asking "would restarting :3070 kill this agent?" — the decision
 * this field governs — got YES from the ledger while kernel truth said NO.
 *
 * `enroll-sync` now derives the value at the write (WI-2141828), but ~1300 historical
 * agent-session rows are NOT retroactively repaired. D-111 is therefore binding on this
 * module: a read surface must never present a stored `cgroup_path` for a confined row as
 * current truth. Class-based derivation is also only a prediction: a unit can override
 * its Slice (EI-28962401056087673). Use the same request's kernel scan instead. Without
 * that positive observation, the current path and restart containment remain unknown.
 *
 * ── WHY A DISCRIMINATED UNION ────────────────────────────────────────────────
 *
 * A confined task whose scope unit was never recorded has no derivable path. Returning
 * `cgroupPath: null` beside `confined: true` would read as "not confined" — the same class
 * of silent wrong answer, one level up. The union makes the three states structurally
 * distinct, so a caller reaches "unknown" only by handling it, never by forgetting a field.
 *
 * `insideOperatorCgroup` appears ONLY on the branch where both operands are known. It is
 * absent — not `false` — everywhere else, for the same reason.
 *
 * Not to be confused with `scope-class`, which classifies a SCANNED process (is this
 * out-of-slice process an escape or a lifetime we do not own?). This answers the inverse:
 * given a ledger ROW, where does it live?
 */
import { type CgroupFs, nodeCgroupFs, readProcessCgroupPath } from './cgroup-read';
import { taskIdFromScopeUnit, type TaskState } from './types';

/** The ledger fields this resolver reads. Deliberately NOT the stored `cgroupPath` for a
 *  confined row — see the module header. */
export interface ConfinementInput {
  taskId?: string;
  state?: TaskState;
  confined: boolean;
  scopeUnit?: string | null;
  class: string;
  /** Historical path; never current confinement evidence for a task scope. */
  cgroupPath?: string | null;
  unconfinedReason?: string | null;
}

export type TaskConfinement =
  | {
      confined: true;
      cgroupPath: string;
      scopeUnit: string;
      /** Same-request kernel census path for this exact task scope. */
      source: 'observed-at-reconcile';
      /** Absent when the operator's own cgroup could not be read. */
      insideOperatorCgroup?: boolean;
    }
  | {
      confined: true;
      cgroupPath: null;
      scopeUnit: string | null;
      /** Confined, but no current path observation. NOT the same as unconfined. */
      source: 'not-derivable';
      reason: string;
    }
  | {
      confined: false;
      cgroupPath: string | null;
      scopeUnit: null;
      /** The spawn-time /proc read, which is correct when nothing forked a scope. */
      source: 'recorded-at-spawn';
      reason: string;
    };

/**
 * Index current kernel observations, including scopes whose Slice differs from the
 * class default. Descendants corroborate the unit root; conflicting roots stay unknown
 * independent of scan order. No input prefix or fixed number of paths decides truth.
 */
export function observedTaskScopePaths(paths: Iterable<string>): ReadonlyMap<string, string | null> {
  const observed = new Map<string, string | null>();
  for (const path of paths) {
    if (!path.startsWith('/')) continue;
    const segments = path.slice(1).split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) continue;
    const ownedRoot = segments.indexOf('papercusp.slice');
    if (ownedRoot < 0) continue;
    for (let i = ownedRoot + 1; i < segments.length; i++) {
      const unit = segments[i]!;
      if (!taskIdFromScopeUnit(unit)) continue;
      const root = `/${segments.slice(0, i + 1).join('/')}`;
      if (!observed.has(unit)) observed.set(unit, root);
      else if (observed.get(unit) !== root) observed.set(unit, null);
    }
  }
  return observed;
}

/**
 * Resolve one ledger row's confinement using observations from this request only.
 *
 * `fs` is injectable so tests can drive the operator's own cgroup read; production callers
 * take the default.
 */
export function resolveTaskConfinement(
  row: ConfinementInput,
  fs: CgroupFs = nodeCgroupFs,
  observedPaths: ReadonlyMap<string, string | null> = new Map(),
): TaskConfinement {
  const ownCgroupPath = readProcessCgroupPath(process.pid, fs);
  const scopeUnit = row.scopeUnit ?? null;
  const exactTaskScope = Boolean(row.taskId && scopeUnit && taskIdFromScopeUnit(scopeUnit) === row.taskId);
  const observedPath = scopeUnit ? observedPaths.get(scopeUnit) : null;
  if (
    exactTaskScope && scopeUnit && observedPath &&
    observedPath.includes('/papercusp.slice/') && observedPath.endsWith(`/${scopeUnit}`)
  ) {
    return {
      confined: true,
      cgroupPath: observedPath,
      scopeUnit,
      source: 'observed-at-reconcile',
      ...(ownCgroupPath ? { insideOperatorCgroup: isInside(observedPath, ownCgroupPath) } : {}),
    };
  }

  if (!row.confined && !(row.state === 'unaccounted' && exactTaskScope)) {
    return {
      confined: false,
      cgroupPath: row.cgroupPath ?? null,
      scopeUnit: null,
      source: 'recorded-at-spawn',
      reason:
        row.unconfinedReason ??
        'not cgroup-confined: it lives in whatever cgroup its spawner did, so its spawner’s lifetime is its own',
    };
  }

  return {
    confined: true,
    cgroupPath: null,
    scopeUnit,
    source: 'not-derivable',
    reason: scopeUnit
      ? 'current cgroup path is unknown: no unambiguous kernel observation for this exact task scope; use processes:list live:true to re-observe it'
      : 'confined, but no scope unit was recorded; the current cgroup path is UNKNOWN, not unconfined',
  };
}

/** Containment in the cgroup hierarchy: `a` is inside `b` when it IS `b` or sits beneath it.
 *  Compared segment-wise so `…/papercusp-agent.slice` is never read as inside
 *  `…/papercusp-agent-session.slice`'s prefix by accident. */
function isInside(path: string, ancestor: string | null): boolean {
  if (!ancestor) return false;
  const norm = (p: string) => p.replace(/\/+$/, '');
  const a = norm(path);
  const b = norm(ancestor);
  return a === b || a.startsWith(`${b}/`);
}

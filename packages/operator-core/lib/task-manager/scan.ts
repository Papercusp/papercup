/**
 * task-manager/scan — ask the KERNEL what is running
 * (task-manager-no-escape-2026-07-27, P-010).
 *
 * Two passes, and the difference between them is the whole ethic of this
 * subsystem:
 *
 *   1. OUR SLICE, walked recursively. Cgroup membership is inherited, so this
 *      pass sees every descendant of everything we launched — an agent CLI, the
 *      Bash tool it drove, the `npm test` that started, the vitest workers that
 *      forked, and a grandchild that double-forked and reparented to init. That
 *      is why the design does not need to intercept 813 spawn sites: it needs the
 *      ROOTS confined, and this walk does the rest.
 *
 *   2. THE REST OF THE USER MANAGER, filtered to processes that look like they
 *      belong to this project. These are FOREIGN: the owner's own terminal, a
 *      peer agent's session. They are reported so the pane can show them, and they
 *      are never controlled. Visibility is not control — the same principle the
 *      scheduled-registry states for timers, and the direct lesson of the
 *      `pkill -f '<binary>'` incidents that killed the owner's live desktop window
 *      by treating "matches a pattern" as "mine to kill".
 *
 * Bounded by construction: depth-capped walk, a process cap, and every read
 * failure degrading to null. The reconciler runs this on a 30s cadence, so a scan
 * that can hang is a scan that piles up.
 */

import { linuxProcessIdentityFromStat } from '../process-identity';
import {
  CGROUP_ROOT,
  absCgroupDir,
  nodeCgroupFs,
  parseProcCgroup,
  parseProcCmdline,
  relCgroupPath,
  walkCgroupTree,
  type CgroupFs,
} from './cgroup-read';
import { TASK_ROOT_SLICE } from './types';
import { classifyScope, isTerminalWindowScope } from './scope-class';
import { readTerminalAppPids, terminalWindowAlive } from './terminal-window';
import type { ScannedProcess } from './reconcile';

export interface ScanOptions {
  fs?: CgroupFs;
  cgroupRoot?: string;
  /** Kernel-relative path of the systemd user manager root. Derived from our own
   *  cgroup when omitted. */
  userManagerRoot?: string;
  /** What makes an out-of-slice process "one of ours to display". Deliberately a
   *  caller-supplied signature: a hardcoded one would silently stop matching the
   *  day the tree moves, and would be untestable. */
  foreignSignature?: RegExp;
  /**
   * Cap on the OWNED pass — processes inside our slice. Truncating this one is
   * serious: it makes absence unprovable, so the reconciler must stop closing rows.
   */
  maxOwnedProcesses?: number;
  /**
   * Separate cap on the FOREIGN pass.
   *
   * Separate BECAUSE they are not the same kind of budget, which a live run on
   * this box proved the hard way: with one shared cap of 4000, the foreign pass
   * (124 groups, 500+ matching processes on a busy fleet host) consumed the entire
   * allowance before the owned pass had finished, set `truncated`, and thereby put
   * the reconciler into permanent DEGRADED mode — where it never closes a stranded
   * row again. A display-only view must never be able to disable the ledger's
   * correctness path.
   *
   * It is SEPARATENESS that made that safe, not lowness — a distinction the
   * original 400 blurred, and it cost the owner a wrong answer (2026-08-02): with
   * ~400 foreign processes on this box the pane reported exactly "UNENROLLED (400)"
   * and "Scan capped", i.e. the cap WAS the number. A reader cannot tell a real 400
   * from a truncated 400, so the courtesy view was quietly answering "how many
   * Papercusp processes are running?" with its own limit.
   *
   * Now that the two budgets cannot starve each other, the foreign cap only has to
   * bound the PAYLOAD, so it is sized to actually cover a busy fleet host instead.
   * The owned pass keeps its own 4000 and its own truncation flag; nothing here can
   * put the reconciler into degraded mode.
   */
  maxForeignProcesses?: number;
  /** Our own pid, excluded from the foreign pass (we are not foreign to ourselves). */
  selfPid?: number;
}

const DEFAULT_MAX_OWNED = 4000;
// Raised 400 → 4000 (owner-directed 2026-08-02: the task manager must show EVERY
// active Papercusp process, and at 400 it was reporting its own cap as the answer).
// Safe because the owned/foreign budgets are separate — see maxForeignProcesses.
const DEFAULT_MAX_FOREIGN = 4000;

/**
 * The systemd user-manager cgroup that owns our slice, derived from our OWN
 * cgroup path rather than assumed. On this box the operator runs as
 * `…/user@1000.service/papercup-dev-api.service`, so the manager root is the
 * prefix through `user@1000.service`. Returns null when the shape is unrecognised
 * (a container, a system-slice deployment) — the caller then scans only our slice,
 * which is the honest degradation: we lose the foreign VIEW, never the ownership.
 */
export function deriveUserManagerRoot(ownCgroupPath: string | null): string | null {
  if (!ownCgroupPath) return null;
  const segs = ownCgroupPath.split('/').filter(Boolean);
  const idx = segs.findIndex((s) => /^user@\d+\.service$/.test(s));
  if (idx < 0) return null;
  return `/${segs.slice(0, idx + 1).join('/')}`;
}

function readIdentity(pid: number, bootId: string | null, fs: CgroupFs): string | null {
  if (!bootId) return null;
  const stat = fs.readFile(`/proc/${pid}/stat`);
  return stat ? linuxProcessIdentityFromStat(bootId, stat) : null;
}

export interface ScanResult {
  processes: ScannedProcess[];
  /** Absolute path walked for the owned pass — surfaced so a misconfigured root
   *  shows up as "scanned nothing" rather than as "nothing is running". */
  ownedRootAbs: string;
  ownedRootExists: boolean;
  userManagerRoot: string | null;
  /** The OWNED pass hit its cap — absence is no longer provable, so the caller must
   *  not close rows on this scan. */
  ownedTruncated: boolean;
  /** The FOREIGN pass hit its cap — the courtesy view is partial. Carries NO
   *  implication for ledger correctness and must never degrade the verdict. */
  foreignTruncated: boolean;
}

/**
 * Enumerate processes. The `owned` flag on each row is what `reconcile` uses to
 * split residue into "a bypass we must alarm on" and "someone else's process we
 * merely display".
 */
export function scanProcesses(opts: ScanOptions = {}): ScanResult {
  const fs = opts.fs ?? nodeCgroupFs;
  const cgroupRoot = opts.cgroupRoot ?? CGROUP_ROOT;
  const maxOwned = opts.maxOwnedProcesses ?? DEFAULT_MAX_OWNED;
  const maxForeign = opts.maxForeignProcesses ?? DEFAULT_MAX_FOREIGN;
  const selfPid = opts.selfPid ?? process.pid;

  const bootId = fs.readFile('/proc/sys/kernel/random/boot_id');

  const ownCgroup = parseProcCgroup(fs.readFile(`/proc/${selfPid}/cgroup`) ?? '');
  const userManagerRoot = opts.userManagerRoot ?? deriveUserManagerRoot(ownCgroup);

  const ownedRootRel = userManagerRoot ? `${userManagerRoot}/${TASK_ROOT_SLICE}` : `/${TASK_ROOT_SLICE}`;
  const ownedRootAbs = absCgroupDir(ownedRootRel, cgroupRoot);
  const ownedRootExists = fs.isDir(ownedRootAbs);

  const processes: ScannedProcess[] = [];
  const seen = new Set<number>();
  let ownedCount = 0;
  let foreignCount = 0;
  let ownedTruncated = false;
  let foreignTruncated = false;

  // Window liveness is a property of the SCOPE, not of each process in it, and a
  // busy window holds dozens — so probe once per scope and reuse. The application's
  // pid set is likewise read once per slice, not once per window.
  const appPidsBySlice = new Map<string, Set<number>>();
  const windowAliveByScope = new Map<string, boolean | null>();

  const probeWindow = (absDir: string, cgroupPath: string): boolean | null | undefined => {
    if (!isTerminalWindowScope(cgroupPath)) return undefined;
    const cached = windowAliveByScope.get(absDir);
    if (cached !== undefined) return cached;

    // A window scope's parent IS the terminal app slice.
    const sliceAbs = absDir.slice(0, absDir.lastIndexOf('/'));
    let appPids = appPidsBySlice.get(sliceAbs);
    if (!appPids) {
      appPids = readTerminalAppPids(sliceAbs, fs);
      appPidsBySlice.set(sliceAbs, appPids);
    }

    const alive = terminalWindowAlive(absDir, appPids, fs);
    windowAliveByScope.set(absDir, alive);
    return alive;
  };

  const push = (pid: number, absDir: string, owned: boolean): void => {
    if (seen.has(pid)) return;
    // Two independent budgets — a busy foreign population must never be able to
    // starve the owned pass and put the reconciler into permanent degraded mode.
    if (owned) {
      if (ownedCount >= maxOwned) {
        ownedTruncated = true;
        return;
      }
      ownedCount++;
    } else {
      if (foreignCount >= maxForeign) {
        foreignTruncated = true;
        return;
      }
      foreignCount++;
    }
    seen.add(pid);
    const cgroupPath = relCgroupPath(absDir, cgroupRoot);
    // Classify HERE, not in the pane. The rule set is the guard's intent expressed
    // at runtime; duplicating it in a component is how the two drift apart, and a
    // pane that classifies for itself is a pane that can quietly invent a coverage
    // hole (EI-19325095302441792).
    const { scope, exemptReason } = classifyScope(cgroupPath, owned, {
      terminalWindowAlive: probeWindow(absDir, cgroupPath),
    });
    processes.push({
      pid,
      cgroupPath,
      processIdentity: readIdentity(pid, bootId, fs),
      cmdline: parseProcCmdline(fs.readFile(`/proc/${pid}/cmdline`)),
      owned,
      scope,
      exemptReason,
    });
  };

  // ── pass 1: everything under our slice, at any depth ─────────────────────
  if (ownedRootExists) {
    for (const node of walkCgroupTree(ownedRootAbs, fs)) {
      for (const pid of node.pids) push(pid, node.absDir, true);
    }
  }

  // ── pass 2: the rest of the user manager, signature-filtered ─────────────
  const sig = opts.foreignSignature;
  if (sig && userManagerRoot) {
    const managerAbs = absCgroupDir(userManagerRoot, cgroupRoot);
    for (const node of walkCgroupTree(managerAbs, fs)) {
      if (node.absDir === ownedRootAbs || node.absDir.startsWith(`${ownedRootAbs}/`)) continue;
      for (const pid of node.pids) {
        if (seen.has(pid) || pid === selfPid) continue;
        const cmdline = parseProcCmdline(fs.readFile(`/proc/${pid}/cmdline`));
        if (!cmdline || !sig.test(cmdline)) continue;
        push(pid, node.absDir, false);
      }
    }
  }

  return { processes, ownedRootAbs, ownedRootExists, userManagerRoot, ownedTruncated, foreignTruncated };
}

/**
 * The default foreign signature for this repo. A caller may override it; it lives
 * here so there is ONE place to fix when the tree moves, and so the default is
 * anchored on a path rather than a binary NAME.
 *
 * Anchoring on the path is deliberate. Matching a bare binary name ("papercusp",
 * "node") is precisely the mistake behind the `pkill -f` incidents: it matches the
 * owner's live desktop window, every peer agent's test instance, and unrelated
 * processes that merely share a runtime.
 */
export function defaultForeignSignature(repoRoot: string): RegExp {
  const escaped = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped);
}

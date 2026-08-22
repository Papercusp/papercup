/**
 * EI-19385475092979200 — refuse (softly) to restart a gate-critical shared host while a
 * green-checkpoint run is in flight or is about to be, but only when the live mechanism
 * evidence says the restart can actually reach that run.
 *
 * ## The hazard
 *
 * Restarting a shared host the gate's suite depends on — the embedding sidecar, the inference
 * gateway, the background routines host — can perturb a run. The concrete hard hazard is a
 * restart that shares the run's systemd cgroup and therefore terminates it; separate detached
 * checkpoint units do not have that KillMode=control-group reach. Even with separate cgroups,
 * ambient host load during boot remains a residual risk, so the guard says what it measured
 * instead of presenting every live lock as an abortable collision.
 *
 * ## Why `ps` is the wrong oracle (the near-miss this is built from)
 *
 * On 2026-08-02 an agent DID check for an in-flight run before restarting the sidecar — `ps`
 * at 23:14:43Z and again at 23:14:50Z, both clear. The hourly gate then fired at 23:15:02Z,
 * in the 45-second gap between the check and the action, and the restart landed 34 seconds
 * into a live run. A hand-run `ps` answers "is a run in flight RIGHT NOW", which is stale the
 * instant it returns, and it cannot see the one fact that would have prevented this: the gate
 * fires on a SCHEDULE, and `harness_shared.routines.next_fire_at` says exactly when.
 *
 * That is why the imminent-fire window here is DELIBERATELY TWO-SIDED. The reported incident
 * happened at :15:36 — i.e. 36 seconds AFTER the scheduled fire time, not before it. A guard
 * that only looked forward ("is a fire coming up?") would have sailed straight past the very
 * incident it exists to prevent. Looking behind also covers the genuine gap where the tick has
 * fired but the run process has not yet raced for the shared run-lock, during which BOTH the
 * lock probe and a forward-only schedule check read clear.
 *
 * ## Fail OPEN, always
 *
 * Every unknown resolves to "no collision". A restart wrongly REFUSED because of a stale lock
 * file, an unreadable routines row, or a missing module in a stripped bundle is worse than the
 * collision this guards against: a genuinely wedged sidecar during a ~55-minute run may
 * legitimately need restarting, and an agent that cannot restart it has no recourse inside the
 * tool. Same contract as {@link readInFlightRetriage} and `resolveDeadRoutineOverdueMs`.
 *
 * For the same reason a confirmed shared-cgroup collision is a SOFT block: the caller is
 * refused with the run's age and candidate, and told the exact override to re-call with. A
 * known detached sibling and an unknown cgroup relationship both fail open with an explicit
 * note rather than silently converting uncertainty into a refusal.
 *
 * Precedent for the shape: `release:checkpoint-run` was taught to read the `inFlightRetriage`
 * marker and refuse with `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN` (EI-19343516395023183). Same
 * problem, same solution, different verb — so this REUSES that module's reader rather than
 * standing up a third way to ask "what is the gate doing".
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StoredInFlightRetriage } from './in-flight-retriage';
import { RESTART_TARGET_UNITS } from '../agent-tools/dev/restart-target-units';

let execFileAsync: ((...args: any[]) => Promise<any>) | undefined;
const runExecFile = (...args: any[]) => (execFileAsync ??= promisify(execFile) as any)(...args);

/**
 * The restart targets whose blast radius overlaps a green-checkpoint run's dependencies.
 *
 * NOT `dev` or `staging`: those are operator web hosts (:3070 / :3170). The gate runs its
 * suite in an isolated checkout and does not route through either, so guarding them would be
 * pure false-positive friction on the two targets restarted most often.
 */
export const GATE_SENSITIVE_RESTART_TARGETS = ['embed-sidecar', 'gateway', 'bg-host'] as const;

export type GateSensitiveTarget = (typeof GATE_SENSITIVE_RESTART_TARGETS)[number];

export function isGateSensitiveTarget(target: string): target is GateSensitiveTarget {
  return (GATE_SENSITIVE_RESTART_TARGETS as readonly string[]).includes(target);
}

/** How far AHEAD of a scheduled gate fire a restart is treated as colliding. */
export const IMMINENT_FIRE_LOOKAHEAD_SEC = 120;

/**
 * How far BEHIND a scheduled fire a restart is still treated as colliding — the window in
 * which the tick has fired but the run has not yet taken the shared run-lock, so the lock
 * probe reads clear while a run is in fact starting. The 2026-08-02 near-miss lived here
 * (:15:36, 36s past the fire), which is why this is not zero.
 */
export const IMMINENT_FIRE_LOOKBEHIND_SEC = 120;

/** Raw observations. Every field is independently nullable — a partial probe still judges. */
export interface GateCollisionProbe {
  /** True when a probe THREW. Distinct from "probed cleanly and found nothing". */
  probeFailed: boolean;
  /** The shared green-checkpoint run-lock, held by a process verified alive. */
  runLockHeld: boolean;
  /** Age of the run holding the lock, when known. */
  runElapsedSec: number | null;
  /** Verified PID that owns the run-lock, when the lock reader exposes it. */
  runLockPid?: number | null;
  /** Unified cgroup path of the checkpoint owner, when it can be read. */
  runLockCgroupPath?: string | null;
  /** Unified cgroup path systemd assigns to the restart target, when it can be read. */
  targetCgroupPath?: string | null;
  /** True when the cgroup comparison itself could not be completed. */
  cgroupProbeFailed?: boolean;
  /** Seconds until the next scheduled fire; NEGATIVE = that many seconds PAST it. */
  nextFireInSec: number | null;
  /** An auto-refire in flight — the strongest possible stand-down signal. */
  refire: StoredInFlightRetriage | null;
}

export type GateCollisionKind =
  /** The target cannot affect a gate run — never blocks. */
  | 'not-gate-sensitive'
  /** A probe threw; we do not know. Fails OPEN. */
  | 'probe-failed'
  /** Probed cleanly, nothing in flight, no fire imminent. */
  | 'clear'
  /** A run holds the shared run-lock right now. */
  | 'run-in-flight'
  /** A run is active, but its known systemd cgroup is separate from the target. */
  | 'run-in-flight-isolated'
  /** A run is active, but its cgroup relationship to the target is unknown. */
  | 'run-in-flight-unknown'
  /** No lock held, but a scheduled fire is within the two-sided window. */
  | 'imminent-fire';

export interface GateCollisionVerdict {
  /** The caller must REFUSE when true. Never true if `override` was passed. */
  blocked: boolean;
  kind: GateCollisionKind;
  /** A collision was found but waived by an explicit override. */
  overridden: boolean;
  /** Human-facing explanation — safe to put straight into a tool result. */
  note: string;
  detail: {
    runElapsedSec: number | null;
    nextFireInSec: number | null;
    refiringCandidate: string | null;
    refireAttempt: number | null;
    runLockPid: number | null;
    runLockCgroupPath: string | null;
    targetCgroupPath: string | null;
    cgroupRelation: GateRunCgroupRelation;
  };
}

export type GateRunCgroupRelation = 'same' | 'different' | 'unknown';

function humanizeSec(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}min`;
}

function normalizeCgroupPath(value: string | null | undefined): string | null {
  const path = value?.trim();
  if (!path || !path.startsWith('/')) return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * PURE — systemd's ControlGroup is the cgroup root for a unit, while a process may be in
 * that unit or in a child cgroup. Only a root/descendant relationship is a collision; sibling
 * transient units share parents but are deliberately independent for KillMode=control-group.
 * Missing paths are UNKNOWN, never same — the live guard fails open in that case.
 *
 * The legacy `undefined`/`undefined` case is retained for old injectable callers that only
 * supplied the original lock reader. Production probes populate both fields (or explicit nulls)
 * whenever they inspect a held lock, so an actual unreadable cgroup never takes this fallback.
 */
export function gateRunCgroupRelation(
  runCgroupPath: string | null | undefined,
  targetCgroupPath: string | null | undefined,
): GateRunCgroupRelation {
  if (runCgroupPath === undefined && targetCgroupPath === undefined) return 'same';
  const run = normalizeCgroupPath(runCgroupPath);
  const target = normalizeCgroupPath(targetCgroupPath);
  if (!run || !target) return 'unknown';
  const nested = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
  return nested(target, run) || nested(run, target) ? 'same' : 'different';
}

function defaultReadProcessCgroup(pid: number): string | null {
  try {
    const unified = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('0::'))
      ?.slice(3)
      .trim();
    return normalizeCgroupPath(unified);
  } catch {
    return null;
  }
}

async function defaultReadTargetCgroup(target: GateSensitiveTarget): Promise<string | null> {
  const { stdout } = await runExecFile(
    'systemctl',
    ['--user', 'show', RESTART_TARGET_UNITS[target], '-p', 'ControlGroup', '--value'],
    { timeout: 3_000 },
  );
  return normalizeCgroupPath(String(stdout));
}

/**
 * PURE verdict. Every input is explicit, so the whole decision table — including each
 * single-condition removal — is provable from fixtures with no filesystem and no database.
 * (A guard whose only test is "0 violations on a tree that has 0 violations" would pass
 * identically with its condition INVERTED; this shape is what makes teeth testable.)
 */
export function judgeGateCollision(input: {
  target: string;
  probe: GateCollisionProbe;
  override: boolean;
}): GateCollisionVerdict {
  const { target, probe, override } = input;
  const cgroupRelation = probe.runLockHeld
    ? gateRunCgroupRelation(probe.runLockCgroupPath, probe.targetCgroupPath)
    : 'unknown';
  const detail = {
    runElapsedSec: probe.runElapsedSec,
    nextFireInSec: probe.nextFireInSec,
    refiringCandidate: probe.refire?.refiringCandidate ?? null,
    refireAttempt: probe.refire?.refireAttempt ?? null,
    runLockPid: probe.runLockPid ?? null,
    runLockCgroupPath: probe.runLockCgroupPath ?? null,
    targetCgroupPath: probe.targetCgroupPath ?? null,
    cgroupRelation,
  };

  if (!isGateSensitiveTarget(target)) {
    return {
      blocked: false,
      kind: 'not-gate-sensitive',
      overridden: false,
      note: `${target} is not a green-checkpoint dependency — no gate-collision check applies.`,
      detail,
    };
  }

  if (probe.probeFailed) {
    // Fail OPEN and SAY SO. Silence here would read as a verified all-clear.
    return {
      blocked: false,
      kind: 'probe-failed',
      overridden: false,
      note: `Could NOT determine whether a green-checkpoint run is in flight (the probe failed) — proceeding, because a restart wrongly refused is worse than the collision. Verify by hand if this restart is gate-sensitive.`,
      detail,
    };
  }

  const fireImminent =
    probe.nextFireInSec !== null &&
    probe.nextFireInSec <= IMMINENT_FIRE_LOOKAHEAD_SEC &&
    probe.nextFireInSec >= -IMMINENT_FIRE_LOOKBEHIND_SEC;

  if (!probe.runLockHeld && !fireImminent) {
    return {
      blocked: false,
      kind: 'clear',
      overridden: false,
      note: `No green-checkpoint run in flight${
        probe.nextFireInSec !== null ? `; next scheduled fire in ~${humanizeSec(probe.nextFireInSec)}` : ''
      }.`,
      detail,
    };
  }

  if (probe.runLockHeld && cgroupRelation === 'different') {
    return {
      blocked: false,
      kind: 'run-in-flight-isolated',
      overridden: false,
      note:
        `A green-checkpoint run IS IN FLIGHT, but its cgroup (${probe.runLockCgroupPath}) is separate from ` +
        `${target}'s systemd cgroup (${probe.targetCgroupPath}) — restarting ${target} cannot terminate that run ` +
        `through systemd cgroup membership. Proceeding with residual risk: the restart can still add ambient host ` +
        `load during boot, while the run's own watchdog covers loss of the parent-side kill timer.`,
      detail,
    };
  }

  if (probe.runLockHeld && cgroupRelation === 'unknown') {
    return {
      blocked: false,
      kind: 'run-in-flight-unknown',
      overridden: false,
      note:
        `A green-checkpoint run IS IN FLIGHT, but its cgroup relationship to ${target} could not be determined ` +
        `(checkpoint=${probe.runLockCgroupPath ?? 'unknown'}, target=${probe.targetCgroupPath ?? 'unknown'}). ` +
        `Proceeding because this guard fails open when mechanism metadata is unknown; verify the restart's impact ` +
        `against systemd if the target is gate-sensitive.`,
      detail,
    };
  }

  const kind: GateCollisionKind = probe.runLockHeld ? 'run-in-flight' : 'imminent-fire';

  const what = probe.runLockHeld
    ? `A green-checkpoint run IS IN FLIGHT${
        probe.runElapsedSec !== null ? ` (running ${humanizeSec(probe.runElapsedSec)})` : ''
      }${
        probe.refire
          ? ` and is MID AUTO-REFIRE (attempt ${probe.refire.refireAttempt}/${probe.refire.maxRefires}, now judging ${probe.refire.refiringCandidate})`
          : ''
      }.`
    : probe.nextFireInSec !== null && probe.nextFireInSec >= 0
      ? `The hourly green-checkpoint gate fires in ${humanizeSec(probe.nextFireInSec)}.`
      : `The hourly green-checkpoint gate fired ${humanizeSec(probe.nextFireInSec ?? 0)} ago and its run may not have taken the shared run-lock yet.`;

  const why =
    `The run shares ${target}'s systemd cgroup, so restarting ${target} can terminate it; even when the cgroups ` +
    `are separate, ambient host load during boot can still perturb the gate, and a parent restart can drop only ` +
    `the parent's kill timer (the run's own watchdog is the backstop).`;

  if (override) {
    return {
      blocked: false,
      kind,
      overridden: true,
      note: `${what} ${why} PROCEEDING ANYWAY — override_gate_collision was passed. If the gate reds on anything embedding- or search-shaped, attribute it to THIS restart and re-run before reading it as a regression.`,
      detail,
    };
  }

  return {
    blocked: true,
    kind,
    overridden: false,
    note: `Restart WITHHELD — nothing was done: no lock taken, no drain. ${what} ${why} Either wait it out, or — if ${target} is genuinely wedged and must be restarted now — re-call with { override_gate_collision: true } and record in \`reason\` that the run may be affected.`,
    detail,
  };
}

/** Injectable readers, so the shell is testable without a filesystem or a database. */
export interface GateCollisionProbeDeps {
  readRunLock: () => { held: boolean; elapsedSec: number | null; pid?: number };
  /** Read the checkpoint owner's unified cgroup. Optional for backwards-compatible fixtures. */
  readRunLockCgroup?: (pid: number) => string | null | Promise<string | null>;
  /** Read the restart target's systemd ControlGroup. Optional for backwards-compatible fixtures. */
  readTargetCgroup?: (target: GateSensitiveTarget) => string | null | Promise<string | null>;
  readNextFireInSec: () => Promise<number | null>;
  readRefire: () => Promise<StoredInFlightRetriage | null>;
}

/**
 * When the gate next fires, from the SAME routines row `readInFlightRetriage` reads.
 *
 * Scoped on `install_slug` AND `workspace_id`: that table is multi-tenant (one row per
 * harness, and every harness's row carries the same `:15` schedule), so an under-scoped read
 * returns some other harness's row — well-formed, confident, wrong. A zero-row result fails
 * open, which is the safe direction here.
 */
async function defaultReadNextFireInSec(): Promise<number | null> {
  const [{ operatorHomeHarnessSlug }, { getOrgPg }, { activeWorkspaceId }] = await Promise.all([
    import('../harness/operator-home-harness'),
    import('@papercusp/db-org'),
    import('../workspace-registry'),
  ]);
  const slug = operatorHomeHarnessSlug();
  if (!slug) return null;
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT EXTRACT(EPOCH FROM (next_fire_at - now())) AS next_fire_in_sec
       FROM harness_shared.routines
      WHERE install_slug = $1 AND workspace_id = $2
        AND target_role = 'system:green-checkpoint' AND active = true
      LIMIT 1`,
    [slug, activeWorkspaceId()],
  )) as Array<{ next_fire_in_sec: string | number | null }>;
  const raw = rows[0]?.next_fire_in_sec;
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function defaultDeps(): Promise<GateCollisionProbeDeps> {
  const [{ integrationRoot }, { isCheckpointRunLockHeldCheap }, { readInFlightRetriage }] = await Promise.all([
    import('../release-deploy-launch'),
    import('../release-checkpoint-launch'),
    import('./in-flight-retriage'),
  ]);
  return {
    readRunLock: () => isCheckpointRunLockHeldCheap(integrationRoot()),
    readRunLockCgroup: defaultReadProcessCgroup,
    readTargetCgroup: defaultReadTargetCgroup,
    readNextFireInSec: defaultReadNextFireInSec,
    readRefire: () => readInFlightRetriage(),
  };
}

/**
 * Thin I/O shell. Each reader is isolated so ONE failure degrades ONE field rather than
 * collapsing the whole probe to `probeFailed` — a readable run-lock still blocks correctly
 * when the routines read is what broke.
 */
export async function probeGateCollision(
  deps?: GateCollisionProbeDeps,
  target: GateSensitiveTarget = 'bg-host',
): Promise<GateCollisionProbe> {
  let d: GateCollisionProbeDeps;
  try {
    d = deps ?? (await defaultDeps());
  } catch {
    return { probeFailed: true, runLockHeld: false, runElapsedSec: null, nextFireInSec: null, refire: null };
  }

  let probeFailed = false;
  let runLockHeld = false;
  let runElapsedSec: number | null = null;
  let runLockPid: number | null | undefined;
  let runLockCgroupPath: string | null | undefined;
  let targetCgroupPath: string | null | undefined;
  let cgroupProbeFailed = false;
  try {
    const lock = d.readRunLock();
    runLockHeld = lock.held;
    runElapsedSec = lock.elapsedSec;
    runLockPid = lock.pid ?? null;
  } catch {
    probeFailed = true;
  }

  // Only a held lock needs mechanism analysis. The default deps always provide these readers;
  // old injectable fixtures that do not provide them retain the pre-cgroup pure-test contract.
  const hasCgroupReaders = Boolean(d.readRunLockCgroup || d.readTargetCgroup);
  if (runLockHeld && (runLockPid !== null && runLockPid !== undefined || hasCgroupReaders)) {
    if (runLockPid !== null && runLockPid !== undefined && d.readRunLockCgroup) {
      try {
        runLockCgroupPath = await d.readRunLockCgroup(runLockPid);
      } catch {
        cgroupProbeFailed = true;
        runLockCgroupPath = null;
      }
    } else {
      cgroupProbeFailed = true;
      runLockCgroupPath = null;
    }
    if (d.readTargetCgroup) {
      try {
        targetCgroupPath = await d.readTargetCgroup(target);
      } catch {
        cgroupProbeFailed = true;
        targetCgroupPath = null;
      }
    }
  }

  let nextFireInSec: number | null = null;
  try {
    nextFireInSec = await d.readNextFireInSec();
  } catch {
    probeFailed = true;
  }

  let refire: StoredInFlightRetriage | null = null;
  try {
    refire = await d.readRefire();
  } catch {
    // The refire marker only ENRICHES the message; losing it is never a probe failure.
  }

  return {
    probeFailed,
    runLockHeld,
    runElapsedSec,
    ...(runLockPid !== undefined ? { runLockPid } : {}),
    ...(runLockCgroupPath !== undefined ? { runLockCgroupPath } : {}),
    ...(targetCgroupPath !== undefined ? { targetCgroupPath } : {}),
    ...(cgroupProbeFailed ? { cgroupProbeFailed } : {}),
    nextFireInSec,
    refire,
  };
}

/** Probe + judge, the one call `dev:restart` makes. Never throws. */
export async function checkGateCollision(
  target: string,
  override: boolean,
  deps?: GateCollisionProbeDeps,
): Promise<GateCollisionVerdict> {
  if (!isGateSensitiveTarget(target)) {
    return judgeGateCollision({
      target,
      probe: { probeFailed: false, runLockHeld: false, runElapsedSec: null, nextFireInSec: null, refire: null },
      override,
    });
  }
  const probe = await probeGateCollision(deps, target);
  return judgeGateCollision({ target, probe, override });
}

/**
 * desktop-lifecycle — what to do with a desktop session nobody is driving.
 * (agent-virtual-desktops-2026-08-23 P-005 / WI-40868; extends P-003's registry.)
 *
 * ## Why this exists, in one measurement
 *
 * WI-5978 measured three QEMU guests on this box holding **12.8 cores — 11% of a
 * 128-core machine — continuously for 5 to 9 days while idle**. A fourth guest,
 * up LONGER than two of them, cost 0.1 cores. That fourth guest is the control,
 * and it is what makes this a bug rather than "VMs are expensive": a guest that
 * idles correctly costs approximately nothing. The other three were not working,
 * they were SPINNING — the signature of a guest whose idle loop never reaches
 * HLT.
 *
 * You cannot fix that from inside the guest, because the guest does not believe
 * it is idle. The host does. So the fix is a host-side governor that notices a
 * session nobody has driven and FREEZES its cgroup, which stops the spin at the
 * scheduler.
 *
 * ## Freeze, not kill — and why that ordering is the whole design
 *
 * Killing would also stop the spin. It would also destroy a desktop the agent may
 * be about to come back to, and for a guest that means throwing away state that
 * is expensive to rebuild. Freezing is the reversible form of the same fix, so
 * the ladder is:
 *
 *   ready  --idle after N--> idle    (bookkeeping only; nothing is suspended)
 *   idle   --still idle-->    frozen  (cgroup.freeze; the spin stops here)
 *   frozen --still frozen--> reaped  (thaw, kill the subtree, close the row)
 *
 * The middle rung matters: a short gap in an agent's loop costs a state flip
 * rather than a freeze/thaw round trip, and `touchDesktopSession` promotes `idle`
 * straight back to `ready` for free.
 *
 * ## ⚠ THE ORDERING TRAP — thaw before you kill
 *
 * `killTask` does NOT thaw first (verified in task-manager/control.ts: `setFrozen`
 * and `killTask` are independent, and nothing in the kill path touches the
 * freezer). Signals sent to a frozen cgroup are QUEUED, not delivered — the
 * processes are stopped at the scheduler and cannot run a handler. So a
 * SIGTERM into a frozen desktop appears to succeed, the scope never empties, and
 * the reap reports "signalled" against a subtree that is still holding its
 * display. Every reap of a frozen session therefore thaws FIRST. This is the one
 * detail in this file that is genuinely easy to get wrong and impossible to spot
 * from the outside, because the failure looks exactly like a slow shutdown.
 *
 * ## What it refuses to touch
 *
 * Mirrors gc-verify-instances' guard style, because the blast radius is the same
 * class: protected displays (`:0`/`:1`/`:2` — the owner's real desktop and the
 * conventional next seats), `scope: 'workspace'` sessions (D-002/D-005: the
 * product's own desktop, not an agent sandbox), and any session on another host.
 * A refusal is REPORTED, never silent — a permanently-skipped session that says
 * nothing is indistinguishable from a governor that is not running.
 */
import {
  TERMINAL_DESKTOP_STATES,
  type DesktopKind,
  type DesktopSessionRecord,
} from './desktop-session-registry';

/**
 * Displays this governor will never suspend or reap, whatever a row claims.
 * Deliberately the same set (and the same reasoning) as
 * `gc-verify-instances.PROTECTED_DISPLAYS`: `:0` is the owner's real desktop,
 * `:1`/`:2` the conventional next seats. Duplicated rather than imported because
 * the two sweeps are independent and neither should be able to widen the other's
 * refusal set by accident; the drift guard in the tests pins them together.
 */
export const PROTECTED_DISPLAYS: ReadonlySet<string> = new Set([':0', ':1', ':2']);

export type DesktopLifecycleAction = 'keep' | 'idle' | 'freeze' | 'reap';

export interface DesktopLifecyclePolicy {
  /** `ready` → `idle` after this long without activity. */
  idleAfterSec: number;
  /** `idle` → `frozen` after this long without activity (measured from
   *  last_active_at, so it INCLUDES the idle window — not stacked on top). */
  freezeAfterSec: number;
  /** `frozen` → reaped after this long frozen (measured from frozen_at). */
  reapAfterFrozenSec: number;
}

const HOUR = 3600;

/**
 * Per-kind thresholds. The asymmetry between kinds is the point, not an
 * oversight:
 *
 * - A **guest** (`vm-guest`, `microvm`) is frozen AGGRESSIVELY because an idle
 *   one can burn a whole core (WI-5978), and reaped LAZILY because its disk state
 *   is expensive to rebuild. Freeze early, destroy late.
 * - An **xvfb/bwrap sandbox** is frozen lazily because an idle X server costs a
 *   few MB and no CPU, so suspending it buys almost nothing while costing a
 *   thaw round trip on the next use. It is reaped sooner because rebuilding one
 *   is a couple of seconds.
 * - A **frame-slot** display belongs to an agent spawn and follows the sandbox
 *   shape; its real teardown rides the agent's own exit, and this is the backstop
 *   for when that never happens.
 */
export const DESKTOP_LIFECYCLE_POLICY: Readonly<Record<DesktopKind, DesktopLifecyclePolicy>> = {
  'xvfb-local': { idleAfterSec: 15 * 60, freezeAfterSec: 2 * HOUR, reapAfterFrozenSec: 6 * HOUR },
  bwrap: { idleAfterSec: 15 * 60, freezeAfterSec: 2 * HOUR, reapAfterFrozenSec: 6 * HOUR },
  'frame-slot': { idleAfterSec: 15 * 60, freezeAfterSec: 2 * HOUR, reapAfterFrozenSec: 6 * HOUR },
  'vm-guest': { idleAfterSec: 5 * 60, freezeAfterSec: 20 * 60, reapAfterFrozenSec: 24 * HOUR },
  microvm: { idleAfterSec: 5 * 60, freezeAfterSec: 20 * 60, reapAfterFrozenSec: 24 * HOUR },
};

/** Fallback for a kind added to the registry without a policy entry — chosen to
 *  be the CONSERVATIVE one (slow to freeze, slow to reap) so a new kind can never
 *  inherit aggressive suspension by forgetting a line here. */
export const DEFAULT_DESKTOP_LIFECYCLE_POLICY: DesktopLifecyclePolicy = {
  idleAfterSec: 30 * 60,
  freezeAfterSec: 4 * HOUR,
  reapAfterFrozenSec: 24 * HOUR,
};

/**
 * A session stuck in `provisioning` for longer than this never came up — the
 * provisioner crashed between the INSERT and `markDesktopReady`. It holds a
 * display in the uniqueness index, so leaving it forever blocks that display for
 * every future lease. Generous relative to the 8s Xvfb ready timeout: a guest
 * boot is legitimately slow, and reaping a desktop that was still coming up is a
 * worse failure than a stale row.
 */
export const PROVISIONING_STUCK_SEC = 30 * 60;

/**
 * How long a viewer binding defers governance. An active viewer (`watch` /
 * `takeover`) means a human is looking at this desktop, and freezing it under
 * them would be indistinguishable from a crash — so a bound viewer holds the
 * governor off.
 *
 * ⚠ WHY THIS IS HOURS AND NOT MINUTES — the sizing is derived from how the
 * binding actually behaves, and getting it from the name alone gives the wrong
 * answer. `frame-vnc` binds the viewer when the stream OPENS and clears it back
 * to `none` on teardown; nothing writes the row in between. So the activity clock
 * marks the START of a viewing session, not its liveness, and a bound viewer that
 * has been quiet for 40 minutes is overwhelmingly a person still watching — not a
 * stale flag. A short bound here would freeze a desktop out from under a live
 * 31-minute VNC session, which is precisely the "indistinguishable from a crash"
 * failure this hold exists to prevent. (This was a real defect in the first cut of
 * this file, caught by a test: the bound was 30 minutes.)
 *
 * It is still BOUNDED, because teardown can be skipped — a crashed viewer process
 * never runs the clear, and an unbounded hold would let one stuck flag leak a
 * desktop forever. Six hours is longer than any plausible single viewing session
 * and short enough that a crashed teardown costs one idle desktop for an evening.
 * Protect the human first; do not let a stale boolean impersonate one indefinitely.
 *
 * If a future streaming tier (P-013) heartbeats the row while a viewer is
 * connected, this can drop back to minutes — the binding would then mean
 * liveness, which is what a short bound requires.
 */
export const VIEWER_HOLD_SEC = 6 * HOUR;

export interface DesktopVerdict {
  id: string;
  action: DesktopLifecycleAction;
  /** Human-readable, and written to be read in a log line at 3am. */
  reason: string;
  /** True when the verdict is a REFUSAL — a protected or out-of-scope session the
   *  governor declines to act on, as opposed to one that is simply still busy.
   *  Reported separately so a permanently-skipped session stays visible. */
  refused?: boolean;
}

export function policyFor(kind: DesktopKind): DesktopLifecyclePolicy {
  return DESKTOP_LIFECYCLE_POLICY[kind] ?? DEFAULT_DESKTOP_LIFECYCLE_POLICY;
}

function ageSec(from: Date | null | undefined, nowMs: number): number {
  if (!from) return 0;
  return Math.max(0, (nowMs - new Date(from).getTime()) / 1000);
}

/**
 * The whole decision, as a pure function of the row and the clock.
 *
 * Pure so the ladder can be tested exhaustively without a database, a cgroup or a
 * VM — and so the thresholds above are falsifiable rather than asserted. The
 * ORDER of the checks is load-bearing and is the reason this is one function
 * rather than a chain of predicates: refusals must win over expiry, and expiry
 * must win over the idle ladder.
 */
export function classifyDesktopSession(
  session: DesktopSessionRecord,
  nowMs: number,
  policyOverride?: Partial<DesktopLifecyclePolicy>,
): DesktopVerdict {
  const { id } = session;

  // 0. Terminal rows are not the governor's business. Callers filter these out,
  //    but a defensive branch beats a governor that "freezes" a released session.
  if (TERMINAL_DESKTOP_STATES.includes(session.state)) {
    return { id, action: 'keep', reason: `already ${session.state}` };
  }

  // 1. REFUSALS FIRST — these outrank every clock, including an expired TTL.
  //    A protected display with a stale TTL is still the owner's real desktop.
  if (PROTECTED_DISPLAYS.has(session.display)) {
    return {
      id,
      action: 'keep',
      reason: `refusing to govern protected display ${session.display}`,
      refused: true,
    };
  }
  if (session.scope === 'workspace') {
    return {
      id,
      action: 'keep',
      reason:
        "refusing to govern a scope='workspace' desktop — that is the product's own " +
        'desktop (D-002/D-005), not an agent sandbox',
      refused: true,
    };
  }

  const policy = { ...policyFor(session.kind), ...policyOverride };
  const idleAfterSec = session.idleAfterSec ?? policy.idleAfterSec;
  const inactiveSec = ageSec(session.lastActiveAt, nowMs);

  // 2. A session that never finished provisioning holds a display in the
  //    uniqueness index and will never come up. Ahead of the viewer hold: nothing
  //    can be watching a desktop that never started.
  if (session.state === 'provisioning') {
    return ageSec(session.createdAt, nowMs) > PROVISIONING_STUCK_SEC
      ? {
          id,
          action: 'reap',
          reason: `stuck in provisioning for ${Math.round(ageSec(session.createdAt, nowMs) / 60)}m — it never came up`,
        }
      : { id, action: 'keep', reason: 'still provisioning' };
  }

  // 3. A bound viewer holds everything off — but only while the binding is being
  //    refreshed. See VIEWER_HOLD_SEC for why this is not unbounded.
  const viewerHolds = session.viewerMode !== 'none' && inactiveSec <= VIEWER_HOLD_SEC;
  if (viewerHolds) {
    return {
      id,
      action: 'keep',
      reason: `viewer bound (${session.viewerMode}${session.viewerActor ? ` by ${session.viewerActor}` : ''})`,
    };
  }

  // 4. An expired lease is reaped regardless of where it sits on the idle ladder.
  //    The TTL is the holder's own declaration of how long it wanted the desktop;
  //    honouring it is not a judgement call about business.
  if (session.ttlSec !== null && inactiveSec > session.ttlSec) {
    return {
      id,
      action: 'reap',
      reason: `lease expired — ttl ${session.ttlSec}s, unrenewed for ${Math.round(inactiveSec)}s`,
    };
  }

  // 5. Frozen sessions age out of the freezer into a reap.
  if (session.state === 'frozen') {
    const frozenSec = ageSec(session.frozenAt, nowMs);
    return frozenSec > policy.reapAfterFrozenSec
      ? {
          id,
          action: 'reap',
          reason: `frozen and untouched for ${Math.round(frozenSec / 60)}m (> ${Math.round(policy.reapAfterFrozenSec / 60)}m)`,
        }
      : { id, action: 'keep', reason: `frozen ${Math.round(frozenSec / 60)}m ago` };
  }

  // 6. The idle ladder.
  if (inactiveSec > policy.freezeAfterSec) {
    return {
      id,
      action: 'freeze',
      reason: `idle ${Math.round(inactiveSec / 60)}m (> ${Math.round(policy.freezeAfterSec / 60)}m) — suspending to stop it burning CPU`,
    };
  }
  if (session.state === 'ready' && inactiveSec > idleAfterSec) {
    return {
      id,
      action: 'idle',
      reason: `no activity for ${Math.round(inactiveSec / 60)}m (> ${Math.round(idleAfterSec / 60)}m)`,
    };
  }
  return { id, action: 'keep', reason: `active ${Math.round(inactiveSec)}s ago` };
}

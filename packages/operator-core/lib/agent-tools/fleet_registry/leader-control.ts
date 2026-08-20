/**
 * Durable fleet-leader control bootstrap.
 *
 * Leadership is a control-plane state transition, not prompt advice. Every path
 * that installs a leader calls this effect so the leader holds AUTO mode, an
 * active short-cadence monitor loop, and standing wake watches for the fleet's
 * transition events. The effect is idempotent and repairs partial/stale state.
 */
import { getModes, setMode } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import {
  buildLoopWakePrompt,
  getLoopStatus,
  materializeLoop,
  type LoopStatus,
} from '../../harness/routines/loop';
import { cancelAwait, listActiveAwaits, registerAwait } from '../../events/await/store';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { getPresence } from '../coordination/presence';

export const LEADER_MONITOR_INTERVAL_SEC = 60;

export const LEADER_TRANSITION_EVENTS = [
  'member-dead',
  'claim-released',
  'item-completed',
  'context-critical',
  'drained',
] as const;

export interface LeaderControlOutcome {
  healthy: boolean;
  repaired: boolean;
  mode: { healthy: boolean; changed: boolean; error?: string };
  loop: {
    healthy: boolean;
    changed: boolean;
    harness: string | null;
    intervalSec: number | null;
    mode: LoopStatus['mode'] | null;
    error?: string;
  };
  watches: {
    healthy: boolean;
    expected: string[];
    active: string[];
    added: string[];
    repaired: string[];
    wakeReachable: boolean;
    handleNote: string | null;
    error?: string;
  };
  inboxWake: { healthy: boolean; error?: string };
  errors: string[];
}

export interface EnsureFleetLeaderControlInput {
  workspaceId: string;
  ownerId: string;
  fleetSlug: string;
  harnessSlug?: string | null;
  planSlug?: string | null;
  carry?: 'warm' | 'cold';
}

function concrete(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '*' && trimmed !== 'all' ? trimmed : null;
}

function monitorGoal(fleetSlug: string, planSlug?: string | null): string {
  return planSlug
    ? `Continuously lead and monitor fleet ${fleetSlug} until plan ${planSlug} is terminal; repair unhealthy lanes and preserve completion evidence.`
    : `Continuously lead and monitor fleet ${fleetSlug}; repair dead, stalled, blocked, or evidence-deficient lanes until its active work is terminal.`;
}

function watchKeys(fleetSlug: string): string[] {
  return LEADER_TRANSITION_EVENTS.map((transition) => `fleet:${transition}:${fleetSlug}`);
}

function selfExcludingPayloadFilter(eventKey: string, fleetSlug: string, ownerId: string): unknown | undefined {
  if (eventKey !== `fleet:member-dead:${fleetSlug}` && eventKey !== `fleet:context-critical:${fleetSlug}`) {
    return undefined;
  }
  return { not: { agentId: { equals: ownerId } } };
}

function payloadFilterMatches(actual: unknown | null | undefined, expected: unknown | undefined): boolean {
  if (expected == null) return actual == null;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export async function ensureFleetLeaderControl(
  input: EnsureFleetLeaderControlInput,
): Promise<LeaderControlOutcome> {
  const errors: string[] = [];
  let repaired = false;

  const mode = { healthy: false, changed: false } as LeaderControlOutcome['mode'];
  try {
    const held = await getModes(input.workspaceId, input.ownerId);
    if (held.some((row) => modeImpliesAutonomy(row.mode))) {
      mode.healthy = true;
    } else {
      const result = await setMode({
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        modeId: 'auto',
        enabled: true,
        reason: `fleet leadership control for '${input.fleetSlug}'`,
        setBy: input.ownerId,
      });
      mode.healthy = result.ok;
      mode.changed = result.ok;
      repaired ||= result.ok;
      if (!result.ok) throw new Error(result.error ?? 'AUTO mode write was refused');
    }
  } catch (error) {
    mode.error = error instanceof Error ? error.message : String(error);
    errors.push(`mode: ${mode.error}`);
  }

  let priorLoop: LoopStatus | null = null;
  try {
    priorLoop = await getLoopStatus(input.ownerId);
  } catch (error) {
    errors.push(`loop-read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let harness = concrete(input.harnessSlug) ?? concrete(priorLoop?.harnessSlug);
  if (!harness) {
    try {
      harness = concrete((await getPresence(input.ownerId))?.potSlug);
    } catch {
      harness = null;
    }
  }
  const loop = {
    healthy: false,
    changed: false,
    harness,
    intervalSec: priorLoop?.intervalSec ?? null,
    mode: priorLoop?.mode ?? null,
  } as LeaderControlOutcome['loop'];
  const priorLoopHealthy =
    priorLoop?.active === true &&
    priorLoop.mode === 'monitor' &&
    priorLoop.intervalSec != null &&
    priorLoop.intervalSec <= LEADER_MONITOR_INTERVAL_SEC;
  if (priorLoopHealthy) {
    loop.healthy = true;
  } else if (!harness) {
    loop.error = 'no concrete harness available for the leader monitor loop';
    errors.push(`loop: ${loop.error}`);
  } else {
    try {
      const goal = monitorGoal(input.fleetSlug, input.planSlug);
      const carry = input.carry ?? priorLoop?.carry ?? 'warm';
      const kickoff = buildLoopWakePrompt({
        ownerId: input.ownerId,
        intervalSec: LEADER_MONITOR_INTERVAL_SEC,
        harness,
        goal,
        carry,
        continuation: 'settle',
        mode: 'monitor',
      });
      await materializeLoop({
        workspaceId: input.workspaceId,
        harnessSlug: harness,
        ownerId: input.ownerId,
        intervalSec: LEADER_MONITOR_INTERVAL_SEC,
        kickoff,
        goal,
        carry,
        continuation: 'settle',
        mode: 'monitor',
      });
      loop.healthy = true;
      loop.changed = true;
      loop.intervalSec = LEADER_MONITOR_INTERVAL_SEC;
      loop.mode = 'monitor';
      repaired = true;
    } catch (error) {
      loop.error = error instanceof Error ? error.message : String(error);
      errors.push(`loop: ${loop.error}`);
    }
  }

  const inboxWake = { healthy: false } as LeaderControlOutcome['inboxWake'];
  try {
    await armInboxWake({
      ownerId: input.ownerId,
      note: `fleet leader control (${input.fleetSlug})`,
      minSleepSec: LEADER_MONITOR_INTERVAL_SEC,
    });
    inboxWake.healthy = true;
  } catch (error) {
    inboxWake.error = error instanceof Error ? error.message : String(error);
    errors.push(`inbox-wake: ${inboxWake.error}`);
  }

  const expected = watchKeys(input.fleetSlug);
  const watches = {
    healthy: false,
    expected,
    active: [] as string[],
    added: [] as string[],
    repaired: [] as string[],
    wakeReachable: false,
    handleNote: null as string | null,
  } as LeaderControlOutcome['watches'];
  try {
    const current = await listActiveAwaits(input.ownerId);
    const { handle, note } = await captureWakeHandleForOwner(input.ownerId);
    watches.handleNote = note;
    watches.wakeReachable = handle != null;

    for (const eventKey of expected) {
      const rows = current.filter((row) => row.eventKey === eventKey);
      const payloadFilter = selfExcludingPayloadFilter(eventKey, input.fleetSlug, input.ownerId);
      const healthy = rows.find(
        (row) =>
          row.policy === 'wake' &&
          row.once === false &&
          row.wakeHandle != null &&
          payloadFilterMatches(row.payloadFilter, payloadFilter),
      );
      if (healthy) {
        watches.active.push(eventKey);
        continue;
      }
      for (const row of rows) await cancelAwait({ awaitId: row.id, subscriberId: input.ownerId });
      const row = await registerAwait({
        subscriberId: input.ownerId,
        eventKey,
        policy: 'wake',
        note: `standing fleet leader transition watch (${input.fleetSlug})`,
        wakeHandle: handle,
        timeoutBehavior: 'wake',
        timeoutSec: null,
        once: false,
        minSleepSec: LEADER_MONITOR_INTERVAL_SEC,
        ...(payloadFilter == null ? {} : { payloadFilter }),
      });
      watches.active.push(eventKey);
      if (rows.length > 0) watches.repaired.push(eventKey);
      else watches.added.push(eventKey);
      repaired = true;
      if (row.wakeHandle == null) watches.wakeReachable = false;
    }
    watches.healthy = watches.active.length === expected.length && watches.wakeReachable;
    if (!watches.wakeReachable) {
      watches.error = 'transition watches are registered but no resumable wake handle is available yet';
      errors.push(`watches: ${watches.error}`);
    }
  } catch (error) {
    watches.error = error instanceof Error ? error.message : String(error);
    errors.push(`watches: ${watches.error}`);
  }

  return {
    healthy: mode.healthy && loop.healthy && inboxWake.healthy && watches.healthy,
    repaired,
    mode,
    loop,
    watches,
    inboxWake,
    errors,
  };
}

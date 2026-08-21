/**
 * fleet-transition-events.test — the P-009 / D-008 leader transition feed.
 *
 * The behaviours worth pinning are the ones that make a monitor TRUSTWORTHY: it
 * fires on a real crossing, and it does NOT fire on a first sighting, a steady
 * state, a disappearance, or an unconfirmed liveness suspicion. A monitor that
 * cries wolf is worse than no monitor — the leader learns to ignore it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  announceFleetItemCompleted,
  detectFleetTransitions,
  emitFleetClaimReleasedEvent,
  emitFleetItemCompletedEvent,
  emitFleetTransitionEdge,
  fleetTransitionKey,
  indexObservations,
  type FleetMemberObservation,
} from './fleet-transition-events';

const member = (over: Partial<FleetMemberObservation> = {}): FleetMemberObservation => ({
  agentId: 'su-a',
  fleetSlug: 'push-not-poll',
  sessionState: 'live',
  contextPressure: 'ok',
  ...over,
});

/** Await the fire-and-forget microtask chain the emitters use. */
const settle = () => new Promise((r) => setImmediate(r));

describe('fleetTransitionKey', () => {
  it('builds the fleet-scoped key shape the catalog advertises', () => {
    expect(fleetTransitionKey('push-not-poll', 'member-dead')).toBe('fleet:member-dead:push-not-poll');
    expect(fleetTransitionKey('push-not-poll', 'item-completed')).toBe('fleet:item-completed:push-not-poll');
  });

  it('puts the SLUG LAST so the catalog prefix stays precise — a slug-first template would truncate to `fleet:` and match every fleet key', () => {
    // The regression this shape exists to prevent: familyKeyPrefix truncates a
    // template at its first placeholder, so `fleet:<slug>:member-dead` would
    // register the prefix `fleet:` and silently disarm the orphan guard for the
    // whole namespace. Uniform with the pre-existing `fleet:drained:<slug>`.
    for (const kind of ['member-dead', 'context-critical', 'claim-released', 'item-completed'] as const) {
      expect(fleetTransitionKey('any-slug', kind).startsWith(`fleet:${kind}:`)).toBe(true);
    }
  });
});

describe('detectFleetTransitions', () => {
  it('fires member-dead on the live → ended crossing', () => {
    const prev = indexObservations([member({ sessionState: 'live' })]);
    const edges = detectFleetTransitions(prev, [member({ sessionState: 'ended' })]);
    expect(edges).toEqual([
      { kind: 'member-dead', fleetSlug: 'push-not-poll', agentId: 'su-a', to: 'ended', from: 'live' },
    ]);
  });

  it('fires context-critical on the high → critical crossing', () => {
    const prev = indexObservations([member({ contextPressure: 'high' })]);
    const edges = detectFleetTransitions(prev, [member({ contextPressure: 'critical' })]);
    expect(edges).toEqual([
      { kind: 'context-critical', fleetSlug: 'push-not-poll', agentId: 'su-a', to: 'critical', from: 'high' },
    ]);
  });

  it('does NOT fire on a first sighting — an already-dead member seen for the first time is not a crossing', () => {
    // Rule 1. Without it the first sweep after any operator restart wakes every
    // leader for every historically-dead row still in the roster.
    expect(detectFleetTransitions(new Map(), [member({ sessionState: 'ended' })])).toEqual([]);
    expect(detectFleetTransitions(new Map(), [member({ contextPressure: 'critical' })])).toEqual([]);
  });

  it('does NOT re-fire while the member STAYS dead or STAYS critical', () => {
    // Rule 2. Both states persist for many sweeps; re-firing is a wake storm.
    const dead = indexObservations([member({ sessionState: 'ended', contextPressure: 'critical' })]);
    expect(detectFleetTransitions(dead, [member({ sessionState: 'ended', contextPressure: 'critical' })])).toEqual([]);
  });

  it('does NOT treat draining or suspect as dead — both need a wake confirmation first (WI-4400)', () => {
    const prev = indexObservations([member({ sessionState: 'live' })]);
    expect(detectFleetTransitions(prev, [member({ sessionState: 'draining' })])).toEqual([]);
    expect(detectFleetTransitions(prev, [member({ sessionState: 'suspect' })])).toEqual([]);
  });

  it('does NOT treat a DISAPPEARANCE as a death — a reaped row and a departed member are indistinguishable', () => {
    const prev = indexObservations([member({ sessionState: 'live' })]);
    expect(detectFleetTransitions(prev, [])).toEqual([]);
  });

  it('re-fires when a member recovers and then dies again — the crossing is what matters, not the history', () => {
    const dead = indexObservations([member({ sessionState: 'ended' })]);
    expect(detectFleetTransitions(dead, [member({ sessionState: 'live' })])).toEqual([]);
    const revived = indexObservations([member({ sessionState: 'live' })]);
    expect(detectFleetTransitions(revived, [member({ sessionState: 'ended' })])).toHaveLength(1);
  });

  it('scopes a member to its fleet — the same agent id in a different fleet is a different member, so no crossing', () => {
    const prev = indexObservations([member({ fleetSlug: 'fleet-a', sessionState: 'live' })]);
    expect(detectFleetTransitions(prev, [member({ fleetSlug: 'fleet-b', sessionState: 'ended' })])).toEqual([]);
  });

  it('emits BOTH edges when a member dies and goes critical in the same sweep', () => {
    const prev = indexObservations([member({ sessionState: 'live', contextPressure: 'ok' })]);
    const edges = detectFleetTransitions(prev, [member({ sessionState: 'ended', contextPressure: 'critical' })]);
    expect(edges.map((e) => e.kind).sort()).toEqual(['context-critical', 'member-dead']);
  });

  it('returns a deterministic order across fleets and members', () => {
    const prev = indexObservations([
      member({ fleetSlug: 'b-fleet', agentId: 'su-z', sessionState: 'live' }),
      member({ fleetSlug: 'a-fleet', agentId: 'su-y', sessionState: 'live' }),
      member({ fleetSlug: 'a-fleet', agentId: 'su-x', sessionState: 'live' }),
    ]);
    const edges = detectFleetTransitions(prev, [
      member({ fleetSlug: 'b-fleet', agentId: 'su-z', sessionState: 'ended' }),
      member({ fleetSlug: 'a-fleet', agentId: 'su-y', sessionState: 'ended' }),
      member({ fleetSlug: 'a-fleet', agentId: 'su-x', sessionState: 'ended' }),
    ]);
    expect(edges.map((e) => `${e.fleetSlug}/${e.agentId}`)).toEqual(['a-fleet/su-x', 'a-fleet/su-y', 'b-fleet/su-z']);
  });
});

describe('emitFleetTransitionEdge', () => {
  it('emits the fleet-scoped key with the crossing in the payload, awaiter-only (no `to` push)', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetTransitionEdge(
      { kind: 'member-dead', fleetSlug: 'push-not-poll', agentId: 'su-a', to: 'ended', from: 'live' },
      { emit },
    );
    await settle();
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0][0];
    expect(arg.key).toBe('fleet:member-dead:push-not-poll');
    expect(arg.payload).toMatchObject({ fleetSlug: 'push-not-poll', agentId: 'su-a', from: 'live', to: 'ended' });
    expect(arg.to).toBeUndefined();
  });

  it('never throws when the emit rejects — a monitor emit can never break its caller', async () => {
    const emit = vi.fn().mockRejectedValue(new Error('relation "x" does not exist'));
    expect(() =>
      emitFleetTransitionEdge(
        { kind: 'context-critical', fleetSlug: 'f', agentId: 'su-a', to: 'critical', from: 'high' },
        { emit },
      ),
    ).not.toThrow();
    await settle();
  });
});

describe('the work-item co-fires', () => {
  it('emits fleet:<slug>:claim-released carrying the PRIOR holder', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetClaimReleasedEvent('push-not-poll', { id: 'WI-1', title: 't', harness: 'papercusp' }, 'su-a', { emit });
    await settle();
    expect(emit.mock.calls[0][0].key).toBe('fleet:claim-released:push-not-poll');
    expect(emit.mock.calls[0][0].payload).toMatchObject({ id: 'WI-1', priorAssignee: 'su-a' });
  });

  it('emits fleet:<slug>:item-completed carrying the settling state and holder', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetItemCompletedEvent('push-not-poll', { id: 'WI-1', state: 'resolved', assignee: 'su-a' }, { emit });
    await settle();
    expect(emit.mock.calls[0][0].key).toBe('fleet:item-completed:push-not-poll');
    expect(emit.mock.calls[0][0].payload).toMatchObject({ id: 'WI-1', state: 'resolved', assignee: 'su-a' });
  });

  it('resolves and attributes a terminal event from the pre-clear holder without mutating the post-state item', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const fleetOfAgent = vi.fn(async (_workspaceId: string, ownerId: string) =>
      ownerId === 'su-a' ? 'push-not-poll' : null,
    );
    const item = { id: 'WI-1', state: 'resolved', assignee: null };

    announceFleetItemCompleted(item, 'su-a', {
      emit,
      fleetOfAgent,
      workspaceId: async () => 'workspace-1',
    });
    await settle();

    expect(fleetOfAgent).toHaveBeenCalledWith('workspace-1', 'su-a');
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0].payload).toMatchObject({
      id: 'WI-1',
      state: 'resolved',
      assignee: 'su-a',
    });
    expect(item.assignee).toBeNull();
  });

  it('fires NOTHING when the holder is in no fleet — an unfleeted release is not a fleet transition', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetClaimReleasedEvent(null, { id: 'WI-1' }, 'su-a', { emit });
    emitFleetClaimReleasedEvent(undefined, { id: 'WI-1' }, 'su-a', { emit });
    emitFleetItemCompletedEvent(null, { id: 'WI-1', state: 'resolved' }, { emit });
    await settle();
    expect(emit).not.toHaveBeenCalled();
  });
});

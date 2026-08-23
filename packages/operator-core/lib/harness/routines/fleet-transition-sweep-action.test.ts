/**
 * fleet-transition-sweep-action.test — the sweep that drives P-009's two DERIVED
 * transitions (member-dead, context-critical).
 *
 * The sweep's whole job is to carry state between rounds correctly. The cases that
 * matter are the ones where getting that wrong produces a monitor nobody trusts:
 * firing on the first round (a restart storm), re-firing while a state persists (a
 * wake storm), and — the subtle one — failing to advance the snapshot when nothing
 * fired, which would make the sweep permanently blind to the next crossing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFleetTransitionSnapshotForTests,
  runFleetTransitionSweep,
} from './fleet-transition-sweep-action';
import type { FleetMemberObservation } from '../../fleet-transition-events';

const member = (over: Partial<FleetMemberObservation> = {}): FleetMemberObservation => ({
  agentId: 'su-a',
  fleetSlug: 'push-not-poll',
  sessionState: 'live',
  contextPressure: 'ok',
  ...over,
});

const settle = () => new Promise((r) => setImmediate(r));

/** Drive a scripted sequence of sweeps, returning the keys emitted per round. */
async function sweepRounds(rounds: FleetMemberObservation[][]): Promise<string[][]> {
  const perRound: string[][] = [];
  for (const observations of rounds) {
    const emit = vi.fn().mockResolvedValue(undefined);
    await runFleetTransitionSweep({ gather: async () => observations, emit });
    await settle();
    perRound.push(emit.mock.calls.map((c) => c[0].key as string));
  }
  return perRound;
}

beforeEach(() => {
  __resetFleetTransitionSnapshotForTests();
});

describe('runFleetTransitionSweep', () => {
  it('is SILENT on the first sweep, then fires on the crossing in the second', async () => {
    const rounds = await sweepRounds([[member({ sessionState: 'live' })], [member({ sessionState: 'ended' })]]);
    expect(rounds[0]).toEqual([]);
    expect(rounds[1]).toEqual(['fleet:member-dead:push-not-poll']);
  });

  it('does not fire on the FIRST sweep even when a member is already dead — the restart-storm guard', async () => {
    const rounds = await sweepRounds([[member({ sessionState: 'ended', contextPressure: 'critical' })]]);
    expect(rounds[0]).toEqual([]);
  });

  it('fires ONCE for a state that persists across many sweeps', async () => {
    const rounds = await sweepRounds([
      [member({ sessionState: 'live' })],
      [member({ sessionState: 'ended' })],
      [member({ sessionState: 'ended' })],
      [member({ sessionState: 'ended' })],
    ]);
    expect(rounds.map((r) => r.length)).toEqual([0, 1, 0, 0]);
  });

  it('ADVANCES the snapshot on a quiet sweep — otherwise the next crossing is invisible', async () => {
    // The regression this pins: if the sweep only stored a snapshot when it fired,
    // round 2's transition to 'high' would be dropped and round 3 would compare
    // against round 1, so a genuine high→critical crossing could be missed or
    // mis-attributed. Three rounds where only the LAST is a crossing.
    const rounds = await sweepRounds([
      [member({ contextPressure: 'ok' })],
      [member({ contextPressure: 'high' })],
      [member({ contextPressure: 'critical' })],
    ]);
    expect(rounds).toEqual([[], [], ['fleet:context-critical:push-not-poll']]);
  });

  it('returns the number of edges it fired', async () => {
    await runFleetTransitionSweep({ gather: async () => [member({ sessionState: 'live' })], emit: vi.fn() });
    const fired = await runFleetTransitionSweep({
      gather: async () => [member({ sessionState: 'ended', contextPressure: 'critical' })],
      emit: vi.fn().mockResolvedValue(undefined),
    });
    expect(fired).toBe(2);
  });

  it('revalidates a context-critical edge against the current writer before delivery', async () => {
    await runFleetTransitionSweep({
      gather: async () => [member({ contextPressure: 'high' })],
      emit: vi.fn(),
    });
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentContextPressure = vi.fn(async () => 'ok' as const);

    await runFleetTransitionSweep({
      gather: async () => [member({ contextPressure: 'critical' })],
      emit,
      currentContextPressure,
    });
    await settle();

    expect(currentContextPressure).toHaveBeenCalledWith('su-a');
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not snapshot recorded, non-wakeable, claimless stand-down residue', async () => {
    const rounds = await sweepRounds([
      [member({ contextPressure: 'high', wakeable: true, claimCount: 1 })],
      [member({ sessionState: 'recorded', contextPressure: 'critical', wakeable: false, claimCount: 0 })],
    ]);
    expect(rounds).toEqual([[], []]);
  });

  it('keeps fleets independent — a crossing in one fleet is not attributed to another', async () => {
    const a = member({ agentId: 'su-a', fleetSlug: 'fleet-a' });
    const b = member({ agentId: 'su-b', fleetSlug: 'fleet-b' });
    const rounds = await sweepRounds([
      [a, b],
      [{ ...a, sessionState: 'ended' }, b],
    ]);
    expect(rounds[1]).toEqual(['fleet:member-dead:fleet-a']);
  });

  it('treats an empty observation set as a quiet sweep, not a mass death', async () => {
    const rounds = await sweepRounds([[member({ sessionState: 'live' })], []]);
    expect(rounds[1]).toEqual([]);
  });
});

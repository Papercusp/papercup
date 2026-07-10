/**
 * fleet-monitor-delta — the pure fingerprint/diff/slim half of orient's
 * monitor-mode fleet delta (fleet-deltas-leader-primitives-2026-07-10 P-004).
 */
import { describe, it, expect } from 'vitest';
import { fingerprintFleet, diffFleet, slimAssignmentsForDelta, type FleetFingerprint } from './fleet-monitor-delta';

const roster = (agents: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  summary: { agents: agents.length },
  agents,
  orphaned: [],
  stalled: [],
  ...extra,
});

describe('fingerprintFleet', () => {
  it('projects assignments rows to compact per-member scalars', () => {
    const fp = fingerprintFleet(
      roster([
        { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', doing: 'WI-1', claims: 2 },
        { agentId: 'su-b', verdict: 'stalled', sessionState: 'live', doing: { id: 'WI-2', title: 'x' }, claims: 1 },
      ]),
    );
    expect(fp).toEqual({
      members: {
        'su-a': { v: 'speaking', s: 'live', d: 'WI-1', c: 2 },
        'su-b': { v: 'stalled', s: 'live', d: 'WI-2', c: 1 },
      },
      orphaned: 0,
      stalled: 0,
    });
  });

  it('counts orphaned/stalled claims and skips id-less rows', () => {
    const fp = fingerprintFleet(roster([{ verdict: 'dead' }], { orphaned: [{}, {}], stalled: [{}] }));
    expect(fp).toEqual({ members: {}, orphaned: 2, stalled: 1 });
  });

  it('returns null on an unrecognizable shape (fail-open for the caller)', () => {
    expect(fingerprintFleet(null)).toBeNull();
    expect(fingerprintFleet('a TOON string')).toBeNull();
    expect(fingerprintFleet({ ok: true })).toBeNull();
  });
});

describe('diffFleet', () => {
  const base: FleetFingerprint = {
    members: {
      'su-a': { v: 'speaking', s: 'live', d: 'WI-1', c: 2 },
      'su-b': { v: 'joined', s: 'live', c: 0 },
    },
    orphaned: 0,
    stalled: 0,
  };

  it('emits a transition row per changed member; unchanged members are only counted', () => {
    const d = diffFleet(base, {
      members: {
        'su-a': { v: 'speaking', s: 'live', d: 'WI-1', c: 2 }, // unchanged
        'su-b': { v: 'stalled', s: 'live', c: 0 }, // verdict transition
      },
      orphaned: 0,
      stalled: 1,
    });
    expect(d.rows).toEqual([
      { change: 'updated', type: 'member', id: 'su-b', from: { v: 'joined', s: 'live', c: 0 }, to: { v: 'stalled', s: 'live', c: 0 } },
    ]);
    expect(d.unchanged).toBe(1);
    expect(d.stalled).toEqual({ from: 0, to: 1 });
    expect(d.orphaned).toBeUndefined();
  });

  it('emits added/removed rows for joins and departures', () => {
    const d = diffFleet(base, {
      members: { 'su-a': { v: 'speaking', s: 'live', d: 'WI-1', c: 2 }, 'su-c': { v: 'booted' } },
      orphaned: 0,
      stalled: 0,
    });
    expect(d.rows).toEqual([
      { change: 'added', type: 'member', id: 'su-c', to: { v: 'booted' } },
      { change: 'removed', type: 'member', id: 'su-b', from: { v: 'joined', s: 'live', c: 0 } },
    ]);
  });

  it('a quiet fleet diffs to zero rows (the whole point: a quiet wake costs ~nothing)', () => {
    const d = diffFleet(base, base);
    expect(d.rows).toEqual([]);
    expect(d.unchanged).toBe(2);
  });
});

describe('slimAssignmentsForDelta', () => {
  it('keeps only the self row + a peer-elision count; everything else passes through', () => {
    const me = roster([
      { agentId: 'su-a', isSelf: true, verdict: 'speaking' },
      { agentId: 'su-b' },
      { agentId: 'su-c' },
    ]);
    const slim = slimAssignmentsForDelta(me) as { agents: unknown[]; agentsElided: number; summary: unknown };
    expect(slim.agents).toEqual([{ agentId: 'su-a', isSelf: true, verdict: 'speaking' }]);
    expect(slim.agentsElided).toBe(2);
    expect(slim.summary).toEqual({ agents: 3 });
  });

  it('passes a non-roster shape through untouched (fail-open)', () => {
    expect(slimAssignmentsForDelta('toon')).toBe('toon');
    expect(slimAssignmentsForDelta(null)).toBeNull();
  });
});

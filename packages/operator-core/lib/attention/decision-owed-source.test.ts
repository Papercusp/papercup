import { describe, expect, it } from 'vitest';
import { findUnmatchedDecisionGates, type DecisionOwedCandidate, type DecisionRecordEvent } from './decision-owed-source';

function gate(overrides: Partial<DecisionOwedCandidate> = {}): DecisionOwedCandidate {
  return {
    sessionId: 'sess-1',
    refId: 'toolu_1',
    client: 'claude',
    question: 'Should we co-locate the Queen with the Hive?',
    options: [{ label: 'Yes' }, { label: 'No' }],
    closedAt: '2026-07-20T12:00:00.000Z',
    ownerId: 'su-abc',
    harnessSlug: 'papercusp',
    ...overrides,
  };
}

const ASOF = '2026-07-20T18:00:00.000Z';

describe('findUnmatchedDecisionGates (EI-147 mechanical decisions-owed heuristic)', () => {
  it('flags a closed ask with no decision-recording call at all as owed', () => {
    const result = findUnmatchedDecisionGates([gate()], [], ASOF);
    expect(result).toHaveLength(1);
    expect(result[0]?.refId).toBe('toolu_1');
  });

  it('clears a closed ask when the SAME owner recorded a decision AFTER it closed', () => {
    const events: DecisionRecordEvent[] = [{ ownerId: 'su-abc', invokedAt: '2026-07-20T12:30:00.000Z' }];
    const result = findUnmatchedDecisionGates([gate()], events, ASOF);
    expect(result).toHaveLength(0);
  });

  it('does NOT clear it when the decision was recorded BEFORE the gate closed (a stale/unrelated decision)', () => {
    const events: DecisionRecordEvent[] = [{ ownerId: 'su-abc', invokedAt: '2026-07-20T11:00:00.000Z' }];
    const result = findUnmatchedDecisionGates([gate()], events, ASOF);
    expect(result).toHaveLength(1);
  });

  it('does NOT clear it when a DIFFERENT owner recorded a decision in the window (misattribution guard)', () => {
    const events: DecisionRecordEvent[] = [{ ownerId: 'su-someone-else', invokedAt: '2026-07-20T12:30:00.000Z' }];
    const result = findUnmatchedDecisionGates([gate()], events, ASOF);
    expect(result).toHaveLength(1);
  });

  it('does NOT clear it when the decision landed AFTER asOfIso (out of the evaluated window)', () => {
    const events: DecisionRecordEvent[] = [{ ownerId: 'su-abc', invokedAt: '2026-07-21T00:00:00.000Z' }];
    const result = findUnmatchedDecisionGates([gate()], events, ASOF);
    expect(result).toHaveLength(1);
  });

  it('drops a candidate with no resolvable ownerId rather than false-flagging it', () => {
    const result = findUnmatchedDecisionGates([gate({ ownerId: null })], [], ASOF);
    expect(result).toHaveLength(0);
  });

  it('a decision recorded EXACTLY at closedAt or exactly at asOfIso counts (inclusive bounds)', () => {
    const atClose = findUnmatchedDecisionGates(
      [gate()],
      [{ ownerId: 'su-abc', invokedAt: gate().closedAt }],
      ASOF,
    );
    expect(atClose).toHaveLength(0);
    const atAsOf = findUnmatchedDecisionGates([gate()], [{ ownerId: 'su-abc', invokedAt: ASOF }], ASOF);
    expect(atAsOf).toHaveLength(0);
  });

  it('handles multiple gates + multiple owners independently', () => {
    const gates = [
      gate({ refId: 'a', ownerId: 'su-1' }),
      gate({ refId: 'b', ownerId: 'su-2' }),
      gate({ refId: 'c', ownerId: 'su-1', closedAt: '2026-07-20T15:00:00.000Z' }),
    ];
    const events: DecisionRecordEvent[] = [
      // su-1 recorded once, right after gate 'a' closed — covers 'a' but not
      // the later gate 'c' (its own closedAt is after this call).
      { ownerId: 'su-1', invokedAt: '2026-07-20T12:05:00.000Z' },
    ];
    const result = findUnmatchedDecisionGates(gates, events, ASOF);
    expect(result.map((r) => r.refId).sort()).toEqual(['b', 'c']);
  });

  it('an owner with zero recorded events anywhere in the input still flags every one of their gates', () => {
    const gates = [gate({ refId: 'x', ownerId: 'su-9' }), gate({ refId: 'y', ownerId: 'su-9' })];
    const result = findUnmatchedDecisionGates(gates, [], ASOF);
    expect(result.map((r) => r.refId).sort()).toEqual(['x', 'y']);
  });

  it('ignores decision events with an unparseable invokedAt rather than throwing', () => {
    const events: DecisionRecordEvent[] = [{ ownerId: 'su-abc', invokedAt: 'not-a-date' }];
    const result = findUnmatchedDecisionGates([gate()], events, ASOF);
    expect(result).toHaveLength(1);
  });

  it('drops a candidate with an unparseable closedAt rather than throwing', () => {
    const result = findUnmatchedDecisionGates([gate({ closedAt: 'not-a-date' })], [], ASOF);
    expect(result).toHaveLength(0);
  });

  it('returns [] for an empty input', () => {
    expect(findUnmatchedDecisionGates([], [], ASOF)).toEqual([]);
  });
});

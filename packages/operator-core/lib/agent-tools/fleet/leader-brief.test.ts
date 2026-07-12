/**
 * leader-brief.test.ts — fleet-reliability-verification-2026-07-10 P-007.
 *
 * projectMember is the PURE per-member reshape (fleet:assignments'
 * decoration output → the leader-lean brief row) — unit-tested directly, no
 * PG/DI ceremony (mirrors deriveMemberVerdict/deriveContextPressure).
 */
import { describe, expect, it } from 'vitest';
import { computeBenchSuggestion, projectMember, type DecoratedAgent } from './leader-brief';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');

function baseAgent(overrides: Partial<DecoratedAgent> = {}): DecoratedAgent {
  return {
    agentId: 'su-1',
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: new Date(NOW).toISOString(),
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: 'p2p-git',
    fleetRole: 'member',
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...overrides,
  };
}

describe('projectMember (pure)', () => {
  it('computes lastToolCallAgeMs from the ISO timestamp', () => {
    const agent = baseAgent({ lastToolCallAt: new Date(NOW - 5_000).toISOString() });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBe(5_000);
  });

  it('null lastToolCallAgeMs when the member has never taken a turn', () => {
    const agent = baseAgent({ lastToolCallAt: null });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBeNull();
  });

  it('collapses claims to queuedCount/load, never the full claim list', () => {
    const agent = baseAgent({ queued: [{ id: 'WI-1' }, { id: 'WI-2' }] as never, load: 3 });
    const m = projectMember(agent, NOW);
    expect(m.queuedCount).toBe(2);
    expect(m.load).toBe(3);
    expect('claims' in m).toBe(false);
  });

  it('omits `unanswered` when absent — never a bare zero/empty stub', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect('unanswered' in m).toBe(false);
  });

  it('carries `unanswered` verbatim when the decoration stamped one', () => {
    const unanswered = { count: 2, oldestAgeMs: 90_000, newest: [{ msgId: 'm1', from: 'su-2', ageMs: 1000 }] };
    const m = projectMember(baseAgent({ unanswered }), NOW);
    expect(m.unanswered).toEqual(unanswered);
  });

  it('omits `parkedOn` when empty/absent, carries it when non-empty (bench state)', () => {
    expect('parkedOn' in projectMember(baseAgent({ parkedOn: [] }), NOW)).toBe(false);
    const m = projectMember(baseAgent({ parkedOn: ['p2p-git:phase3-open'] }), NOW);
    expect(m.parkedOn).toEqual(['p2p-git:phase3-open']);
  });

  it('carries verdict/sessionState/wakeMode/contextPressure through as null when unstamped', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect(m.verdict).toBeNull();
    expect(m.sessionState).toBeNull();
    expect(m.wakeMode).toBeNull();
    expect(m.contextPressure).toBeNull();
  });
});

describe('computeBenchSuggestion (pure, EI-9943)', () => {
  const doing = { id: 'WI-1', itemKind: 'bug', title: 'stuck thing', status: 'open', rank: 0, rankWriter: null, activity: 'stalled' as const };

  it('flags a speaking member whose claim is stalled and not already benched', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing });
    expect(s).toBeDefined();
    expect(s?.item).toBe('WI-1');
    expect(s?.itemTitle).toBe('stuck thing');
  });

  it('also flags first-turn-done (not just speaking) — the between-wakes window', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'first-turn-done', parkedOn: [], doing });
    expect(s).toBeDefined();
  });

  it('does NOT flag an already-benched member (parkedOn non-empty) — avoid re-nudging', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: ['some:event'], doing });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a member that is not stalled', () => {
    const s = computeBenchSuggestion({ stalled: false, verdict: 'speaking', parkedOn: [], doing: null });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a dead/booted/joined member — not burning turns, relaunch is the right lever', () => {
    for (const verdict of ['dead', 'booted', 'joined', 'stalled', null] as const) {
      expect(computeBenchSuggestion({ stalled: true, verdict, parkedOn: [], doing })).toBeUndefined();
    }
  });

  it('projectMember surfaces benchSuggestion only when computeBenchSuggestion fires', () => {
    const flagged = projectMember(baseAgent({ stalled: true, verdict: 'speaking', parkedOn: [], doing }), NOW);
    expect(flagged.benchSuggestion).toBeDefined();
    const benched = projectMember(baseAgent({ stalled: true, verdict: 'speaking', parkedOn: ['k'], doing }), NOW);
    expect('benchSuggestion' in benched).toBe(false);
  });
});

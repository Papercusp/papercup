/** ambient-push (ambient-semantic-push P-003 pure part, plan D-002/D-004/D-006):
 *  the delivery-SELECTION core — typed push object + query handle, severity gate,
 *  novelty/dedup, per-class budget, auditable drops. Pure; live legs (coord
 *  injection rail + transport + handle resolution) deferred DEFAULT-OFF. */
import { describe, it, expect } from 'vitest';
import {
  SEVERITY_BY_MATCHER,
  TEASER_MAX_CHARS,
  DEFAULT_PUSH_POLICIES,
  makePush,
  isNovelPush,
  selectPushes,
  collisionToPush,
  policyFor,
  type MatcherKind,
  type PushSeverity,
  type PushObject,
} from './ambient-push';

function mkPush(opts: { matcherKind?: MatcherKind; ref?: string; score?: number; query?: string[]; severity?: PushSeverity } = {}): PushObject {
  return makePush({
    matcherKind: opts.matcherKind ?? 'collision',
    handle: { kind: 'session', ref: opts.ref ?? 's1', query: opts.query ?? ['alpha'] },
    teaser: 'teaser for ' + (opts.ref ?? 's1'),
    score: opts.score ?? 0.9,
    severity: opts.severity,
  });
}

describe('makePush + severity map', () => {
  it('maps each matcher to its severity (collision critical … insight info)', () => {
    expect(SEVERITY_BY_MATCHER).toEqual({ collision: 'critical', 'dead-end': 'warning', 'topic-sub': 'info', insight: 'info' });
  });

  it('stamps data-not-directive, defaults severity from the matcher, defaults sourceSessionId null', () => {
    const p = mkPush({ matcherKind: 'dead-end' });
    expect(p.provenance).toBe('data-not-directive');
    expect(p.severity).toBe('warning');
    expect(p.sourceSessionId).toBeNull();
  });

  it('clamps the teaser to one bounded line', () => {
    const p = makePush({
      matcherKind: 'collision',
      handle: { kind: 'session', ref: 's1', query: [] },
      teaser: 'line one\n\nline two   with     gaps ' + 'x'.repeat(400),
      score: 0.9,
    });
    expect(p.teaser.length).toBeLessThanOrEqual(TEASER_MAX_CHARS);
    expect(p.teaser).not.toContain('\n');
    expect(p.teaser).not.toContain('  ');
  });

  it('honors an explicit severity override', () => {
    expect(mkPush({ matcherKind: 'insight', severity: 'critical' }).severity).toBe('critical');
  });
});

describe('isNovelPush — dedup vs carry + recent context', () => {
  it('drops a push whose handle ref the agent already carries', () => {
    expect(isNovelPush(mkPush({ ref: 'WI-1' }), { refs: new Set(['WI-1']) })).toBe(false);
  });

  it('keeps a push with a fresh ref', () => {
    expect(isNovelPush(mkPush({ ref: 'WI-2' }), { refs: new Set(['WI-1']) })).toBe(true);
  });

  it('with terms supplied, drops a push whose every query term is already salient', () => {
    const known = { refs: new Set<string>(), terms: new Set(['alpha', 'beta']) };
    expect(isNovelPush(mkPush({ ref: 'WI-9', query: ['alpha', 'beta'] }), known)).toBe(false);
    expect(isNovelPush(mkPush({ ref: 'WI-9', query: ['alpha', 'gamma'] }), known)).toBe(true); // gamma is new
  });

  it('dedups on refs alone when terms are omitted', () => {
    expect(isNovelPush(mkPush({ ref: 'WI-9', query: ['alpha'] }), { refs: new Set(['other']) })).toBe(true);
  });
});

describe('selectPushes — floor → severity → novelty → budget', () => {
  const emptyKnown = { refs: new Set<string>() };

  it('drops below-floor matches (high similarity floor)', () => {
    const res = selectPushes({ candidates: [mkPush({ ref: 'a', score: 0.3 })], sessionClass: 'drone', known: emptyKnown });
    expect(res.selected).toHaveLength(0);
    expect(res.dropped).toEqual([{ push: expect.objectContaining({ handle: expect.objectContaining({ ref: 'a' }) }), reason: 'below-floor' }]);
  });

  it('severity-gates a drone: info never reaches it, collision does', () => {
    const res = selectPushes({
      candidates: [mkPush({ ref: 'info1', matcherKind: 'insight' }), mkPush({ ref: 'col1', matcherKind: 'collision' })],
      sessionClass: 'drone',
      known: emptyKnown,
    });
    expect(res.selected.map((p) => p.handle.ref)).toEqual(['col1']);
    expect(res.dropped).toContainEqual(expect.objectContaining({ reason: 'severity-gated' }));
  });

  it('an interactive session DOES receive info', () => {
    const res = selectPushes({ candidates: [mkPush({ ref: 'i1', matcherKind: 'insight', score: 0.5 })], sessionClass: 'interactive', known: emptyKnown });
    expect(res.selected.map((p) => p.handle.ref)).toEqual(['i1']);
  });

  it('drops not-novel candidates', () => {
    const res = selectPushes({ candidates: [mkPush({ ref: 'known1' })], sessionClass: 'drone', known: { refs: new Set(['known1']) } });
    expect(res.selected).toHaveLength(0);
    expect(res.dropped[0].reason).toBe('not-novel');
  });

  it('caps to the class budget, dropping the overflow as budget-exhausted', () => {
    const res = selectPushes({
      candidates: [mkPush({ ref: 'a' }), mkPush({ ref: 'b' }), mkPush({ ref: 'c' })], // drone budget = 2
      sessionClass: 'drone',
      known: emptyKnown,
    });
    expect(res.selected).toHaveLength(2);
    expect(res.dropped.filter((d) => d.reason === 'budget-exhausted')).toHaveLength(1);
  });

  it('sorts most-urgent first: severity outranks score', () => {
    const res = selectPushes({
      candidates: [
        mkPush({ ref: 'warn-hi', matcherKind: 'dead-end', score: 0.95 }),
        mkPush({ ref: 'crit-lo', matcherKind: 'collision', score: 0.5 }),
      ],
      sessionClass: 'interactive',
      known: emptyKnown,
    });
    expect(res.selected.map((p) => p.handle.ref)).toEqual(['crit-lo', 'warn-hi']);
  });

  it('alreadyDelivered eats into the remaining budget', () => {
    const res = selectPushes({
      candidates: [mkPush({ ref: 'a' }), mkPush({ ref: 'b' })],
      sessionClass: 'drone', // budget 2
      known: emptyKnown,
      alreadyDelivered: 1,
    });
    expect(res.selected).toHaveLength(1);
    expect(res.dropped.filter((d) => d.reason === 'budget-exhausted')).toHaveLength(1);
  });

  it('accepts a policy override and echoes it back', () => {
    const policy = { budget: 1, allowedSeverities: new Set<PushSeverity>(['critical']), minScore: 0 };
    const res = selectPushes({ candidates: [mkPush({ ref: 'a', score: 0.01 })], sessionClass: 'drone', known: emptyKnown, policy });
    expect(res.policy).toBe(policy);
    expect(res.selected).toHaveLength(1); // floor 0 lets the 0.01 through
  });

  it('an unknown session class falls back to the (tightest) drone policy', () => {
    expect(policyFor('nope' as never)).toBe(DEFAULT_PUSH_POLICIES.drone);
  });
});

describe('collisionToPush — peer collision → push object', () => {
  it('builds a collision-severity push pointing at the peer session, shared terms as query', () => {
    const push = collisionToPush({
      sessionId: 's-peer',
      overlap: { score: 0.8, sharedTerms: [{ term: 'WI-4790' }, { term: 'compaction' }, { term: 'psu-launcher.mjs' }] },
    });
    expect(push.matcherKind).toBe('collision');
    expect(push.severity).toBe('critical');
    expect(push.provenance).toBe('data-not-directive');
    expect(push.handle).toEqual({ kind: 'session', ref: 's-peer', query: ['WI-4790', 'compaction', 'psu-launcher.mjs'] });
    expect(push.sourceSessionId).toBe('s-peer');
    expect(push.score).toBe(0.8);
    expect(push.teaser).toContain('s-peer');
    expect(push.teaser).toContain('WI-4790');
  });

  it('caps the shared-term list in teaser and handle query', () => {
    const push = collisionToPush(
      { sessionId: 's', overlap: { score: 0.9, sharedTerms: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ term: 't' + n })) } },
      3,
    );
    expect(push.handle.query).toEqual(['t1', 't2', 't3']);
  });

  it('handles an empty shared-term list without producing a bare teaser', () => {
    const push = collisionToPush({ sessionId: 's', overlap: { score: 0.5, sharedTerms: [] } });
    expect(push.handle.query).toEqual([]);
    expect(push.teaser).toContain('(cursor overlap)');
  });
});

/**
 * salience-policy-triage.test.ts — EI-1687: an operator-triaged ("handled") escalation
 * must not re-surface as "open" on curation:feed or the Queen wake brief every wake.
 *
 * Covers the two pure helpers the fix adds (attentionIdForSignal + dropTriagedHandledSignals);
 * the consumers (curation:feed handler + queen-brief-launch gatherEscalations) just read the
 * triaged-handled set (readTriagedHandledItemIds) and apply this filter.
 *
 * TEETH: an empty handled set is a no-op (no over-suppression — a fresh escalation always
 * surfaces); only an escalation whose AttentionItem id was triaged handled is dropped.
 */
import { describe, it, expect } from 'vitest';
import { attentionIdForSignal, dropTriagedHandledSignals, type FleetSignal } from './salience-policy';

function esc(msgId: string, severity: 'blocker' | 'question' | 'advisory' = 'blocker'): FleetSignal {
  return {
    id: `escalation:${msgId}`,
    kind: severity === 'advisory' ? 'decision' : 'blocker',
    title: `esc ${msgId}`,
    severity,
    ref: `escalation:${msgId}`,
    ts: '2026-06-20T00:00:00.000Z',
  };
}
function blocked(ref: string): FleetSignal {
  return { id: `blocked:${ref}`, kind: 'blocker', title: `blk ${ref}`, ref: `wi:${ref}`, ts: '2026-06-20T00:00:00.000Z' };
}

describe('EI-1687 — triaged-handled escalation suppression', () => {
  it('attentionIdForSignal maps escalation:<msgId> → coord-escalation:<msgId>; non-escalation → null', () => {
    expect(attentionIdForSignal({ id: 'escalation:m1' })).toBe('coord-escalation:m1');
    // any severity/kind keeps the escalation:<msgId> id, so a blocker-from-escalation maps too
    expect(attentionIdForSignal(esc('m9', 'blocker'))).toBe('coord-escalation:m9');
    expect(attentionIdForSignal({ id: 'blocked:WI-9' })).toBeNull(); // a work-item blocker, not coord-escalation
    expect(attentionIdForSignal({ id: 'decision:d1' })).toBeNull();
    expect(attentionIdForSignal({ id: 'completion:WI-3' })).toBeNull();
  });

  it('drops a HANDLED escalation, keeps a non-handled one', () => {
    const signals = [esc('m1'), esc('m2')];
    const handled = new Set(['coord-escalation:m1']); // operator downgraded/resolved m1
    expect(dropTriagedHandledSignals(signals, handled).map((s) => s.id)).toEqual(['escalation:m2']);
  });

  it('TEETH: an EMPTY handled set passes everything through (no over-suppression — a fresh escalation always surfaces)', () => {
    const signals = [esc('m1'), esc('m2'), blocked('WI-9')];
    expect(dropTriagedHandledSignals(signals, new Set()).length).toBe(3);
  });

  it('a signal with no resolvable card is never suppressed, even with a colliding handled id', () => {
    const signals = [blocked('WI-9')];
    const out = dropTriagedHandledSignals(signals, new Set(['coord-escalation:WI-9', 'blocked:WI-9']));
    // `blocked:WI-9` carries no workItemId AND no `<x>#<y>` ref, so it resolves
    // to no card at all (curated-signal-cards P-003) → always kept.
    expect(out.map((s) => s.id)).toEqual(['blocked:WI-9']);
  });

  it('does not mutate the input array; returns a new filtered array', () => {
    const signals = [esc('m1'), esc('m2')];
    const out = dropTriagedHandledSignals(signals, new Set(['coord-escalation:m1']));
    expect(signals).toHaveLength(2); // input untouched
    expect(out).toHaveLength(1);
  });
});

describe('curated-signal-cards P-003 — blocker signals resolve onto their cards', () => {
  /** A blocked WORK-item signal: the work-item leg stamps `workItemId`. */
  function blockedWorkItem(harness: string, id: string): FleetSignal {
    return {
      id: `blocked:${harness}#${id}`,
      kind: 'blocker',
      title: `blk ${id}`,
      harness,
      workItemId: id,
      ref: `wi:${harness}#${id}`,
      ts: '2026-07-17T00:00:00.000Z',
    };
  }
  /** A blocked PLAN-item signal: the plan-item leg stamps NO workItemId. */
  function blockedPlanItem(slug: string, itemId: string): FleetSignal {
    return {
      id: `blocked:${slug}#${itemId}`,
      kind: 'blocker',
      title: `blk ${slug}#${itemId}`,
      ref: `wi:${slug}#${itemId}`,
      ts: '2026-07-17T00:00:00.000Z',
    };
  }

  it('a blocked WORK-item maps to its source #15 card id (discriminated by workItemId, not the ref string)', () => {
    expect(attentionIdForSignal(blockedWorkItem('papercusp', 'WI-5231'))).toBe(
      'work-item-blocked:WI-5231',
    );
  });

  it('a blocked PLAN-item maps to the EXISTING plan-item card, translating `#` to the id separator `:`', () => {
    expect(attentionIdForSignal(blockedPlanItem('my-plan-2026-07-17', 'P-004'))).toBe(
      'plan-item:my-plan-2026-07-17:P-004',
    );
  });

  it('TEETH: the two legs share a ref SHAPE — only workItemId tells them apart', () => {
    // Identical `<x>#<y>` refs; the presence of workItemId is the whole signal.
    const asWorkItem = attentionIdForSignal({ id: 'blocked:a#b', workItemId: 'b' });
    const asPlanItem = attentionIdForSignal({ id: 'blocked:a#b' });
    expect(asWorkItem).toBe('work-item-blocked:b');
    expect(asPlanItem).toBe('plan-item:a:b');
  });

  it('deadclaim: deliberately resolves to NO card — a dead claim is not necessarily a blocked status', () => {
    expect(
      attentionIdForSignal({ id: 'deadclaim:papercusp#WI-77', workItemId: 'WI-77' }),
    ).toBeNull();
  });

  it('a malformed blocked ref (no `#`, no workItemId) resolves to nothing rather than a bogus id', () => {
    expect(attentionIdForSignal({ id: 'blocked:WI-9' })).toBeNull();
    expect(attentionIdForSignal({ id: 'blocked:#P-1' })).toBeNull(); // empty slug
    expect(attentionIdForSignal({ id: 'blocked:plan#' })).toBeNull(); // empty item id
  });

  it('triaging a blocked work-item card suppresses its chat re-nag (the close-the-loop this enables)', () => {
    const signals = [blockedWorkItem('papercusp', 'WI-1'), blockedWorkItem('papercusp', 'WI-2')];
    const handled = new Set(['work-item-blocked:WI-1']); // owner resolved that card
    expect(dropTriagedHandledSignals(signals, handled).map((s) => s.id)).toEqual([
      'blocked:papercusp#WI-2',
    ]);
  });
});

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

  it('a non-escalation signal is never suppressed (its attentionId is null), even with a colliding handled id', () => {
    const signals = [blocked('WI-9')];
    const out = dropTriagedHandledSignals(signals, new Set(['coord-escalation:WI-9', 'blocked:WI-9']));
    expect(out.map((s) => s.id)).toEqual(['blocked:WI-9']); // blocked: maps to a null attentionId → kept
  });

  it('does not mutate the input array; returns a new filtered array', () => {
    const signals = [esc('m1'), esc('m2')];
    const out = dropTriagedHandledSignals(signals, new Set(['coord-escalation:m1']));
    expect(signals).toHaveLength(2); // input untouched
    expect(out).toHaveLength(1);
  });
});

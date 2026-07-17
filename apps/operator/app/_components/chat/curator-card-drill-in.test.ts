import { describe, it, expect } from 'vitest';
import { drillInRefToInbox } from './curator-card-drill-in';

describe('drillInRefToInbox (deterministic-status-cards P-003/D-004)', () => {
  it('maps escalation:<id> → the coord-escalation attention id (inbox selection)', () => {
    expect(drillInRefToInbox('escalation:mrpc33tj-0000-abc')).toBe('coord-escalation:mrpc33tj-0000-abc');
  });

  it('trims surrounding whitespace', () => {
    expect(drillInRefToInbox('  escalation:x  ')).toBe('coord-escalation:x');
  });

  it('returns null for an empty escalation id (open the pane, select nothing)', () => {
    expect(drillInRefToInbox('escalation:')).toBeNull();
  });

  it('returns null for refs with no precise inbox item yet (wi/plan/bare)', () => {
    // These still open the inbox at the call site; they just have no selection.
    expect(drillInRefToInbox('wi:papercup#F-1')).toBeNull();
    expect(drillInRefToInbox('plan:my-plan-2026-07-17')).toBeNull();
    expect(drillInRefToInbox('random-ref')).toBeNull();
    expect(drillInRefToInbox('')).toBeNull();
  });
});

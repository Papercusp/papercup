import { describe, it, expect } from 'vitest';
import {
  drillInRefToInbox,
  resolveInboxDrillIn,
  resolvePlanItemDrillIn,
  type DrillInItem,
  type PlanItemDrillItem,
} from './curator-card-drill-in';

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

describe('resolveInboxDrillIn (WI-5342 — resolve against live items)', () => {
  const items: DrillInItem[] = [
    { id: 'coord-escalation:m9', itemRef: null, planSlug: 'plan-a' },
    { id: 'coord-message:c1', itemRef: 'papercusp#F-1', planSlug: 'plan-b' },
    { id: 'owner-wall:loop-carry-note:su-1', itemRef: null, planSlug: null },
  ];

  it('escalation ref selects the constructed coord-escalation id + forces the all filter', () => {
    expect(resolveInboxDrillIn('escalation:m9', items)).toEqual({ selId: 'coord-escalation:m9', filter: 'all' });
  });

  it('escalation ref with no live match still targets the constructed id', () => {
    expect(resolveInboxDrillIn('escalation:missing', [])).toEqual({ selId: 'coord-escalation:missing', filter: 'all' });
  });

  it('a ref that already IS an item id selects it', () => {
    expect(resolveInboxDrillIn('owner-wall:loop-carry-note:su-1', items)).toEqual({
      selId: 'owner-wall:loop-carry-note:su-1',
      filter: 'all',
    });
  });

  it('wi:<ref> matches the item whose itemRef is <ref> (the previous null-return bug)', () => {
    expect(resolveInboxDrillIn('wi:papercusp#F-1', items)).toEqual({ selId: 'coord-message:c1', filter: 'all' });
  });

  it('plan:<slug> selects the first item on that plan', () => {
    expect(resolveInboxDrillIn('plan:plan-a', items)).toEqual({ selId: 'coord-escalation:m9', filter: 'all' });
  });

  it('a ref with no matching inbox item opens the pane without a selection', () => {
    expect(resolveInboxDrillIn('health:some-panel', items)).toEqual({ selId: null, filter: null });
    expect(resolveInboxDrillIn('', items)).toEqual({ selId: null, filter: null });
  });
});

// resolveWorkingTabDrillIn (chat-ref-pills-2026-07-26 P-002's "Working tab"
// destination) was retired by P-009 — D-001 (owner re-spec, 2026-07-26)
// superseded that destination with a popup (WorkItemPopupModal, P-008),
// wired through the D-002 onWorkRefActivate seam instead. resolveInboxDrillIn
// itself (tested above) still runs the RESOLUTION half unchanged.

describe('resolvePlanItemDrillIn (chat-ref-pills-2026-07-26 P-006)', () => {
  const items: PlanItemDrillItem[] = [
    { id: 'P-003', planSlug: 'chat-ref-pills-2026-07-26' },
    { id: 'P-006', planSlug: 'chat-ref-pills-2026-07-26' },
    { id: 'P-003', planSlug: 'gui-chat-session-controls-2026-07-25' },
  ];

  it('a live P-ref scoped to the message plan_slug resolves to "<planSlug>::<itemId>"', () => {
    expect(resolvePlanItemDrillIn('P-003', 'chat-ref-pills-2026-07-26', items)).toEqual({
      sel: 'chat-ref-pills-2026-07-26::P-003',
    });
  });

  it('the SAME P-NNN id resolves to the OTHER plan when scoped there — proves scoping, not global match', () => {
    expect(resolvePlanItemDrillIn('P-003', 'gui-chat-session-controls-2026-07-25', items)).toEqual({
      sel: 'gui-chat-session-controls-2026-07-25::P-003',
    });
  });

  it('no message plan_slug context → null sel, never a guessed plan (render plain text)', () => {
    expect(resolvePlanItemDrillIn('P-003', null, items)).toEqual({ sel: null });
    expect(resolvePlanItemDrillIn('P-003', undefined, items)).toEqual({ sel: null });
    expect(resolvePlanItemDrillIn('P-003', '', items)).toEqual({ sel: null });
  });

  it('a P-ref with no live item on the scoped plan returns null sel (not present on THAT plan)', () => {
    expect(resolvePlanItemDrillIn('P-999', 'chat-ref-pills-2026-07-26', items)).toEqual({ sel: null });
  });

  it('an empty ref returns null sel even with plan context', () => {
    expect(resolvePlanItemDrillIn('', 'chat-ref-pills-2026-07-26', items)).toEqual({ sel: null });
    expect(resolvePlanItemDrillIn('   ', 'chat-ref-pills-2026-07-26', items)).toEqual({ sel: null });
  });
});

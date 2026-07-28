import { describe, it, expect } from 'vitest';
import {
  drillInRefToInbox,
  resolveInboxDrillIn,
  resolveDrillInTarget,
  resolvePlanItemDrillIn,
  resolveRefDestination,
  type DrillInItem,
  type PlanItemDrillItem,
  type RefDestinationItem,
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

describe('resolveRefDestination (hud-open-destinations-and-true-counts-2026-07-27 P-001)', () => {
  // The regression this exists to prevent (owner report 2026-07-27): a report
  // row naming a work item or a plan resolved to no ownerAgentId, so the chat
  // drill-in pushed `/adv?tab=hud` with nothing selected — a visible no-op when
  // fired from a sidebar already on /adv.
  const destItems: RefDestinationItem[] = [
    {
      id: 'coord-escalation:msg-1',
      itemRef: null,
      planSlug: null,
      ownerAgentId: 'su-abc12345',
    },
    {
      id: 'decision:d-9',
      itemRef: 'EI-18750935999066024',
      planSlug: 'git-sync-2026-07-27',
      ownerAgentId: 'su-def67890',
    },
    { id: 'ask-ownerless', itemRef: null, planSlug: 'lonely-plan-2026-07-01', ownerAgentId: null },
    { id: 'ask-bare', itemRef: null, planSlug: null, ownerAgentId: null },
  ];

  it('an explicit wi: ref opens the work item, normalized to uppercase', () => {
    expect(resolveRefDestination('wi:WI-6512', destItems)).toEqual({ kind: 'work-item', id: 'WI-6512' });
    expect(resolveRefDestination('wi:ei-42', destItems)).toEqual({ kind: 'work-item', id: 'EI-42' });
  });

  it('an explicit plan: ref opens the plan', () => {
    expect(resolveRefDestination('plan:my-plan-2026-07-17', destItems)).toEqual({
      kind: 'plan',
      slug: 'my-plan-2026-07-17',
    });
  });

  it('a BARE work-item id opens the work item — the case that used to no-op', () => {
    expect(resolveRefDestination('EI-18750935999066024', destItems)).toEqual({
      kind: 'work-item',
      id: 'EI-18750935999066024',
    });
    expect(resolveRefDestination('F-100', destItems)).toEqual({ kind: 'work-item', id: 'F-100' });
  });

  it('an escalation ref goes to the owning agent conversation — answering them IS the action', () => {
    expect(resolveRefDestination('escalation:msg-1', destItems)).toEqual({
      kind: 'session',
      ownerAgentId: 'su-abc12345',
    });
  });

  it('a matched item prefers its OWN work item over its owning agent (most specific wins)', () => {
    expect(resolveRefDestination('decision:d-9', destItems)).toEqual({
      kind: 'work-item',
      id: 'EI-18750935999066024',
    });
  });

  it('a matched ownerless ask falls back to its plan rather than resolving to nothing', () => {
    expect(resolveRefDestination('ask-ownerless', destItems)).toEqual({
      kind: 'plan',
      slug: 'lonely-plan-2026-07-01',
    });
  });

  it('a ref naming nothing openable returns none, so the caller can SAY so', () => {
    expect(resolveRefDestination('health:some-panel', destItems)).toEqual({ kind: 'none' });
    expect(resolveRefDestination('ask-bare', destItems)).toEqual({ kind: 'none' });
    expect(resolveRefDestination('', destItems)).toEqual({ kind: 'none' });
    expect(resolveRefDestination('   ', destItems)).toEqual({ kind: 'none' });
  });

  it('a ref shaped like a work item but glued into a larger token is NOT a work item', () => {
    expect(resolveRefDestination('XWI-123', destItems)).toEqual({ kind: 'none' });
    expect(resolveRefDestination('WI-123abc', destItems)).toEqual({ kind: 'none' });
  });

  /* ── the HARNESS-QUALIFIED shapes the curator really emits ──────────────────
   *
   * Every ref string below was read off the LIVE app / the real producers on
   * 2026-07-28, not invented: `curation/deps.ts` writes `wi:<harness>#<id>` for
   * its blocked/dead-claim/review rows and a bare `<harness>#<id>` for progress,
   * and `blockedWorkItemToAttention` carries the same `<harness>#<id>` as the
   * item's `itemRef`. `curation:feed` returned `wi:papercusp#WI-6594` for all 6
   * live blocker rows; not one bare `WI-NNNN` appeared.
   *
   * This matters because the tests above — all bare ids — passed against the old
   * anchored matcher while the live destination was broken: the popup opened on
   * `papercusp#WI-6594` and rendered "No item found for papercusp#WI-6594."
   */
  it('a harness-qualified wi: ref (what the curator ACTUALLY emits) resolves id AND harness', () => {
    expect(resolveRefDestination('wi:papercusp#WI-6594', destItems)).toEqual({
      kind: 'work-item',
      id: 'WI-6594',
      harness: 'papercusp',
    });
  });

  it('a bare harness-qualified ref (deps.ts progress rows) resolves the same way', () => {
    expect(resolveRefDestination('papercusp#WI-6594', destItems)).toEqual({
      kind: 'work-item',
      id: 'WI-6594',
      harness: 'papercusp',
    });
  });

  it("a matched item's harness-qualified itemRef resolves to its work item, not its owner", () => {
    const blocked: RefDestinationItem[] = [
      {
        // blockedWorkItemToAttention: id + curatorRef, verbatim shapes
        id: 'work-item-blocked:WI-6594',
        itemRef: 'papercusp#WI-6594',
        planSlug: null,
        ownerAgentId: 'su-abc12345',
      },
    ];
    expect(resolveRefDestination('papercusp#WI-6594', blocked)).toEqual({
      kind: 'work-item',
      id: 'WI-6594',
      harness: 'papercusp',
    });
  });

  it('an ask-kind `:` segment is never read as a harness — it would scope the lookup to nothing', () => {
    expect(resolveRefDestination('wi:owner-wall:WI-4271', destItems)).toEqual({
      kind: 'work-item',
      id: 'WI-4271',
    });
  });
});

describe('resolveDrillInTarget — the ONE verdict the Open button and its click share', () => {
  const items: RefDestinationItem[] = [
    { id: 'coord-escalation:msg-1', itemRef: null, planSlug: null, ownerAgentId: 'su-abc12345' },
  ];

  it('a harness-qualified ref is openable with NO surrounding harness — the ref carries it', () => {
    // Measured live 2026-07-28: with no `?slug` in the URL this case rendered a
    // button whose click pushed a bare `/adv?tab=hud`, discarding the user's
    // scope/hudtab/hudwi view state instead of opening anything.
    expect(resolveDrillInTarget('wi:papercusp#WI-6594', items, null)).toEqual({
      kind: 'work-item',
      harness: 'papercusp',
      id: 'WI-6594',
    });
  });

  it('an UNqualified work-item ref falls back to the surface harness, and is NOT openable without one', () => {
    expect(resolveDrillInTarget('WI-6594', items, 'papercusp')).toEqual({
      kind: 'work-item',
      harness: 'papercusp',
      id: 'WI-6594',
    });
    // No harness anywhere → no destination → no button (owner ruling 2026-07-28:
    // "if there is nothing to open there should be no open button"). The old code
    // returned openable here and then no-oped.
    expect(resolveDrillInTarget('WI-6594', items, null)).toBeNull();
  });

  it('the ref-named harness WINS over the surface harness (a cross-harness card opens its own item)', () => {
    expect(resolveDrillInTarget('wi:papercup-hive#WI-7', items, 'papercusp')).toEqual({
      kind: 'work-item',
      harness: 'papercup-hive',
      id: 'WI-7',
    });
  });

  it('plan and session targets pass through; nothing-openable is null', () => {
    expect(resolveDrillInTarget('plan:my-plan-2026-07-17', items, null)).toEqual({
      kind: 'plan',
      slug: 'my-plan-2026-07-17',
    });
    expect(resolveDrillInTarget('escalation:msg-1', items, null)).toEqual({
      kind: 'session',
      ownerAgentId: 'su-abc12345',
    });
    expect(resolveDrillInTarget('health:some-panel', items, 'papercusp')).toBeNull();
  });
});

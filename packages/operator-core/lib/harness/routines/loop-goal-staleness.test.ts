/**
 * loop-goal-staleness.test.ts — EI-19501119110607678.
 *
 * The measured incident: a goal armed 15:07Z named four items; by 06:00Z the next
 * morning all four were `done`, and the wake had re-delivered that text 171 times as
 * the agent's standing lane.
 *
 * The tests split into two halves, and the SECOND half is the one that matters:
 *   1. it flags a genuinely stale goal (the reported bug);
 *   2. it does NOT flag anything it did not actually measure — because a false STALE
 *      verdict on a live goal is worse than the silence it replaced. An unreadable
 *      store, an id that resolves nowhere, an empty map: each must produce NO claim,
 *      not "everything is finished".
 *
 * Run: cd packages/operator-core && npx vitest run lib/harness/routines/loop-goal-staleness.test.ts
 */
import { describe, expect, it } from 'vitest';
import { assessGoalStaleness, extractGoalWorkItemIds } from './loop-goal-staleness';
import { detectDrivenWorkItemId } from './loop';

const states = (m: Record<string, string>) => new Map(Object.entries(m));

describe('extractGoalWorkItemIds', () => {
  it('pulls every distinct id, in goal order', () => {
    expect(
      extractGoalWorkItemIds('Current lane: EI-19444246913245434 — BLOCKED. Meanwhile: WI-12, F-3'),
    ).toEqual(['EI-19444246913245434', 'WI-12', 'F-3']);
  });

  it('case-folds so one item cannot count as two', () => {
    // Otherwise a goal reads as naming more work than it does, and a partial verdict
    // ("2 of 4 terminal") would be arithmetic on a phantom.
    expect(extractGoalWorkItemIds('ei-1 and EI-1 and Ei-1')).toEqual(['EI-1']);
  });

  it('returns nothing for a prose goal — the common mission-shaped case', () => {
    expect(extractGoalWorkItemIds('Drive plan retire-mug-kettle to completion')).toEqual([]);
    expect(extractGoalWorkItemIds(null)).toEqual([]);
  });

  it('IS the extractor detectDrivenWorkItemId uses — one notion of an id, not two', () => {
    // The shared-extraction claim, pinned rather than asserted in a comment: if these
    // ever diverge, "which item does this loop drive" and "are its items done" stop
    // being answered about the same set.
    expect(detectDrivenWorkItemId('working WI-99 now')).toBe('WI-99');
    expect(detectDrivenWorkItemId('WI-99 and EI-1')).toBeNull(); // ambiguous ⇒ no guess
    expect(detectDrivenWorkItemId('wi-99')).toBe('WI-99');
  });
});

describe('assessGoalStaleness — flags the goal that is actually stale', () => {
  it('THE REPORTED BUG: every named item terminal ⇒ loud STALE verdict', () => {
    const goal =
      'Current lane: EI-19444246913245434 — BLOCKED on a lock. Meanwhile advance my other minors: ' +
      'EI-19425177453558152, EI-19415157731625374, EI-19409888189789017';
    const v = assessGoalStaleness(
      goal,
      states({
        'EI-19444246913245434': 'done',
        'EI-19425177453558152': 'done',
        'EI-19415157731625374': 'resolved',
        'EI-19409888189789017': 'done',
      }),
    );
    expect(v.allTerminal).toBe(true);
    expect(v.terminal).toHaveLength(4);
    expect(v.live).toEqual([]);
    expect(v.note).toContain('THIS GOAL IS STALE');
    // It must NAME them — a verdict the reader cannot check is another thing to trust.
    expect(v.note).toContain('EI-19444246913245434 (done)');
    // And say what to do instead, or the reader is left holding a contradiction.
    expect(v.note).toMatch(/re-arm/i);
  });

  it('uses the CANONICAL terminal set, not a hand-list — `passed` and `resolved` count', () => {
    // A local copy of this list once missed exactly these two, which are the NORMAL
    // close for the feature and issue families respectively.
    expect(assessGoalStaleness('F-1', states({ 'F-1': 'passed' })).allTerminal).toBe(true);
    expect(assessGoalStaleness('EI-1', states({ 'EI-1': 'resolved' })).allTerminal).toBe(true);
    expect(assessGoalStaleness('EI-2', states({ 'EI-2': 'deprecated' })).allTerminal).toBe(true);
  });

  it('partial: reports the finished ones AND names what is still open', () => {
    const v = assessGoalStaleness('WI-1 and WI-2', states({ 'WI-1': 'done', 'WI-2': 'wip' }));
    expect(v.allTerminal).toBe(false);
    expect(v.live).toEqual(['WI-2']);
    expect(v.note).toContain('WI-1 (done)');
    expect(v.note).toContain('Still open: WI-2');
  });

  it('is case-insensitive about the STATE too', () => {
    expect(assessGoalStaleness('WI-1', states({ 'WI-1': 'DONE' })).allTerminal).toBe(true);
  });
});

describe('assessGoalStaleness — refuses to claim what it did not measure', () => {
  it('SILENT on a healthy goal — the annotation must not become scenery', () => {
    const v = assessGoalStaleness('WI-1 and WI-2', states({ 'WI-1': 'wip', 'WI-2': 'open' }));
    expect(v.note).toBeNull();
    expect(v.allTerminal).toBe(false);
  });

  it('AN EMPTY MAP IS NOT "EVERYTHING IS DONE" — the read-failure case', () => {
    // This is the failure that would make the feature worse than nothing: a store
    // error yields an empty map, and a naive implementation reads zero live items as
    // "all terminal" and tells a working agent to abandon a live goal.
    const v = assessGoalStaleness('WI-1 and WI-2', new Map());
    expect(v.allTerminal).toBe(false);
    expect(v.terminal).toEqual([]);
    expect(v.unresolved).toEqual(['WI-1', 'WI-2']);
    expect(v.note).toBeNull();
  });

  it('an UNRESOLVED id never counts as terminal, even beside real terminal ones', () => {
    const v = assessGoalStaleness('WI-1 and WI-2', states({ 'WI-1': 'done' }));
    expect(v.allTerminal).toBe(false); // WI-2 is unknown, so "all" is unprovable
    expect(v.unresolved).toEqual(['WI-2']);
    expect(v.note).toContain('Could not resolve WI-2');
    expect(v.note).toContain('not as finished');
  });

  it('an empty state string is unresolved, not a state', () => {
    expect(assessGoalStaleness('WI-1', states({ 'WI-1': '' })).unresolved).toEqual(['WI-1']);
  });

  it('a prose goal is never judged — no ids, no verdict, no query', () => {
    const v = assessGoalStaleness('Drive plan retire-mug-kettle to completion', new Map());
    expect(v.ids).toEqual([]);
    expect(v.allTerminal).toBe(false);
    expect(v.note).toBeNull();
  });
});

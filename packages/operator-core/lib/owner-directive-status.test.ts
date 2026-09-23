/**
 * owner-directive-status.test.ts — P-006 + P-009(d) of plan
 * `directive-visibility-and-ownership-2026-09-22`.
 *
 * The centrepiece is `derives done for the MEASURED #86/#87 shape`: a row the
 * owner's session had already closed with `dispositionStatus:'done'` that kept
 * being re-delivered as a rank-0 `[DUE]` imperative. Since plan
 * `owner-directive-delivery-redesign-2026-09-22` (D-001) there is no capture
 * triage left: every owner turn lands open, and the disposition is the ONLY
 * terminal route — so the derivation reads nothing but the disposition and
 * the linked work-items.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveDirectiveStatus,
  directiveNeedsAction,
  directiveStatusLabel,
  type DirectiveLinkedWorkItem,
  type DirectiveStatusDirectiveInput,
} from './owner-directive-status';
import { TERMINAL_WORK_ITEM_STATES } from './work-items';

const FRESH: DirectiveStatusDirectiveInput = {
  dispositionStatus: null,
  dispositionedAtMs: null,
};

const wi = (id: string, state: string, assignee?: string): DirectiveLinkedWorkItem => ({
  id,
  state,
  ...(assignee ? { assignee } : {}),
});

describe('deriveDirectiveStatus — the four states', () => {
  it('a fresh directive with no work-items and no disposition is unclaimed', () => {
    const s = deriveDirectiveStatus(FRESH, []);
    expect(s.kind).toBe('unclaimed');
    expect(s.holders).toEqual([]);
    expect(s.activeWorkItemIds).toEqual([]);
    // D-005: this is the DEFAULT, so it must not be flagged as a worked-then-
    // abandoned row — those are a different prompt.
    expect(s.workedButUndispositioned).toBe(false);
    expect(directiveNeedsAction(s)).toBe(true);
  });

  it('a non-terminal linked work-item makes it claimed, and names the holder', () => {
    const s = deriveDirectiveStatus(FRESH, [wi('WI-1', 'wip', 'su-aaa')]);
    expect(s.kind).toBe('claimed');
    expect(s.claimedBy).toBe('su-aaa');
    expect(s.activeWorkItemIds).toEqual(['WI-1']);
    expect(directiveStatusLabel(s)).toBe('claimed-by:su-aaa');
    expect(directiveNeedsAction(s)).toBe(true);
  });

  it('a recorded done disposition is terminal and needs no action', () => {
    const s = deriveDirectiveStatus(
      { dispositionStatus: 'done', dispositionedAtMs: 1_700_000_000_000 },
      [],
    );
    expect(s.kind).toBe('done');
    expect(directiveNeedsAction(s)).toBe(false);
  });

  it('a recorded declined disposition is terminal and distinct from done', () => {
    const s = deriveDirectiveStatus(
      { dispositionStatus: 'declined', dispositionedAtMs: 1_700_000_000_000 },
      [],
    );
    expect(s.kind).toBe('declined');
    expect(directiveNeedsAction(s)).toBe(false);
  });

});

describe('P-009(d) — the MEASURED #86/#87 regression', () => {
  /**
   * Measured 2026-09-22 via `orders:list { state:['pending','open'] }`:
   * directives #86 and #87 carried dispositionStatus 'done' (dispositionedBy
   * their own recording session, 14:58:29Z / 15:01:00Z) and were still
   * delivered as `[DUE] … promote or dismiss` for at least four consecutive
   * wakes, because the reader consulted the capture field instead.
   */
  const MEASURED_86: DirectiveStatusDirectiveInput = {
    dispositionStatus: 'done',
    dispositionedAtMs: Date.parse('2026-09-22T14:58:29.000Z'),
  };

  it('derives done, NOT a live imperative', () => {
    const s = deriveDirectiveStatus(MEASURED_86, []);
    expect(s.kind).toBe('done');
    expect(directiveNeedsAction(s)).toBe(false);
  });

  it('CALIBRATION: the same derivation still calls a genuinely fresh row live', () => {
    // Proves the verdict above is a real discriminator rather than a function
    // that always says 'done'.
    expect(deriveDirectiveStatus(FRESH, []).kind).toBe('unclaimed');
    expect(directiveNeedsAction(deriveDirectiveStatus(FRESH, []))).toBe(true);
  });
});

describe('work-item refs answer WHO is on it, never WHETHER it is finished', () => {
  it.each(TERMINAL_WORK_ITEM_STATES.map((s) => [s]))(
    'a linked work-item in terminal state %s does not close the directive',
    (state) => {
      const s = deriveDirectiveStatus(FRESH, [wi('WI-1', state as string, 'su-aaa')]);
      expect(s.kind).toBe('unclaimed');
      expect(s.activeWorkItemIds).toEqual([]);
      // …but it is distinguishable from a directive nobody ever touched, so a
      // renderer can nudge for a disposition instead of re-issuing carry-out.
      expect(s.workedButUndispositioned).toBe(true);
    },
  );

  it('a mix of terminal and live items is claimed by the live one only', () => {
    const s = deriveDirectiveStatus(FRESH, [
      wi('WI-done', 'done', 'su-aaa'),
      wi('WI-live', 'wip', 'su-bbb'),
    ]);
    expect(s.kind).toBe('claimed');
    expect(s.claimedBy).toBe('su-bbb');
    expect(s.holders).toEqual(['su-bbb']);
    expect(s.activeWorkItemIds).toEqual(['WI-live']);
  });

  it('several live holders are all reported, not silently reduced to one', () => {
    const s = deriveDirectiveStatus(FRESH, [
      wi('WI-1', 'wip', 'su-aaa'),
      wi('WI-2', 'open', 'su-bbb'),
      wi('WI-3', 'wip', 'su-aaa'),
    ]);
    expect(s.kind).toBe('claimed');
    expect(s.claimedBy).toBe('su-aaa');
    // De-duplicated, order preserved: two agents on one directive is a real
    // coordination signal and must not be flattened away by the renderer.
    expect(s.holders).toEqual(['su-aaa', 'su-bbb']);
    expect(s.activeWorkItemIds).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });

  it('an unassigned live work-item is claimed with no claimedBy, not unclaimed', () => {
    const s = deriveDirectiveStatus(FRESH, [wi('WI-1', 'wip')]);
    expect(s.kind).toBe('claimed');
    expect(s.claimedBy).toBeUndefined();
    expect(directiveStatusLabel(s)).toBe('claimed');
  });
});

describe('precedence and defensive readings', () => {
  it('a disposition outranks a still-live work-item', () => {
    const s = deriveDirectiveStatus(
      { dispositionStatus: 'done', dispositionedAtMs: 1 },
      [wi('WI-1', 'wip', 'su-aaa')],
    );
    expect(s.kind).toBe('done');
    // The live item is still REPORTED — the holder may need telling that the
    // directive behind their work-item was closed.
    expect(s.activeWorkItemIds).toEqual(['WI-1']);
  });

  it('a status with NO recorded timestamp is not read as terminal', () => {
    // A half-written row must fail toward "still needs action", never toward a
    // silent close: the expensive direction of this error is dropping an
    // owner's order, not re-showing one.
    const s = deriveDirectiveStatus(
      { dispositionStatus: 'done', dispositionedAtMs: null },
      [],
    );
    expect(s.kind).toBe('unclaimed');
    expect(directiveNeedsAction(s)).toBe(true);
  });

  it('is pure: the same inputs give an equal verdict and the inputs are untouched', () => {
    const items = [wi('WI-1', 'wip', 'su-aaa')];
    const snapshot = JSON.stringify({ FRESH, items });
    expect(deriveDirectiveStatus(FRESH, items)).toEqual(deriveDirectiveStatus(FRESH, items));
    expect(JSON.stringify({ FRESH, items })).toBe(snapshot);
  });
});

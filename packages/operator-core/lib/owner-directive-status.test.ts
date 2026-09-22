/**
 * owner-directive-status.test.ts — P-006 + P-009(d) of plan
 * `directive-visibility-and-ownership-2026-09-22`.
 *
 * The centrepiece is `derives done for the MEASURED #86/#87 shape`: a row with
 * `dispositionStatus:'done'` AND `captureStatus:'pending'`. That shape exists
 * in the live queue right now and is re-delivered as a rank-0 `[DUE]`
 * imperative on every wake. It is the cheapest falsifiable guard in the plan
 * because its subject is real rather than hypothetical — the assertion fails
 * against the pre-fix reading (capture-only) and passes against the derivation.
 *
 * The controls are deliberately kept in the file rather than produced by
 * mutating the module: a permanently-present wrong implementation is the
 * sanctioned way to show these assertions can fail (repo testing policy), and
 * it costs nothing to keep.
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
  captureStatus: 'open',
  dispositionStatus: null,
  dispositionedAtMs: null,
};

const wi = (id: string, state: string, assignee?: string): DirectiveLinkedWorkItem => ({
  id,
  state,
  ...(assignee ? { assignee } : {}),
});

/**
 * THE PRE-FIX READING, kept as a permanent control. This is what the obligation
 * reader effectively does today: consult the CAPTURE field alone. Every test
 * that asserts the derivation is better than this must show this one
 * disagreeing, or the assertion proves nothing.
 */
function captureOnlyReading(d: DirectiveStatusDirectiveInput): 'live' | 'finished' {
  return d.captureStatus === 'pending' || d.captureStatus === 'open' ? 'live' : 'finished';
}

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
      { captureStatus: 'open', dispositionStatus: 'done', dispositionedAtMs: 1_700_000_000_000 },
      [],
    );
    expect(s.kind).toBe('done');
    expect(s.terminalSource).toBe('disposition');
    expect(directiveNeedsAction(s)).toBe(false);
  });

  it('a recorded declined disposition is terminal and distinct from done', () => {
    const s = deriveDirectiveStatus(
      { captureStatus: 'open', dispositionStatus: 'declined', dispositionedAtMs: 1_700_000_000_000 },
      [],
    );
    expect(s.kind).toBe('declined');
    expect(directiveNeedsAction(s)).toBe(false);
  });

  it('a dismissed capture is declined, and says so via terminalSource', () => {
    const s = deriveDirectiveStatus(
      { captureStatus: 'dismissed', dispositionStatus: null, dispositionedAtMs: null },
      [],
    );
    expect(s.kind).toBe('declined');
    // The two terminal routes must stay distinguishable: "the owner's ask was
    // declined" and "the capture was triaged as not-a-directive" are different
    // facts, and collapsing them loses the second one.
    expect(s.terminalSource).toBe('capture-dismissed');
  });
});

describe('P-009(d) — the MEASURED #86/#87 regression', () => {
  /**
   * Measured 2026-09-22 via `orders:list { state:['pending','open'] }`:
   * directives #86 and #87 simultaneously carried dispositionStatus 'done'
   * (dispositionedBy their own recording session, 14:58:29Z / 15:01:00Z) and
   * captureStatus 'pending' with needsResolution true — and were delivered as
   * `[DUE] … promote or dismiss` for at least four consecutive wakes.
   */
  const MEASURED_86: DirectiveStatusDirectiveInput = {
    captureStatus: 'pending',
    dispositionStatus: 'done',
    dispositionedAtMs: Date.parse('2026-09-22T14:58:29.000Z'),
  };

  it('derives done, NOT a live imperative', () => {
    const s = deriveDirectiveStatus(MEASURED_86, []);
    expect(s.kind).toBe('done');
    expect(directiveNeedsAction(s)).toBe(false);
  });

  it('reports the capture lag instead of silently swallowing it', () => {
    // The verdict alone would hide the fact that the capture row never caught
    // up. Surfacing it is what lets a sweep find and repair the population.
    expect(deriveDirectiveStatus(MEASURED_86, []).captureLagging).toBe(true);
  });

  it('CONTROL: the capture-only reading this replaces gets it wrong', () => {
    // Without this the test above is unfalsifiable — it would pass for a
    // derivation that merely echoed a correct input.
    expect(captureOnlyReading(MEASURED_86)).toBe('live');
    expect(deriveDirectiveStatus(MEASURED_86, []).kind).toBe('done');
  });

  it('CALIBRATION: the capture-only reading is right about a genuinely live row', () => {
    // Proves the control is a real discriminator rather than a function that
    // always says 'live' — otherwise the CONTROL above would pass vacuously.
    expect(captureOnlyReading(FRESH)).toBe('live');
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
      { captureStatus: 'open', dispositionStatus: 'done', dispositionedAtMs: 1 },
      [wi('WI-1', 'wip', 'su-aaa')],
    );
    expect(s.kind).toBe('done');
    // The live item is still REPORTED — the holder may need telling that the
    // directive behind their work-item was closed.
    expect(s.activeWorkItemIds).toEqual(['WI-1']);
  });

  it('a disposition outranks a dismissed capture', () => {
    const s = deriveDirectiveStatus(
      { captureStatus: 'dismissed', dispositionStatus: 'done', dispositionedAtMs: 1 },
      [],
    );
    expect(s.kind).toBe('done');
    expect(s.terminalSource).toBe('disposition');
  });

  it('a status with NO recorded timestamp is not read as terminal', () => {
    // A half-written row must fail toward "still needs action", never toward a
    // silent close: the expensive direction of this error is dropping an
    // owner's order, not re-showing one.
    const s = deriveDirectiveStatus(
      { captureStatus: 'open', dispositionStatus: 'done', dispositionedAtMs: null },
      [],
    );
    expect(s.kind).toBe('unclaimed');
    expect(directiveNeedsAction(s)).toBe(true);
  });

  it('an absent captureStatus (pre-capture row) is treated as live', () => {
    const s = deriveDirectiveStatus({ dispositionStatus: null }, []);
    expect(s.kind).toBe('unclaimed');
    expect(s.captureLagging).toBe(false);
  });

  it('is pure: the same inputs give an equal verdict and the inputs are untouched', () => {
    const items = [wi('WI-1', 'wip', 'su-aaa')];
    const snapshot = JSON.stringify({ FRESH, items });
    expect(deriveDirectiveStatus(FRESH, items)).toEqual(deriveDirectiveStatus(FRESH, items));
    expect(JSON.stringify({ FRESH, items })).toBe(snapshot);
  });
});

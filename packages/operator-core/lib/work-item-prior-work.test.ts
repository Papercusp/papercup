/**
 * work-item-prior-work — P-001 of fleet-leadership-continuity-and-actuation-2026-08-01.
 *
 * The guarantee under test: an item that has ALREADY BEEN WORKED must never be
 * indistinguishable from a never-started one — especially when no checkpoint exists, which is
 * precisely the case the two pre-existing guards (EI-529's checkpoint hint, WI-5826's terminal
 * warning) both miss.
 *
 * `priorWorkWarning` is pure, so the wording guarantee is pinned directly here rather than only
 * through the tool. That is deliberate: the escalation on `hasCheckpoint: false` is the entire
 * value of this feature, and a future edit that softened it would otherwise pass silently.
 */
import { describe, expect, it } from 'vitest';
import { parseWorkedByHistory, priorWorkWarning, type ClaimTimePriorWorkHint } from './work-item-prior-work';

const hint = (over: Partial<ClaimTimePriorWorkHint> = {}): ClaimTimePriorWorkHint => ({
  lastReleasedBy: null,
  releasedAtMs: null,
  attempts: 0,
  priorWorkers: [],
  hasCheckpoint: false,
  ...over,
});

describe('priorWorkWarning', () => {
  it('returns null for no hint — a genuinely fresh claim is completely unaffected', () => {
    expect(priorWorkWarning(null)).toBeNull();
  });

  it('ESCALATES when prior work exists but NO checkpoint was written (the WI-6096 shape)', () => {
    const w = priorWorkWarning(hint({ lastReleasedBy: 'su-bdd5566b', releasedAtMs: Date.parse('2026-07-26T18:28:00Z') }));
    // The three things this message must do, each pinned separately so a reword cannot quietly
    // drop one: name the hazard, name the absent checkpoint, and name the concrete next action.
    expect(w).toMatch(/PRIOR WORK/);
    expect(w).toMatch(/NO checkpoint/);
    expect(w).toMatch(/READ THE SOURCE/);
    expect(w).toContain('su-bdd5566b');
    expect(w).toContain('2026-07-26T18:28:00.000Z');
  });

  it('softens when a checkpoint DOES exist — EI-529 already tells the claimant what happened', () => {
    const w = priorWorkWarning(hint({ lastReleasedBy: 'su-peer', hasCheckpoint: true }));
    expect(w).toMatch(/PRIOR WORK/);
    expect(w).toMatch(/checkpoint exists/);
    // NEGATIVE CONTROL for the escalation: the loud variant's distinguishing phrases must be
    // ABSENT here. Without this, a bug collapsing both branches to the same text would still
    // pass the escalation test above.
    expect(w).not.toMatch(/NO checkpoint/);
    expect(w).not.toMatch(/READ THE SOURCE/);
  });

  // WI-6737: the third state. Every caller reads the checkpoint hint under a `.catch(() => null)`,
  // so before this branch existed a checkpoint-store OUTAGE was indistinguishable from a checkpoint
  // that was never written — and this function went on to assert the latter in those exact words.
  // A transport failure rendered as a claim about history is the defect; these pin that it can't
  // happen again in either direction.
  describe("hasCheckpoint: 'unknown' (the checkpoint store could not be READ)", () => {
    it('says the answer is UNKNOWN and never that no checkpoint was written', () => {
      const w = priorWorkWarning(hint({ lastReleasedBy: 'su-peer', hasCheckpoint: 'unknown' }));
      expect(w).toMatch(/PRIOR WORK/);
      expect(w).toMatch(/UNKNOWN/);
      expect(w).toMatch(/could NOT BE READ/i);
      // The whole point: the false-branch's categorical claim about history must NOT appear.
      // This is the assertion that would have caught the original bug.
      expect(w).not.toMatch(/NO checkpoint was ever written/);
      expect(w).not.toMatch(/never-started/);
      expect(w).toContain('su-peer');
    });

    it('tells the reader NOT to start rebuilding, and to re-read once reachable', () => {
      const w = priorWorkWarning(hint({ attempts: 2, hasCheckpoint: 'unknown' }));
      expect(w).toMatch(/Do NOT start rebuilding/i);
      expect(w).toMatch(/work_items:get/);
      // the ordinary fact rendering still applies to this branch
      expect(w).toMatch(/2 prior claim attempts/);
    });

    it('is DISTINCT from both boolean branches — no two of the three collapse', () => {
      const base = { lastReleasedBy: 'su-peer' as const };
      const unknown = priorWorkWarning(hint({ ...base, hasCheckpoint: 'unknown' }));
      const absent = priorWorkWarning(hint({ ...base, hasCheckpoint: false }));
      const present = priorWorkWarning(hint({ ...base, hasCheckpoint: true }));
      expect(new Set([unknown, absent, present]).size).toBe(3);
    });

    it("treats ONLY the literal 'unknown' as unknown — a truthy value is still a present checkpoint", () => {
      // Guards the `=== true` / `=== 'unknown'` comparisons against a future refactor that
      // reintroduces a loose truthiness check and silently re-merges the branches.
      expect(priorWorkWarning(hint({ hasCheckpoint: true }))).toMatch(/checkpoint exists/);
      expect(priorWorkWarning(hint({ hasCheckpoint: false }))).toMatch(/NO checkpoint was ever written/);
    });
  });

  it('reports attempt count and pluralises it', () => {
    expect(priorWorkWarning(hint({ attempts: 1 }))).toMatch(/1 prior claim attempt\b/);
    expect(priorWorkWarning(hint({ attempts: 3 }))).toMatch(/3 prior claim attempts/);
  });

  it('lists prior workers WITHOUT repeating the last releaser', () => {
    const w = priorWorkWarning(hint({ lastReleasedBy: 'su-a', priorWorkers: ['su-a', 'su-b'] }));
    expect(w).toContain('su-b');
    // 'su-a' appears once (as the releaser), not again in the previously-worked-by list.
    expect(w!.match(/su-a/g)).toHaveLength(1);
  });

  it('still warns when the only signal is an attempt count (no releaser, no timestamp)', () => {
    // The weakest possible signal must still produce a warning — this is the row shape left by a
    // holder that died without ever releasing cleanly.
    expect(priorWorkWarning(hint({ attempts: 2 }))).toMatch(/PRIOR WORK/);
  });
});

describe('parseWorkedByHistory', () => {
  it('accepts a plain string array', () => {
    expect(parseWorkedByHistory(['su-a', 'su-b'])).toEqual(['su-a', 'su-b']);
  });

  it('accepts object entries under any of the drifted key names', () => {
    expect(parseWorkedByHistory([{ owner: 'su-a' }, { ownerId: 'su-b' }, { agent: 'su-c' }, { by: 'su-d' }])).toEqual([
      'su-a',
      'su-b',
      'su-c',
      'su-d',
    ]);
  });

  it('de-duplicates and drops blanks', () => {
    expect(parseWorkedByHistory(['su-a', 'su-a', '  ', { owner: '' }])).toEqual(['su-a']);
  });

  it('returns [] for shapes it does not recognise instead of throwing', () => {
    // The column's shape has drifted historically; an unrecognised one must degrade to "no
    // workers", never fail the surrounding claim.
    for (const bad of [null, undefined, 'not-an-array', 42, {}, [1, true, null]]) {
      expect(() => parseWorkedByHistory(bad)).not.toThrow();
      expect(parseWorkedByHistory(bad)).toEqual([]);
    }
  });
});

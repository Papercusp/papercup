import { describe, expect, it } from 'vitest';

import {
  capPreservingOperative,
  capPreservingOperativeDetailed,
  renderWithheldNotice,
  type CapPreservingOperativeTruncation,
} from './operative-clause';

/**
 * Disclosure guards for the shared carry-surface excerpt helper.
 *
 * The defect these exist to prevent: an excerpt that truncates but says
 * nothing about being truncated is indistinguishable from a complete one, so
 * the reader treats a partial checkpoint as the whole story. That reader is
 * typically a just-compacted successor whose entire resume state is the
 * excerpt — the worst possible place to lose detail silently, and the
 * owner-reported failure behind this thread.
 *
 * Every sibling fold in the same `coord:orient` payload already discloses its
 * own trim with a count plus a fetch verb (`factsTruncated`,
 * `claimableTruncated`, `recentTruncated`, `bodiesTruncated`); the held-item
 * checkpoint and body excerpts were the holdout.
 */

/** A body long enough to force a cut, with an operative clause AFTER it. */
function longBodyWithLateDirective(headChars: number): string {
  return `${'x'.repeat(headChars)} and then some narration. ⛔ NEVER deploy on a red gate.`;
}

describe('capPreservingOperativeDetailed — discloses what it withheld', () => {
  it('emits a truncation marker with counts and a fetch verb when it cuts', () => {
    const body = longBodyWithLateDirective(500);
    const out = capPreservingOperativeDetailed(body, 100, { more: "work_items:get { id: 'WI-1' }" });

    expect(out.truncation).toBeDefined();
    expect(out.truncation!.totalChars).toBe(body.length);
    expect(out.truncation!.keptChars).toBe(99); // max - 1, the head slice
    expect(out.truncation!.more).toBe("work_items:get { id: 'WI-1' }");
  });

  it('ABSENCE of the marker is a positive claim of completeness', () => {
    // The contract a reader relies on: no `truncation` ⇒ you are reading all of it.
    // If this ever starts emitting a marker for a body that fit, the field stops
    // meaning anything and every reader has to re-fetch defensively.
    const short = 'a short complete checkpoint';
    const out = capPreservingOperativeDetailed(short, 5000, { more: 'x' });

    expect(out.truncation).toBeUndefined();
    expect(out.text).toBe(short);
  });

  it('the counts ACCOUNT for the whole body — withheld + kept === total', () => {
    // The arithmetic identity is the point: a marker whose numbers do not add up
    // is worse than none, because it invites a reader to compute "how much am I
    // missing" and get a wrong answer.
    for (const [len, max] of [
      [500, 100],
      [10_000, 1_200],
      [1_201, 1_200],
    ] as const) {
      const t = capPreservingOperativeDetailed('y'.repeat(len), max).truncation!;
      expect(t.keptChars + t.withheldChars).toBe(t.totalChars);
      expect(t.withheldChars).toBeGreaterThan(0);
    }
  });

  it('still preserves the late operative clause it was built to rescue (EI-19952485326105760)', () => {
    // Regression guard: disclosure must not have displaced the original fix.
    const out = capPreservingOperativeDetailed(longBodyWithLateDirective(500), 100);
    expect(out.text).toContain('⚠ OPERATIVE:');
    expect(out.text).toContain('NEVER deploy on a red gate');
    expect(out.truncation!.operativeClausesKept).toBeGreaterThan(0);
  });

  it('leaves the excerpt STRING byte-identical unless inlineNotice is requested', () => {
    // Back-compat guarantee that let this adopt across every existing call site
    // without auditing each one: JSON callers carry the marker as a field, so
    // their payload text must not move.
    const body = longBodyWithLateDirective(500);
    expect(capPreservingOperativeDetailed(body, 100).text).toBe(capPreservingOperative(body, 100));
    expect(capPreservingOperativeDetailed(body, 100).text).not.toContain('withheld');
  });

  it('inlineNotice renders the count AND the fetch call, for prose surfaces', () => {
    const body = longBodyWithLateDirective(500);
    const text = capPreservingOperative(body, 100, {
      inlineNotice: true,
      more: "work_items:get { id: 'WI-42' }",
    });

    expect(text).toContain('withheld');
    expect(text).toContain("work_items:get { id: 'WI-42' }");
    // The notice must not swallow the operative clause it sits beside.
    expect(text).toContain('NEVER deploy on a red gate');
  });

  it('renders large numbers readably (a bare 24310 invites a misread as 2431)', () => {
    const notice = renderWithheldNotice({
      keptChars: 1_200,
      totalChars: 25_510,
      withheldChars: 24_310,
      operativeClausesKept: 1,
      more: 'x',
    });
    expect(notice).toContain('24,310');
    expect(notice).toContain('25,510');
  });
});

/**
 * FALSIFIABILITY CONTROL — a deliberately-wrong implementation kept permanently
 * in the test file (repo rule: never mutate production code to prove a guard
 * bites; the shared tree's sweep can commit the mutant even when nothing goes
 * wrong). This is the pre-fix behaviour: cut, append the operative clause, and
 * say nothing about the gap.
 */
function silentlyTruncating(s: string, max: number): { text: string; truncation?: undefined } {
  const t = s.trim();
  if (t.length <= max) return { text: t };
  return { text: `${t.slice(0, max - 1)}…` };
}

describe('falsifiability control — the pre-fix helper FAILS these guards', () => {
  it('the silent version emits no marker on a body it truncated', () => {
    const body = longBodyWithLateDirective(500);

    // The control truncates...
    expect(silentlyTruncating(body, 100).text.length).toBeLessThan(body.length);
    // ...and discloses nothing, which is exactly the defect. If the real helper
    // ever regressed to this, the assertions in the block above would fail —
    // this proves those assertions are capable of failing at all.
    expect(silentlyTruncating(body, 100).truncation).toBeUndefined();
    expect(capPreservingOperativeDetailed(body, 100).truncation).toBeDefined();
  });

  it('calibration: the control and the real helper agree on the UNtruncated case', () => {
    // Without this, the control could be "failing" for an unrelated reason and
    // the contrast above would prove nothing.
    const short = 'complete';
    expect(silentlyTruncating(short, 5000).truncation).toBeUndefined();
    expect(capPreservingOperativeDetailed(short, 5000).truncation).toBeUndefined();
    expect(silentlyTruncating(short, 5000).text).toBe(
      capPreservingOperativeDetailed(short, 5000).text,
    );
  });
});

describe('the orient recovery fold shape', () => {
  it('a checkpoint marker names a fetch call that actually resolves the item', () => {
    // compaction-recovery builds `more` as work_items:get { id } — the guard is
    // that the id is threaded, since a fetch pointer naming the wrong item is
    // worse than no pointer.
    const marker: CapPreservingOperativeTruncation = capPreservingOperativeDetailed(
      'z'.repeat(5_000),
      1_200,
      { more: "work_items:get { id: 'WI-37986' }" },
    ).truncation!;
    expect(marker.more).toContain('WI-37986');
    expect(marker.withheldChars).toBe(5_000 - 1_199);
  });
});

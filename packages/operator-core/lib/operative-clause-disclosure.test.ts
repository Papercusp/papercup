import { describe, expect, it } from 'vitest';

import {
  OPERATIVE_MARKERS,
  capPreservingOperative,
  capPreservingOperativeDetailed,
  extractKnowledgeIdentifiers,
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

  it('pays for the inline notice OUT OF the budget — an excerpt is never longer than its source', () => {
    // The regression this caught on its first run: the notice was appended PAST
    // the cap, so a 684-char checkpoint rendered as a 737-char "excerpt". A
    // disclosure that blows the budget is the other failure direction of this
    // whole thread — trim too little and the payload is rejected outright.
    const body = `${'a'.repeat(600)} ⛔ NEVER deploy on a red gate.`;
    const withNotice = capPreservingOperative(body, 500, {
      inlineNotice: true,
      more: "work_items:get { id: 'WI-37110' }",
    });
    expect(withNotice.length).toBeLessThan(body.length);

    // The budget identity: head + notice fits inside `max`. (The operative
    // addendum is separately bounded and deliberately sits outside it.)
    const t = capPreservingOperativeDetailed(body, 500, {
      inlineNotice: true,
      more: "work_items:get { id: 'WI-37110' }",
    }).truncation!;
    expect(t.keptChars + renderWithheldNotice(t).length + 1).toBeLessThanOrEqual(500);
  });

  it('renders large numbers readably (a bare 24310 invites a misread as 2431)', () => {
    const notice = renderWithheldNotice({
      keptChars: 1_200,
      totalChars: 25_510,
      withheldChars: 24_310,
      operativeClausesKept: 1,
      identifiersKept: 0,
      more: 'x',
    });
    expect(notice).toContain('24,310');
    expect(notice).toContain('25,510');
  });
});

describe('P-011 — excerpts preserve answer-bearing identifiers independently of directives', () => {
  const incidentSha = '1f43e05ae7a88ebed626c84ff254a0b1508937d6';

  it('replays the 2026-09-03 incident: the freeze rule AND its candidate SHA survive the cut', () => {
    const body =
      `${'historical evidence '.repeat(30)} ` +
      `⛔ NEVER cut a fresh candidate while ${incidentSha} is frozen. ` +
      'See WI-2144181, EI-22344000673418738, F-2048, P-011, ' +
      'packages/operator-core/lib/operative-clause.ts, and :3070.';
    const out = capPreservingOperativeDetailed(body, 160);

    expect(out.text).toContain('⚠ OPERATIVE:');
    expect(out.text).toContain('NEVER cut a fresh candidate');
    expect(out.text).toContain('⚠ IDENTIFIERS:');
    for (const identifier of [
      incidentSha,
      'WI-2144181',
      'EI-22344000673418738',
      'F-2048',
      'P-011',
      'packages/operator-core/lib/operative-clause.ts',
      ':3070',
    ]) {
      expect(out.text).toContain(identifier);
    }
    expect(out.truncation?.identifiersKept).toBe(7);
  });

  it('does not spend the identifier budget repeating a token already visible in the head', () => {
    const body = `${incidentSha} ${'x'.repeat(300)} WI-2144181 ${incidentSha}`;
    const out = capPreservingOperativeDetailed(body, 120);

    expect(out.text).toContain('⚠ IDENTIFIERS: WI-2144181');
    expect(out.text.match(new RegExp(incidentSha, 'g'))).toHaveLength(1);
    expect(out.truncation?.identifiersKept).toBe(1);
  });

  it('keeps only complete tokens inside its own small budget', () => {
    const identifiers = extractKnowledgeIdentifiers(
      `prefix WI-123456 EI-987654 packages/operator-core/lib/a-very-long-file.ts :3070`,
      'prefix',
      { maxChars: 19, maxIdentifiers: 8 },
    );

    expect(identifiers.join(' ').length).toBeLessThanOrEqual(19);
    expect(identifiers).toEqual(['WI-123456', 'EI-987654']);
    expect(identifiers.join(' ')).not.toContain('…');
  });

  it('does not misclassify clock times, short hashes, or out-of-range ports as identifiers', () => {
    expect(
      extractKnowledgeIdentifiers(
        'At 15:57 the short hash abc1234 used port :99999 and ordinary prose had no durable answer.',
        '',
      ),
    ).toEqual([]);
  });

  it('falsifiability control: the pre-fix head-only helper loses the incident SHA', () => {
    const body = `${'evidence '.repeat(80)} ${incidentSha}`;
    expect(silentlyTruncating(body, 120).text).not.toContain(incidentSha);
    expect(capPreservingOperativeDetailed(body, 120).text).toContain(incidentSha);
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

describe('OPERATIVE_MARKERS recognises the emphatic mixed-case negation', () => {
  // Agents write directives as `do NOT …` far more often than `DO NOT …`. The
  // all-caps-only pattern missed those, so the clause that mattered was severed
  // by every excerpting surface that relies on this regex.
  it.each([
    ['DO NOT retry — the error is correct.', true],
    ['do NOT assert load causation without a mechanism.', true],
    ['does NOT yield a degraded acceptance rubric.', true],
    ['must NOT be claimed while a peer holds it.', true],
    ['should NOT be re-run inside the retriage window.', true],
    ['NEVER seize the gate.', true],
    ['⛔ stop here.', true],
  ])('matches %j', (text, expected) => {
    expect(OPERATIVE_MARKERS.test(text as string)).toBe(expected);
  });

  // CONTROL — the case-sensitivity is the whole point. If someone "simplifies"
  // this regex to /i, every one of these starts matching, the small clause
  // budget fills with ordinary prose, and real directives get crowded out.
  // Measured: /i matched 35 clauses on the corpus where this regex matched 14.
  it.each([
    'I do not think that is the cause.',
    'this must be why the probe failed',
    'it does not appear in the ledger',
    'we should not have to guess',
    'the run never completed',
  ])('CONTROL: does NOT match ordinary lowercase prose %j', (text) => {
    expect(OPERATIVE_MARKERS.test(text)).toBe(false);
  });

  it('preserves a mixed-case directive past the cut, end to end', () => {
    const body = `head ${'x'.repeat(400)} do NOT check the desktop binary's pid.`;
    const r = capPreservingOperativeDetailed(body, 200);
    expect(r.text).toContain('⚠ OPERATIVE');
    expect(r.text).toContain('do NOT check the desktop binary');
    expect(r.truncation?.operativeClausesKept).toBeGreaterThan(0);
  });
});

describe('EI-22788167704395660 — late retirement/supersession beats early pause markers', () => {
  const CHECKPOINT =
    `${'historical checkpoint context '.repeat(30)}\n` +
    '## 2026-09-08T23:50Z — PAUSED on owner directive: do NOT fix the 5 staging ratchet reds. ' +
    '⛔ SYSTEM-WIDE PAUSE IN FORCE.\n' +
    '## 2026-09-09T12:10Z — RESUMED. The pause block above is RETIRED, do not act on it. ' +
    '⚠ **SUPERSEDES the PAUSE section above in its entirety.**';

  it('keeps the in-document cancellation when early pause clauses fill the cap', () => {
    const out = capPreservingOperativeDetailed(CHECKPOINT, 500);

    expect(CHECKPOINT.length).toBeGreaterThan(500);
    expect(out.text).toContain('⚠ OPERATIVE:');
    expect(out.text).toContain('RETIRED, do not act on it');
    expect(out.text).toContain('SUPERSEDES the PAUSE section above in its entirety');
    expect(out.truncation?.operativeClausesKept).toBe(2);
  });

  it('recognizes both explicit cancellation spellings without broad lowercase matching', () => {
    expect(OPERATIVE_MARKERS.test('RETIRED, do not act on it.')).toBe(true);
    expect(OPERATIVE_MARKERS.test('SUPERSEDES the PAUSE section above.')).toBe(true);
    expect(OPERATIVE_MARKERS.test('the component was retired last year')).toBe(false);
  });
});

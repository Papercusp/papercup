/**
 * WI-38297 — the stranded-finished-work triage read.
 *
 * The classifier itself (`checkpointDeclaresTerminal`) is REAL here, never mocked. That
 * is the whole point: this suite's job is to pin what the real predicate actually does
 * over real checkpoint text — including where it is WRONG — so nobody "improves" the
 * scan into an auto-closer without a test telling them what that costs.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyStrandedRows,
  checkpointHead,
  harnessFromIssueScope,
} from './stranded-checkpoint-scan';
import { workItemCheckpointScope } from './work-item-checkpoint';
import { checkpointDeclaresTerminal } from './checkpoint-terminal-claim';

const DAY = 86_400_000;
const daysAgo = (n: number) => Date.now() - n * DAY;

function row(over: Partial<Parameters<typeof classifyStrandedRows>[0][number]> = {}) {
  return {
    issue_id: 'WI-1',
    scope: 'harness:papercusp',
    kind: 'change',
    title: 't',
    assignee: null,
    severity: null,
    note: 'P-001 DONE + VERIFIED + plan item FLIPPED to done. Nothing left here.',
    updated_ts: String(daysAgo(10)),
    ...over,
  };
}

describe('the carry-note scope key: the join premise (WI-38297)', () => {
  /**
   * `scanStrandedCheckpoints` joins carry_notes to work-items on the ID PARSED OUT OF
   * the scope key — `substring(cn.scope from '[^:]+$')`, i.e. everything after the LAST
   * colon. That is a structural assumption about `workItemCheckpointScope`'s output
   * format, and it is invisible from the SQL: if the key ever gains a trailing
   * component, the join silently matches ZERO rows and the tool reports a clean,
   * confident "no stranded work" — the exact shape of failure this whole work-item
   * exists to eliminate. So assert the premise directly against the real key builder.
   */
  const ids = ['WI-5895', 'EI-18681435059177620', 'F-42'];
  const harnesses = ['papercusp', null, '', '*', 'oddsmith-hive', '@singleton'];

  it('always puts the work-item id after the LAST colon', () => {
    for (const h of harnesses) {
      for (const id of ids) {
        const scope = workItemCheckpointScope(h, id);
        expect(scope.slice(scope.lastIndexOf(':') + 1), `scope=${scope}`).toBe(id);
      }
    }
  });

  it("always starts with the 'workitem:' prefix the scan filters on", () => {
    for (const h of harnesses) {
      expect(workItemCheckpointScope(h, 'WI-1').startsWith('workitem:')).toBe(true);
    }
  });

  it('canonicalizes null/empty/* harness onto ONE namespace, so no item is unreachable', () => {
    const wildcard = workItemCheckpointScope('*', 'WI-1');
    expect(workItemCheckpointScope(null, 'WI-1')).toBe(wildcard);
    expect(workItemCheckpointScope('', 'WI-1')).toBe(wildcard);
    // …and the id is STILL the trailing segment for that shape — the harness-null case
    // is precisely the one a rebuilt-in-SQL scope string would have missed (EI-8805).
    expect(wildcard.slice(wildcard.lastIndexOf(':') + 1)).toBe('WI-1');
  });
});

describe('checkpointHead — the tool-log tail trap (WI-38297)', () => {
  /**
   * Checkpoints carry an auto-appended `tool-log tail:` block listing TOOL NAMES, and
   * those names include the literal strings `work_items_complete` / `work_items_release`.
   * Measured: 6 of 15 matches in a tail-reading experiment were pure tool-log noise.
   */
  const withToolLog =
    'CLAIMED 03:27Z, no code written yet. Read the item body in full.\n' +
    '\ntool-log tail:\n' +
    'work_items_claim ·\nBash npm run test:file -- packages/… ✓\nwork_items_complete ×2 ·\nwork_items_release ·';

  it('strips the tool-log tail so it cannot be read as completion evidence', () => {
    const head = checkpointHead(withToolLog);
    expect(head).toContain('no code written yet');
    expect(head).not.toContain('tool-log tail');
    expect(head).not.toContain('work_items_complete');
    expect(head).not.toContain('work_items_release');
  });

  it('returns the HEAD, not the tail, when the note exceeds the budget', () => {
    const note = `OPENING VERDICT: this is the part that decides the item.${'x'.repeat(5000)}TAIL`;
    const head = checkpointHead(note, 60);
    expect(head.startsWith('OPENING VERDICT')).toBe(true);
    expect(head).not.toContain('TAIL');
    expect(head.length).toBeLessThanOrEqual(61); // 60 + the ellipsis
  });

  it('leaves a short note whole and un-ellipsized', () => {
    expect(checkpointHead('P-001 DONE. Nothing left here.')).toBe('P-001 DONE. Nothing left here.');
  });
});

describe('CONTROL CASES — the measured false positives (WI-38297)', () => {
  /**
   * ⚠ THESE ASSERTIONS DOCUMENT A KNOWN DEFECT, NOT A DESIRED BEHAVIOUR.
   *
   * `checkpointDeclaresTerminal` measured ~43% precise over the live open backlog
   * (2026-08-12, hand-reading all 23 matches). The strings below are REAL checkpoint
   * heads from that measurement which the classifier MATCHES and which are emphatically
   * NOT finished work. They are pinned permanently because they are the evidence that
   * this surface must stay read-only: an auto-closer built on this predicate would close
   * an item whose own checkpoint opens "⛔ DO NOT CLOSE".
   *
   * If you improve the classifier so one of these stops matching, that is a genuine win
   * — delete it from this list and say so. Do NOT delete the list.
   */
  /**
   * VERBATIM excerpts, including the substring that actually fired — established by
   * running each marker against the real notes and printing the match with its context.
   * Paraphrases are worthless as controls here: an earlier draft of this suite used
   * tidied-up versions of these heads and they did NOT match, because the deciding text
   * sat thousands of characters below the part a human would quote.
   */
  const knownFalsePositives: ReadonlyArray<readonly [string, string]> = [
    [
      'EI-19474857043229377 — "closed" describes a sub-QUESTION, not the item',
      'READ THREAD POST 56018 FIRST — it FALSIFIES the leading hypotheses with measurements.\n\n' +
        'STATE: open, claimed. ⛔ DO NOT CLOSE on the strength of the instrumentation shipped ' +
        'below — the deciding leg is still UNIDENTIFIED.\n\n' +
        'Everything above is a snapshot from 08-04 whose central open question is now CLOSED.\n\n' +
        '**THE DECIDING LEG IS `cupPlaceableFrontier`.**',
    ],
    [
      'EI-20034001963934568 — "flipped done" describes ANOTHER plan\'s item',
      'CLAIMED 03:27Z, no code written yet. Read the item body in full — it is unusually ' +
        'well-diagnosed; do not re-derive it.\n\n' +
        'goal-mode-2026-08-07 P-001 → WORKSPACE PER GOAL, recorded as D-027, item flipped done. ' +
        "That plan's Phase 1 is unblocked and its downstream items are claimable.",
    ],
    [
      'WI-38071 — a duplicate, not finished work',
      'DUPLICATE LEADER ITEM — do not resume separately. WI-38071 links duplicates → WI-37891.',
    ],
  ];

  it.each(knownFalsePositives)('still matches known false positive: %s', (_label, cp) => {
    expect(checkpointDeclaresTerminal(cp)).toBe(true);
  });

  /**
   * THE MECHANISM, pinned separately because it is the actionable half.
   *
   * Five of the six markers are anchored (`^…`) or structurally specific. The sixth —
   * the `<verb> to <terminal-state>` alternation — is NOT anchored, so it fires on a
   * terminal statement made about SOMETHING OTHER THAN THE ITEM, anywhere in a long
   * checkpoint. Measured offsets in the two real notes above: 2,818 and 13,364 chars in.
   * Both anchored markers were clean.
   *
   * This is why the fix is NOT "tighten the regex" from inside this scan: the predicate
   * is shared with the pot placement watchdog's stale-open reconcile, where the
   * false-positive cost is different (it suppresses a re-place page). Restricting the
   * unanchored marker to the note head would likely kill both of these, and is worth
   * doing deliberately, with the watchdog's own cases re-verified — not as a side effect
   * of a triage read.
   */
  it('the imprecision comes from the ONE unanchored marker, firing deep in the note', () => {
    const aboutSomethingElse = `${'context. '.repeat(200)}the open question is now CLOSED.`;
    expect(checkpointDeclaresTerminal(aboutSomethingElse)).toBe(true);
    // …while the anchored markers cannot fire from mid-text at all.
    expect(checkpointDeclaresTerminal(`${'context. '.repeat(200)}TERMINAL — done here.`)).toBe(false);
    expect(checkpointDeclaresTerminal(`${'context. '.repeat(200)}WI-4480 PASSED 2026-07-17.`)).toBe(false);
  });

  it('matches genuine completion declarations too (the calibration case)', () => {
    // Without this, the assertions above would also pass if the predicate matched
    // EVERYTHING — a classifier that is broken open is not the same as one that is 43%.
    expect(
      checkpointDeclaresTerminal('P-001 DONE + VERIFIED + plan item FLIPPED to done. Nothing left here.'),
    ).toBe(true);
    expect(checkpointDeclaresTerminal('WI-4480 PASSED 2026-07-17 15:12Z')).toBe(true);
  });

  it('does NOT match an ordinary in-progress checkpoint (the negative control)', () => {
    expect(checkpointDeclaresTerminal('Read the resolver; next step is to wire the sync query.')).toBe(false);
    expect(checkpointDeclaresTerminal('Investigating why the gate is red; no fix yet.')).toBe(false);
    expect(checkpointDeclaresTerminal('')).toBe(false);
    expect(checkpointDeclaresTerminal(null)).toBe(false);
  });
});

describe('ranking — oldest strand first (WI-38297)', () => {
  /**
   * REGRESSION PIN for a rationale the live data refuted. The first cut ranked
   * `citesBgJob` ABOVE age, reasoning that a checkpoint promising a background-job
   * result was the strongest strand signal. Measured against the live backlog, the four
   * bg-citing matches were 0d/0d/3d/10d old while every genuine strand (WI-3529 33d,
   * WI-5372 24d, WI-5457 23d) cited no job at all: an agent whose checkpoint mentions a
   * running job is usually an agent working RIGHT NOW.
   */
  it('ranks an OLD strand above a fresh one that cites a background job', () => {
    const r = classifyStrandedRows(
      [
        row({
          issue_id: 'FRESH-BG',
          // WI-5895's real phrasing: the strand as it is actually created.
          note:
            'WI-5895 DONE — fix committed. test:affected running in background (bash id bx76day3h) ' +
            'to confirm no other suite depended on the old behavior — will report+complete once it finishes.',
          updated_ts: String(daysAgo(0)),
        }),
        row({ issue_id: 'OLD-STRAND', updated_ts: String(daysAgo(30)) }),
      ],
      { limit: 10 },
    );
    expect(r.candidates.map((c) => c.id)).toEqual(['OLD-STRAND', 'FRESH-BG']);
    expect(r.candidates[1]!.citesBgJob).toBe(true);
  });

  it('breaks an age tie toward the background-job citation', () => {
    const r = classifyStrandedRows(
      [
        row({ issue_id: 'PLAIN', updated_ts: String(daysAgo(5)) }),
        row({
          issue_id: 'BG',
          note: 'P-001 DONE + VERIFIED. Awaiting the in-flight verification job.',
          updated_ts: String(daysAgo(5)),
        }),
      ],
      { limit: 10 },
    );
    expect(r.candidates.map((c) => c.id)).toEqual(['BG', 'PLAIN']);
  });
});

describe('counts are totals, never page-bounded (WI-38297)', () => {
  /**
   * A count computed over a capped fetch is indistinguishable from a real total, and
   * THIS count gets read as "how much stranded work is there". So `matched` must span
   * the whole population even when the row list is a page.
   */
  const many = Array.from({ length: 25 }, (_, i) =>
    row({ issue_id: `WI-${i}`, updated_ts: String(daysAgo(i + 1)) }),
  );

  it('reports the full match count beside a truncated page, and says it is truncated', () => {
    const r = classifyStrandedRows(many, { limit: 5 });
    expect(r.scanned).toBe(25);
    expect(r.matched).toBe(25);
    expect(r.returned).toBe(5);
    expect(r.candidates).toHaveLength(5);
    expect(r.truncatedByLimit).toBe(true);
  });

  it('does not claim truncation when the page holds everything', () => {
    const r = classifyStrandedRows(many, { limit: 100 });
    expect(r.matched).toBe(25);
    expect(r.returned).toBe(25);
    expect(r.truncatedByLimit).toBe(false);
  });

  it('counts only classifier matches, not the scanned population', () => {
    const r = classifyStrandedRows(
      [row({ issue_id: 'HIT' }), row({ issue_id: 'MISS', note: 'still working on the resolver' })],
      { limit: 10 },
    );
    expect(r.scanned).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.candidates.map((c) => c.id)).toEqual(['HIT']);
  });
});

describe('minAgeDays floor (WI-38297)', () => {
  it('drops matches younger than the floor and echoes the floor beside the count', () => {
    const rows = [
      row({ issue_id: 'OLD', updated_ts: String(daysAgo(30)) }),
      row({ issue_id: 'YOUNG', updated_ts: String(daysAgo(1)) }),
    ];
    expect(classifyStrandedRows(rows, { limit: 10 }).matched).toBe(2);
    const floored = classifyStrandedRows(rows, { limit: 10, minAgeDays: 7 });
    expect(floored.matched).toBe(1);
    expect(floored.minAgeDays).toBe(7);
    expect(floored.candidates.map((c) => c.id)).toEqual(['OLD']);
  });

  it('KEEPS an undated checkpoint under a floor — unknown age is not evidence of freshness', () => {
    const r = classifyStrandedRows([row({ issue_id: 'NO-TS', updated_ts: null })], {
      limit: 10,
      minAgeDays: 30,
    });
    expect(r.matched).toBe(1);
    expect(r.candidates[0]!.checkpointAgeDays).toBeNull();
    expect(r.candidates[0]!.checkpointWrittenTs).toBeNull();
  });

  it('reports minAgeDays 0 when no floor was asked for', () => {
    expect(classifyStrandedRows([row()], { limit: 10 }).minAgeDays).toBe(0);
  });
});

describe('row projection (WI-38297)', () => {
  it('derives the harness from the issue scope, and tolerates a non-harness scope', () => {
    expect(harnessFromIssueScope('harness:papercusp')).toBe('papercusp');
    expect(harnessFromIssueScope('harness:@singleton')).toBe('@singleton');
    expect(harnessFromIssueScope('operator')).toBeNull();
    expect(harnessFromIssueScope(null)).toBeNull();
  });

  it('carries the evidence a reader needs to overturn the match', () => {
    const r = classifyStrandedRows(
      [row({ issue_id: 'WI-5895', assignee: 'su-7a80832c', severity: 'major' })],
      { limit: 10 },
    );
    const c = r.candidates[0]!;
    expect(c).toMatchObject({
      id: 'WI-5895',
      harness: 'papercusp',
      kind: 'change',
      assignee: 'su-7a80832c',
      severity: 'major',
    });
    expect(c.checkpointHead).toContain('DONE');
    expect(c.checkpointAgeDays).toBe(10);
  });

  it('handles a numeric updated_ts as well as the bigint-as-string form', () => {
    const ts = daysAgo(3);
    expect(classifyStrandedRows([row({ updated_ts: ts })], { limit: 1 }).candidates[0]!.checkpointAgeDays).toBe(3);
    expect(
      classifyStrandedRows([row({ updated_ts: String(ts) })], { limit: 1 }).candidates[0]!.checkpointAgeDays,
    ).toBe(3);
  });
});

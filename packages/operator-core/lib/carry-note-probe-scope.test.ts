/**
 * carry-note-probe-scope.test.ts — EI-18741016606334594.
 *
 * Two subjects, and the FIRST one is the dangerous half:
 *
 *  1. The render/parse ROUND-TRIP. `renderCheckLine` now emits a derived
 *     `[scope: …]` marker, and `parseCheckLine` must strip it. If it does not,
 *     the marker is absorbed into the claim, and since every cold wake
 *     re-renders every stored row, each claim in the fleet GROWS by one marker
 *     per wake — silently, forever, across all 4,040 stored rows. That is the
 *     regression these tests exist for; the lint below is decoration by
 *     comparison.
 *
 *  2. The detector rules, each pinned to the corpus measurement that earned it.
 */
import { describe, it, expect } from 'vitest';

import { renderCheckLine, parseCheckLine, type CheckEntry } from './carry-note';
import {
  describeProbeScope,
  detectScopeOverreach,
  isPrescriptiveClaim,
  renderProbeScopeMarker,
  stripProbeScopeMarker,
} from './carry-note-probe-scope';

describe('render/parse round-trip with the derived scope marker', () => {
  const rows: CheckEntry[] = [
    { claim: 'the gate is green', recheck: "journalctl --since '60 min ago' | grep GATE", verified: 'read 19:47Z' },
    { claim: 'no runaway proc', recheck: 'pgrep -af build; tail -5 /tmp/x.log', verified: 'checked' },
    { claim: 'a plain claim', recheck: 'npm run test:file -- x.test.ts', verified: 'ran it' },
    { claim: 'predicted, bounded probe', recheck: 'head -20 /tmp/y.log' },
    { claim: 'no probe at all' },
    { claim: 'with an id', id: 'gate-green', recheck: 'tail -3 log', verified: 'yes' },
    { claim: 'with a since stamp', recheck: 'limit 10', verified: 'yes', sinceMs: Date.parse('2026-08-13T00:00:00Z') },
  ];

  it('parses back to the ORIGINAL claim — the marker never leaks into the claim text', () => {
    for (const row of rows) {
      const parsed = parseCheckLine(renderCheckLine(row));
      expect(parsed, `row: ${row.claim}`).not.toBeNull();
      expect(parsed!.claim, `row: ${row.claim}`).toBe(row.claim);
    }
  });

  it('is IDEMPOTENT over repeated wakes — 10 render→parse cycles leave the row byte-identical', () => {
    for (const row of rows) {
      const first = renderCheckLine(row);
      let cur = first;
      for (let i = 0; i < 10; i += 1) {
        const parsed = parseCheckLine(cur);
        expect(parsed, `cycle ${i} of: ${row.claim}`).not.toBeNull();
        cur = renderCheckLine(parsed!);
      }
      // The exact failure this pins: a claim that grows by one marker per wake.
      expect(cur, `row: ${row.claim}`).toBe(first);
      expect(parseCheckLine(cur)!.claim).toBe(row.claim);
    }
  });

  it('preserves id, recheck, evidence and sinceMs across the round-trip', () => {
    const row = rows[6];
    const parsed = parseCheckLine(renderCheckLine(row))!;
    expect(parsed.recheck).toBe(row.recheck);
    expect(parsed.verified).toBe(row.verified);
    expect(parsed.sinceMs).toBe(row.sinceMs);
    const withId = parseCheckLine(renderCheckLine(rows[5]))!;
    expect(withId.id).toBe('gate-green');
  });

  it('renders the marker only when the probe declares a bound', () => {
    expect(renderCheckLine(rows[0])).toContain('[scope: last 60 min]');
    // An unbounded probe gets NO marker — an unbounded read is not a defect.
    expect(renderCheckLine(rows[2])).not.toContain('[scope:');
    expect(renderCheckLine(rows[4])).not.toContain('[scope:');
  });

  it('survives a row whose claim ALREADY contains a marker-shaped prefix', () => {
    // A hand-authored row, or one round-tripped through an older renderer.
    const parsed = parseCheckLine('- ✓ [scope: last 5 min] the real claim — re-check: tail -2 log — evidence: e');
    expect(parsed!.claim).toBe('the real claim');
    expect(renderCheckLine(parsed!)).toBe(
      '- ✓ [scope: last 2 lines] the real claim — re-check: tail -2 log — evidence: e',
    );
  });

  it('stripProbeScopeMarker is idempotent and leaves unmarked text alone', () => {
    expect(stripProbeScopeMarker('[scope: last 60 min] hello')).toBe('hello');
    expect(stripProbeScopeMarker(stripProbeScopeMarker('[scope: x] hello'))).toBe('hello');
    expect(stripProbeScopeMarker('hello')).toBe('hello');
    // A `]` inside a label can never terminate the marker early.
    expect(renderProbeScopeMarker({ label: 'a]b', kind: 'time' })).toBe('[scope: ab]');
  });
});

describe('describeProbeScope — the bound a probe declares about itself', () => {
  it.each([
    ["journalctl --user -u x --since '60 min ago' | grep G", 'last 60 min'],
    ['logs --since "24 hours ago"', 'last 24 hours'],
    ['git log --since=\'2026-08-02 20:00\' --name-only', 'since 2026-08-02'],
    ['journalctl --since today | grep -c boot', 'since today'],
    ["ss -tn --since '-30min'", 'last 30 min'],
    ['testing:runs { filePath, sinceHours: 24 }', 'last 24 hours'],
    ['head -20 /tmp/a.log', 'first 20 lines'],
    ['tail -n 5 /tmp/a.log', 'last 5 lines'],
    ['git push --dry-run 2>&1 | tail -2', 'last 2 lines'],
    ['grep -n PAT file.sh | head', 'first few lines'],
    ['SELECT a FROM t LIMIT 10', 'limit 10'],
    ['capability:read { file_path: x, limit: 86 }', 'limit 86'],
  ])('reads %s as %s', (recheck, label) => {
    expect(describeProbeScope(recheck)?.label).toBe(label);
  });

  it('returns null for an UNBOUNDED probe — the common, correct answer', () => {
    for (const r of [
      'npm run test:file -- packages/operator-core/lib/x.test.ts',
      'git rev-parse HEAD',
      'work_items:get { id: EI-1 }',
      're-read the file before editing',
      '',
      undefined,
      null,
    ]) {
      expect(describeProbeScope(r as string | null | undefined)).toBeNull();
    }
  });

  it('never emits a label containing `]` — that would break the row grammar', () => {
    for (const r of ["--since '60 min ago'", 'tail -3', 'limit 9']) {
      expect(describeProbeScope(r)!.label).not.toContain(']');
    }
  });

  it('is total — no input throws', () => {
    for (const r of ['--since', 'tail -', 'limit', '(((', ' ', '\x00', 'a'.repeat(5000)]) {
      expect(() => describeProbeScope(r)).not.toThrow();
    }
  });
});

describe('detectScopeOverreach — the advisory lint', () => {
  const overreaching: CheckEntry = {
    claim: 'No gate run produced a verdict today.',
    recheck: "journalctl -u gate --since '60 min ago' | grep -E 'GATE:'",
    verified: 'Read first-hand 19:47Z including the Finished line',
  };

  it('flags the ROOT INCIDENT: a claim about a day backed by a 60-minute probe', () => {
    const hits = detectScopeOverreach([overreaching]);
    expect(hits).toHaveLength(1);
    // Sentence-initial "No" is the actual quantifier — a case-restricted match
    // used to skip it and report `today` instead, missing the root incident.
    expect(hits[0].quantifier).toBe('No');
    expect(hits[0].probeScope).toBe('last 60 min');
    expect(hits[0].claim).toContain('No gate run produced a verdict today');
  });

  it('does NOT flag a ? PREDICTED row — there is no badge to inherit', () => {
    const { verified: _dropped, ...predicted } = overreaching;
    expect(detectScopeOverreach([predicted])).toHaveLength(0);
  });

  it('does NOT flag an unbounded probe — an unbounded read cannot be outrun', () => {
    expect(detectScopeOverreach([{ ...overreaching, recheck: 'journalctl -u gate | grep GATE' }])).toHaveLength(0);
  });

  it('does NOT flag an unquantified claim', () => {
    expect(
      detectScopeOverreach([{ ...overreaching, claim: 'the 14:42 run SKIPPED after 165.71s' }]),
    ).toHaveLength(0);
  });

  /**
   * The measured false-positive class. This fleet writes standing discipline as
   * checks rows, and those carry universal quantifiers by construction while
   * describing no bounded observation at all. Every string below is taken from
   * the real corpus (`harness_shared.carry_notes`).
   */
  it('does NOT flag PRESCRIPTIVE rows — the dominant measured false positive', () => {
    const prescriptive = [
      '⛔ Do NOT pass --mobile-root to any cut/upload. The android leg builds all 4 ABIs then ABORTS.',
      'NEVER trust a background task-completion notification exit code — it reported 0 for runs that exited 1.',
      'For ANY red-test item: re-run at HEAD FIRST, then read the failing assertion values.',
      '⚠ Read a background run via its TEE target, NEVER capability:bash_output, when the pipeline ends in head.',
    ];
    for (const claim of prescriptive) {
      expect(isPrescriptiveClaim(claim), claim).toBe(true);
      expect(detectScopeOverreach([{ claim, recheck: 'tail -5 /tmp/x.log', verified: 'yes' }]), claim).toHaveLength(0);
    }
  });

  it('still flags an ordinary-prose observational claim carrying the same words', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'the socket-death regime is not reproducible — no bulk transfer starts at all',
          recheck: "journalctl --since today | grep -oE 'moved' | tail -3",
          verified: 'read it',
        },
      ]),
    ).toHaveLength(1);
  });

  it('does NOT flag quantifiers used to disclaim the writer\'s own scope', () => {
    const narrowing = [
      {
        claim: 'I split the badge and added never run by me to the recheck.',
        recheck: 'npm run lint:tsc:operator | tail -25',
        verified: 'peer assertion',
      },
      {
        claim: 'MEASURED (this is the whole of what my probe saw).',
        recheck: 'npm run lint:tsc:operator | tail -25',
        verified: 'yes',
      },
    ];

    expect(detectScopeOverreach(narrowing)).toEqual([]);
  });

  it('still flags a broad assertion that shares a row with a scope disclaimer', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'No gate run produced a verdict today; the peer result was never run by me.',
          recheck: 'npm run lint:tsc:operator | tail -25',
          verified: 'split evidence',
        },
      ]),
    ).toMatchObject([{ quantifier: 'No', probeScope: 'last 25 lines' }]);
  });

  it('bounds its output and is total on junk input', () => {
    const many = Array.from({ length: 20 }, () => overreaching);
    expect(detectScopeOverreach(many)).toHaveLength(3);
    expect(detectScopeOverreach(many, 5)).toHaveLength(5);
    expect(detectScopeOverreach(null)).toEqual([]);
    expect(detectScopeOverreach(undefined)).toEqual([]);
    expect(detectScopeOverreach([{}, { claim: '' }, { claim: '   ' }])).toEqual([]);
  });

  /**
   * CALIBRATION + CONTROL (repo discipline: a guard that has never failed is a
   * guard you have not tested, and proving falsifiability must never mutate the
   * shared tree). The control is a deliberately-scope-BLIND implementation kept
   * permanently here: it must flag the root incident AND the prescriptive rows,
   * while the real detector flags only the former. If both ever agree, the
   * prescriptive exclusion has silently stopped working.
   */
  it('a scope-BLIND control flags what the real detector correctly skips', () => {
    const blind = (row: CheckEntry): boolean =>
      /\b(no|never|every|all|any|today)\b/i.test(row.claim) && !!describeProbeScope(row.recheck);

    const prescriptiveRow: CheckEntry = {
      claim: 'NEVER trust a background task exit code — it reported 0 for every run that exited 1.',
      recheck: 'tail -5 /tmp/x.log',
      verified: 'yes',
    };

    // Calibration: both agree on the genuine overreach, so the control is live.
    expect(blind(overreaching)).toBe(true);
    expect(detectScopeOverreach([overreaching])).toHaveLength(1);

    // Discrimination: only the blind control fires on standing discipline.
    expect(blind(prescriptiveRow)).toBe(true);
    expect(detectScopeOverreach([prescriptiveRow])).toHaveLength(0);
  });
});

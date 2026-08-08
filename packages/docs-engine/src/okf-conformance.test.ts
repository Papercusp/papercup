/**
 * okf-conformance unit tests — `okf-frontmatter-adoption-2026-08-08` P-006.
 *
 * Every rule gets BOTH a violation that must fire and a conformant control that
 * must not. The controls are the point: a detector that has never been shown to
 * fail is a detector nobody has tested, and the corpus is 100% conformant today
 * (659/659 insights, 70/70 pack docs), so `lint:okf-conformance` will run green
 * from the day it lands whether or not it can detect anything at all.
 *
 * The cases marked LOSSY-PARSER are the ones that matter most: each is a defect
 * that `parseOkfFrontmatter` DISCARDS during normalisation, so a conformance
 * check built on the normalised view would report a clean doc. They exist to
 * pin the raw-mapping read in `findOkfDocViolations` against a future
 * "simplification" back onto the normaliser.
 */

import { describe, expect, it } from 'vitest';
import {
  findOkfDocViolations,
  findOkfManifestViolations,
  formatOkfViolations,
  OKF_CONFORMANCE_RULES,
  type OkfConformanceRule,
} from './okf-conformance.js';
import { okfFromObject, parseOkfFrontmatter } from './okf.js';

const doc = (frontmatter: string, body = 'Body text.\n') => `---\n${frontmatter}\n---\n${body}`;

const rules = (source: string): OkfConformanceRule[] => findOkfDocViolations(source).map((v) => v.rule);

describe('findOkfDocViolations — the conformant control', () => {
  it('passes a doc carrying only the mandatory field', () => {
    expect(findOkfDocViolations(doc('title: T\ntype: Insight'))).toEqual([]);
  });

  it('passes a fully-populated doc (all four fields, list form)', () => {
    const source = doc(
      [
        'title: T',
        'type: Runbook',
        'generated:',
        '  by: agent',
        '  at: 2026-01-02',
        'verified:',
        '  - by: avi',
        '    at: 2026-02-03',
        '  - by: ci',
        '    at: 2026-03-04',
        'stale_after: 2027-01-01',
      ].join('\n'),
    );
    expect(findOkfDocViolations(source)).toEqual([]);
  });

  it('passes the BARE `verified` mapping the spec requires consumers to accept', () => {
    // Not a convenience: the spec says a bare mapping MUST be read as a
    // single-element list, so rejecting it here would fail conformant input.
    expect(findOkfDocViolations(doc('type: Insight\nverified:\n  by: avi\n  at: 2026-02-03'))).toEqual([]);
  });

  it('passes an UNQUOTED date, which js-yaml resolves to a Date instance', () => {
    // Plan D-002: `stale_after: 2026-08-08` unquoted is a Date, quoted is a
    // string. Both are legal YAML for the same authored line — a rule that
    // demanded a string would red the build on the quoting style, not on a defect.
    const parsed = parseOkfFrontmatter(doc('type: Insight\nstale_after: 2030-01-01\nverified:\n  by: avi\n  at: 2026-02-03'));
    expect(parsed?.staleAfter).toBe('2030-01-01');
    expect(findOkfDocViolations(doc('type: Insight\nstale_after: 2030-01-01'))).toEqual([]);
  });

  it('tolerates an unknown `type` — the spec makes it free-form', () => {
    // Enumerating `type` would reject a conformant third-party bundle, which is
    // exactly the interop this adoption is for.
    expect(findOkfDocViolations(doc('type: SomeBundleSpecificType'))).toEqual([]);
  });
});

describe('findOkfDocViolations — missing `type`', () => {
  it('fires when absent', () => {
    expect(rules(doc('title: T'))).toEqual(['missing-type']);
  });

  it('fires on an empty or non-string value rather than accepting the key', () => {
    expect(rules(doc('title: T\ntype: ""'))).toEqual(['missing-type']);
    expect(rules(doc('title: T\ntype:   '))).toEqual(['missing-type']);
    expect(rules(doc('title: T\ntype: 7'))).toEqual(['missing-type']);
  });

  it('reports the unreadable frontmatter CAUSE rather than a bare missing-type', () => {
    // "This doc has no type" is true but useless when the real problem is that
    // nothing can read its frontmatter at all — the fix is different.
    expect(rules('No frontmatter here at all.\n')).toEqual(['frontmatter-missing']);
    expect(rules(doc('type: Insight\n  bad: [indent'))).toEqual(['frontmatter-unparseable']);
    expect(rules(doc('- just\n- a list'))).toEqual(['frontmatter-unparseable']);
  });

  it('names a BOM as the cause when one hides an otherwise-present block', () => {
    // Otherwise the finding reads as nonsense on a file that visibly starts with
    // `---`, and gets dismissed as a broken lint rather than a broken doc.
    const v = findOkfDocViolations('﻿' + doc('type: Insight'));
    expect(v.map((x) => x.rule)).toEqual(['frontmatter-missing']);
    expect(v[0].detail).toContain('BOM');
  });
});

describe('findOkfDocViolations — `verified` entries', () => {
  it('fires when an entry has no `at`', () => {
    expect(rules(doc('type: Insight\nverified:\n  by: avi'))).toEqual(['verified-missing-at']);
  });

  it('LOSSY-PARSER: fires when an entry has no `by`, which the normaliser DROPS', () => {
    const source = doc('type: Insight\nverified:\n  at: 2026-02-03');
    // The normalised view sees no verification at all — the entry is gone, so a
    // checker reading `OkfFrontmatter.verified` would find nothing to complain about.
    expect(parseOkfFrontmatter(source)?.verified).toBeUndefined();
    // The raw-mapping read still sees it.
    expect(rules(source)).toEqual(['verified-missing-by']);
  });

  it('LOSSY-PARSER: fires per-entry inside a list, on the entry the normaliser drops', () => {
    const source = doc(
      ['type: Insight', 'verified:', '  - by: avi', '    at: 2026-02-03', '  - at: 2026-04-05'].join('\n'),
    );
    // The normaliser keeps the good entry and silently discards the bad one, so
    // the doc reads as legitimately human-verified.
    expect(parseOkfFrontmatter(source)?.verified).toHaveLength(1);
    const v = findOkfDocViolations(source);
    expect(v.map((x) => x.rule)).toEqual(['verified-missing-by']);
    expect(v[0].detail).toContain('entry 2 of 2');
  });

  it('fires on an entry that is not a mapping at all', () => {
    expect(rules(doc('type: Insight\nverified:\n  - avi'))).toEqual(['verified-not-a-mapping']);
    expect(rules(doc('type: Insight\nverified: avi'))).toEqual(['verified-not-a-mapping']);
  });

  it('reports BOTH missing keys on an entry that has neither', () => {
    expect(rules(doc('type: Insight\nverified:\n  - note: nothing useful'))).toEqual([
      'verified-missing-by',
      'verified-missing-at',
    ]);
  });

  it('does not fire on an ABSENT `verified` — unverified is the honest default', () => {
    // Plan D-002: a fabricated verification is strictly worse than none, so the
    // rule must never pressure an author into inventing one.
    expect(findOkfDocViolations(doc('type: Insight'))).toEqual([]);
    expect(findOkfDocViolations(doc('type: Insight\nverified:'))).toEqual([]);
  });
});

describe('findOkfDocViolations — `stale_after` must parse as a date', () => {
  it('fires on a date-shaped-but-unparseable value', () => {
    // Zod's `z.union([z.string(), z.date()])` accepts this, and the read surface
    // then reports staleAfterUnparseable — an expiry that can never fire.
    expect(rules(doc('type: Insight\nstale_after: "soon"'))).toEqual(['stale-after-unparseable']);
    expect(rules(doc('type: Insight\nstale_after: "2026-13-45"'))).toEqual(['stale-after-unparseable']);
  });

  it('LOSSY-PARSER: fires on a value the normaliser refuses outright', () => {
    // `normalizeOkfDate` returns undefined for a boolean/mapping, so `staleAfter`
    // never reaches the date parser and the field vanishes from the parsed view.
    const source = doc('type: Insight\nstale_after: true');
    expect(okfFromObject({ type: 'Insight', stale_after: true })?.staleAfter).toBeUndefined();
    expect(rules(source)).toEqual(['stale-after-unparseable']);
    expect(rules(doc('type: Insight\nstale_after:\n  on: 2026-01-01'))).toEqual(['stale-after-unparseable']);
  });

  it('does NOT fire merely because a doc is past its date — expiry is not a defect', () => {
    // Staleness is a READ-TIME verdict (plan D-004, its own class). A doc whose
    // stale_after has passed is correctly authored; a lint that red-pinned the
    // build for it would make authors delete the field to get green.
    expect(findOkfDocViolations(doc('type: Insight\nstale_after: 1999-01-01'))).toEqual([]);
  });
});

describe('findOkfManifestViolations', () => {
  const manifest = (extra: string[] = []) =>
    ['id: coding', 'title: Coding', 'description: D', 'version: 0.1.0', ...extra, ''].join('\n');

  it('passes a manifest declaring okf_version, quoted or bare', () => {
    // `okf_version: 0.2` unquoted is a YAML NUMBER; pack-format stringifies it,
    // so a number is conformant and must not be reported.
    expect(findOkfManifestViolations(manifest(['okf_version: "0.2"']))).toEqual([]);
    expect(findOkfManifestViolations(manifest(['okf_version: 0.2']))).toEqual([]);
  });

  it('fires when okf_version is absent', () => {
    expect(findOkfManifestViolations(manifest()).map((v) => v.rule)).toEqual(['manifest-missing-okf-version']);
  });

  it('fires on an empty or structured okf_version', () => {
    expect(findOkfManifestViolations(manifest(['okf_version: ""'])).map((v) => v.rule)).toEqual([
      'manifest-okf-version-unusable',
    ]);
    expect(findOkfManifestViolations(manifest(['okf_version:', '  spec: 0.2'])).map((v) => v.rule)).toEqual([
      'manifest-okf-version-unusable',
    ]);
  });

  it('fires on an unparseable manifest', () => {
    expect(findOkfManifestViolations('id: coding\n  bad: [indent').map((v) => v.rule)).toEqual([
      'manifest-unparseable',
    ]);
    expect(findOkfManifestViolations('- a\n- list').map((v) => v.rule)).toEqual(['manifest-unparseable']);
  });

  it('is not confused by a manifest that happens to start with `---`', () => {
    // A manifest is bare YAML, but nothing stops an author writing document
    // fences; the reader must judge the mapping either way.
    expect(findOkfManifestViolations(`---\n${manifest(['okf_version: "0.2"'])}`)).toEqual([]);
  });
});

describe('formatOkfViolations + the rule table', () => {
  it('returns null for a clean doc and a single line otherwise', () => {
    expect(formatOkfViolations([])).toBeNull();
    const msg = formatOkfViolations(findOkfDocViolations(doc('title: T\nstale_after: "soon"')));
    expect(msg).toContain('missing-type');
    expect(msg).toContain('stale-after-unparseable');
    expect(msg?.split('\n')).toHaveLength(1);
  });

  it('documents EVERY rule the detector can emit', () => {
    // The lint prints this table on failure, so a rule missing from it would
    // produce a finding with no explanation of what to do about it.
    const emitted: OkfConformanceRule[] = [
      ...findOkfDocViolations('no frontmatter'),
      ...findOkfDocViolations(doc('bad: [indent')),
      ...findOkfDocViolations(doc('title: T')),
      ...findOkfDocViolations(doc('type: I\nverified:\n  - x')),
      ...findOkfDocViolations(doc('type: I\nverified:\n  - note: n')),
      ...findOkfDocViolations(doc('type: I\nstale_after: "soon"')),
      ...findOkfManifestViolations('- list'),
      ...findOkfManifestViolations('id: x'),
      ...findOkfManifestViolations('okf_version: ""'),
    ].map((v) => v.rule);

    expect(new Set(emitted)).toEqual(new Set(Object.keys(OKF_CONFORMANCE_RULES)));
  });
});

/**
 * Pins the corpus's `dev:pg_query` always-NULL advisory SCOPE claims to the trap
 * table (plan silent-wrong-answers-2026-08-01, P-013 — see the module header for why
 * this exists at code tier rather than as softened prose).
 *
 * Sibling of `gate-candidate-ref.test.ts` / `submodule-blob-containment.test.ts` —
 * same P-004 family, same structure, and the FIXTURE CONTROLS are load-bearing for
 * the same reason: once the live assertion goes green it stops being evidence that
 * the detector works at all. A guard that cannot be shown to FAIL is a guard whose
 * green means nothing, which is this plan's whole subject.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCorpus, SUBJECT_LABEL, ROOT } from './corpus-subject';
import {
  judgePgQueryAdvisoryScope,
  extractTrapRelations,
  CLAIM_RETIRED_MARKER,
  CLAIM_STILL_FIRES_MARKER,
  RETIRED_RELATION,
  COVERED_RELATION,
} from './pg-query-null-advisory-scope';

const PG_READ_QUERY_RELPATH = 'packages/operator-core/lib/pg-read-query.ts';

/**
 * `PAPERCUSP_PG_READ_QUERY_SUBJECT` re-points the code-side subject at another file,
 * mirroring `PAPERCUSP_DOC_CORPUS` on the corpus side and existing for the same
 * documented reason: a falsifiability probe must mutate a COPY outside the tree
 * rather than the tracked artifact, because this shared working tree is swept into a
 * commit every few minutes and an in-tree mutation can be committed by a sweep even
 * when nothing goes wrong (CLAUDE.md's mutation-probe rule, tier 2).
 */
const PG_READ_QUERY_PATH = process.env.PAPERCUSP_PG_READ_QUERY_SUBJECT
  ? resolve(process.env.PAPERCUSP_PG_READ_QUERY_SUBJECT)
  : resolve(ROOT, PG_READ_QUERY_RELPATH);

const readPgReadQuery = (): string => readFileSync(PG_READ_QUERY_PATH, 'utf8');

/** A minimal trap table in the real declaration's shape. */
const trapTable = (relations: readonly string[]): string =>
  [
    'const SILENT_NULL_PATH_TRAPS: SilentNullPathTrap[] = [',
    ...relations.map(
      (r) => `  {\n    relation: '${r}',\n    path: 'kind',\n    why: 'fixture',\n  },`,
    ),
    '];',
    '',
    'export function buildSilentNullPathAdvisory() {}',
  ].join('\n');

/**
 * A fixture corpus that makes BOTH pinned claims, built from the exported markers so
 * it cannot drift from what the judge looks for.
 */
const CONSISTENT_CORPUS = [
  'prelude',
  `  ⚠ \`dev:pg_query\`'s ${CLAIM_RETIRED_MARKER} — the entry was retired with 1096.`,
  `  ${CLAIM_STILL_FIRES_MARKER}.`,
  'postlude',
].join('\n');

describe('pg_query always-NULL advisory scope: corpus prose vs the trap table', () => {
  // ── THE LIVE ASSERTION ────────────────────────────────────────────────────
  it(`the corpus's advisory-scope claims agree with SILENT_NULL_PATH_TRAPS (${SUBJECT_LABEL})`, () => {
    const verdict = judgePgQueryAdvisoryScope({
      corpus: readCorpus(),
      pgReadQuerySource: readPgReadQuery(),
    });

    expect(verdict.violations, verdict.violations.join('\n')).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────
  // Without these, every assertion above passes just as well on an empty corpus or
  // an un-locatable trap table.
  it('actually measured something: the trap table parses and the claims are present', () => {
    const verdict = judgePgQueryAdvisoryScope({
      corpus: readCorpus(),
      pgReadQuerySource: readPgReadQuery(),
    });

    expect(
      verdict.trapRelations.length,
      'SILENT_NULL_PATH_TRAPS yielded no relations — the guard judged nothing',
    ).toBeGreaterThan(0);
    expect(
      verdict.claimsRetired || verdict.claimsStillFires,
      'neither advisory-scope claim was found in the corpus — the pinned prose moved',
    ).toBe(true);
    expect(verdict.trapRelations).toContain(COVERED_RELATION);
    expect(verdict.trapRelations).not.toContain(RETIRED_RELATION);
  });

  // ── CALIBRATION ───────────────────────────────────────────────────────────
  // A correct fixture pair must pass, or the controls below could be firing for a
  // reason unrelated to the property under test.
  it('calibration: a consistent doc/code pair passes', () => {
    const verdict = judgePgQueryAdvisoryScope({
      corpus: CONSISTENT_CORPUS,
      pgReadQuerySource: trapTable([COVERED_RELATION, COVERED_RELATION]),
    });

    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  // ── FIXTURE CONTROLS (the falsifiability evidence) ────────────────────────
  it('CONTROL: re-adding an engineer_issues trap contradicts the "no longer covers" claim', () => {
    const verdict = judgePgQueryAdvisoryScope({
      corpus: CONSISTENT_CORPUS,
      pgReadQuerySource: trapTable([COVERED_RELATION, RETIRED_RELATION]),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join('\n')).toContain(RETIRED_RELATION);
  });

  it('CONTROL: deleting the last work_items trap contradicts the "still fires" claim', () => {
    const verdict = judgePgQueryAdvisoryScope({
      corpus: CONSISTENT_CORPUS,
      // A table that no longer covers work_items at all.
      pgReadQuerySource: trapTable(['some_other_relation']),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join('\n')).toContain(COVERED_RELATION);
  });

  it('CONTROL: an un-locatable trap table fails LOUDLY rather than reading as "no traps"', () => {
    const verdict = judgePgQueryAdvisoryScope({
      corpus: CONSISTENT_CORPUS,
      pgReadQuerySource: 'export function buildSilentNullPathAdvisory() {}\n',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join('\n')).toContain('judged against NOTHING');
  });

  it('CONTROL: corpus prose reworded away fails LOUDLY rather than passing silently', () => {
    const verdict = judgePgQueryAdvisoryScope({
      corpus: 'the advisory situation has changed somewhat, see elsewhere',
      pgReadQuerySource: trapTable([COVERED_RELATION]),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join('\n')).toContain('neither advisory-scope claim');
  });

  // ── The parser's own property ─────────────────────────────────────────────
  it('extractTrapRelations reads relations in declaration order and ignores prose', () => {
    const source = [
      '// relation: not_a_real_trap appears in a comment above the table',
      trapTable(['work_items', 'engineer_issues']),
    ].join('\n');

    // The comment sits OUTSIDE the sliced table, so it must not be picked up.
    expect(extractTrapRelations(source)).toEqual(['work_items', 'engineer_issues']);
    expect(extractTrapRelations('no table here')).toEqual([]);
  });

  it('the markers this guard pins are non-trivial substrings', () => {
    // A marker short enough to match incidentally would make the guard vacuous in a
    // way the non-vacuity floor could not detect.
    expect(CLAIM_RETIRED_MARKER.length).toBeGreaterThan(20);
    expect(CLAIM_STILL_FIRES_MARKER.length).toBeGreaterThan(20);
  });
});

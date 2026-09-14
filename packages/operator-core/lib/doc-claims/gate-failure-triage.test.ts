/**
 * Pins the projected "Gate failure triage" rule to the test-file router behavior it
 * describes. The rule crossed the Postgres/file boundary as an untracked CLAUDE.md
 * edit during WI-40395; projection currentness caught the carrier drift, but without
 * this test a later router change could leave the recovered prose confidently stale.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCorpus, ROOT } from './corpus-subject';
import {
  collectionAttributionMarker,
  evaluateMatch,
  formatProvenanceBanner,
  // The production entrypoint deliberately stays executable by plain Node, so the .mjs script has
  // no declaration file. On a MULTI-LINE import the diagnostic lands on the `from` line, not the
  // `import` line, so the suppression must be the LAST comment line immediately above it — the
  // same placement the sibling test-file-provenance.test.ts documents.
  // @ts-expect-error
} from '../../../../scripts/test-files.mjs';

const HEADING = '## Gate failure triage — re-run named files individually';
const ROUTER = join(ROOT, 'scripts/test-files.mjs');

function section(text: string): string {
  const start = text.indexOf(`${HEADING}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + HEADING.length + 1);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function claimViolations(body: string): string[] {
  const required: Array<[string, RegExp]> = [
    ['gate verdict candidate marker', /`GATE_HELD_BY`/],
    ['failing-file candidate marker', /`AFFECTED_TESTS_FAILING_FILES`/],
    ['route-error marker', /`TEST_FILE_ROUTE_ERROR`/],
    ['zero-match state', /`matched=0`/],
    ['zero-match disposition', /\*\*undetermined\*\*/],
    ['per-file recheck', /each path in its own invocation/],
    // EI-19385411226259421 — the MIRROR direction. Every other clause above guards against
    // over-claiming a RED; these three guard the far more expensive under-claim, where a green
    // riding on a peer's uncommitted fix is recorded as "the verdict was stale" and the reader
    // stops looking. The prose must keep naming the router marker that answers it, or the rule
    // degrades into advice with no instrument behind it.
    ['false-stale caveat', /PASS at tip is NOT proof/],
    ['provenance banner marker', /`TEST_FILE_PROVENANCE/],
    ['submodule gitlink blindness', /gitlink/],
  ];
  return required.filter(([, pattern]) => !pattern.test(body)).map(([label]) => label);
}

describe('doc corpus gate-failure triage claim', () => {
  describe('fixture controls', () => {
    it('fires when a plausible-looking rule omits the zero-match disposition', () => {
      const incomplete = [
        '`GATE_HELD_BY` and `AFFECTED_TESTS_FAILING_FILES` name candidates.',
        'Re-run each path in its own invocation.',
        '`TEST_FILE_ROUTE_ERROR` may report `matched=0`.',
      ].join('\n');
      expect(claimViolations(incomplete)).toContain('zero-match disposition');
    });

    it('fires when the rule covers only the over-claim direction', () => {
      // The exact shape of the pre-EI-19385411226259421 section: complete, careful, and silent on
      // the direction that makes a reader STOP looking. A control that only tested the missing
      // zero-match clause would have passed on this body.
      const oneDirectionOnly = [
        '`GATE_HELD_BY` and `AFFECTED_TESTS_FAILING_FILES` name candidates.',
        'Re-run each path in its own invocation.',
        '`TEST_FILE_ROUTE_ERROR` with `matched=0` is **undetermined**.',
      ].join('\n');
      expect(claimViolations(oneDirectionOnly)).toEqual([
        'false-stale caveat',
        'provenance banner marker',
        'submodule gitlink blindness',
      ]);
    });

    it('stays clean on the complete contract shape', () => {
      const complete = [
        '`GATE_HELD_BY` and `AFFECTED_TESTS_FAILING_FILES` name candidates.',
        'Re-run each path in its own invocation.',
        '`TEST_FILE_ROUTE_ERROR` with `matched=0` is **undetermined**.',
        'A PASS at tip is NOT proof the verdict was stale — read `TEST_FILE_PROVENANCE`.',
        'From the superproject a submodule path answers about the gitlink.',
      ].join('\n');
      expect(claimViolations(complete)).toEqual([]);
    });
  });

  describe('live prose and writer', () => {
    const body = section(readCorpus());
    const source = readFileSync(ROUTER, 'utf8');

    it('positive controls: reads the full corpus section and the real router', () => {
      expect(body.length).toBeGreaterThan(500);
      expect(source.split('\n').length).toBeGreaterThan(1_000);
      expect(source).toContain('export function evaluateMatch');
    });

    it('keeps every load-bearing clause in the projected rule', () => {
      expect(claimViolations(body)).toEqual([]);
    });

    it('the router refuses zero matches as unmeasured', () => {
      const routes = [
        { absolute: '/repo/a.test.ts', requested: 'a.test.ts' },
        { absolute: '/repo/b.test.ts', requested: 'b.test.ts' },
      ];
      const verdict = evaluateMatch({ routes, matched: [], listStatus: 1 });
      expect(verdict).toMatchObject({ ok: false, requested: 2, matched: 0 });
      expect(verdict.unmatched).toEqual(routes);
    });

    it('the router really emits the banner the false-stale rule sends readers to', () => {
      // The rule's whole weight rests on "the router stamps this for you". If the marker, the
      // per-path DIRTY label, or the submodule probe form is ever renamed, the prose becomes a
      // pointer to nothing — advice with no instrument — which is worse than no rule at all.
      const banner = formatProvenanceBanner(
        {
          head: 'a452179fbf',
          entries: [
            {
              absolute: '/repo/papercusp-desktop/test/x.test.js',
              path: 'papercusp-desktop/test/x.test.js',
              state: 'dirty',
              added: 4,
              deleted: 1,
              repoPath: 'papercusp-desktop',
              repoRelativePath: 'test/x.test.js',
            },
          ],
        },
        'post-run',
      );
      expect(banner).toContain('TEST_FILE_PROVENANCE');
      expect(banner).toContain('uncommitted=1');
      expect(banner).toContain('[DIRTY +4/-1');
      expect(banner).toContain('git -C papercusp-desktop show');
      expect(banner).toContain('gitlink');
    });

    it('the multi-file fallback re-lists individually and clears healthy files by name', () => {
      // Pin the I/O seam as well as the pure marker: a refactor that stops performing
      // the per-file `vitest list` calls must not leave the prose claiming it does. Match
      // syntax, not the formatter's quote style: the old exact string pin went red when
      // Prettier changed this .mjs file from single to double quotes without changing behavior.
      expect(source).toContain('const perFile = [];');
      expect(source).toContain('for (const route of group.routes) {');
      expect(source).toMatch(
        /\[\s*['"]vitest['"]\s*,\s*['"]list['"]\s*,\s*['"]--filesOnly['"]\s*,\s*\.\.\.configArgs\s*,\s*route\.requested\s*\]/,
      );
      expect(source).toContain('const attributionMarker = collectionAttributionMarker({');

      const marker = collectionAttributionMarker({
        cwd: ROOT,
        groupRequested: 2,
        groupMatched: 0,
        perFile: [
          { requested: 'healthy.test.ts', ok: true },
          { requested: 'broken.test.ts', ok: false },
        ],
      });
      expect(marker).toContain('✗ BROKEN  broken.test.ts');
      expect(marker).toContain('✓ ok      healthy.test.ts');
      expect(marker).toContain('NOT the cause');
      expect(marker).toContain('Treat only the BROKEN file(s) as suspect');
    });
  });
});

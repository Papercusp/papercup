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
// The production entrypoint deliberately stays executable by plain Node.
// @ts-expect-error — .mjs script, no type declarations by design.
import { collectionAttributionMarker, evaluateMatch } from '../../../../scripts/test-files.mjs';

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

    it('stays clean on the complete contract shape', () => {
      const complete = [
        '`GATE_HELD_BY` and `AFFECTED_TESTS_FAILING_FILES` name candidates.',
        'Re-run each path in its own invocation.',
        '`TEST_FILE_ROUTE_ERROR` with `matched=0` is **undetermined**.',
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

    it('the multi-file fallback re-lists individually and clears healthy files by name', () => {
      // Pin the I/O seam as well as the pure marker: a refactor that stops performing
      // the per-file `vitest list` calls must not leave the prose claiming it does.
      expect(source).toContain('const perFile = group.routes.map((route) => {');
      expect(source).toContain("['vitest', 'list', '--filesOnly', ...configArgs, route.requested]");
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

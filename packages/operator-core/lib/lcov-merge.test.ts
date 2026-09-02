/**
 * lcov-merge.test.ts — P-009 part (b), plan design-to-code-coverage-seam-2026-09-02.
 *
 * `scripts/lib/lcov-merge.ts` re-anchors and merges the per-workspace lcov files a
 * `--coverage` run produces. Two things about it can be wrong in ways nothing else
 * would notice, and both are load-bearing for the patch gate downstream:
 *
 *   1. PATH ANCHORING. Vitest's v8 provider writes `SF:` RELATIVE TO THE VITEST
 *      ROOT — measured 2026-09-02 by running `npx vitest run --coverage
 *      src/mock-sql.test.ts` in libs/test-config, which emitted
 *      `SF:src/console-noise-filter.ts`. Concatenating two workspaces' reports
 *      therefore collides `src/index.ts` across packages and matches nothing a
 *      `git diff` names, so the patch gate would report every changed file as
 *      "no coverage data" — an UNDETERMINED verdict caused purely by the merge.
 *
 *   2. DUPLICATE FILES. A shared lib exercised by two workspaces appears in both
 *      reports. Overwriting rather than summing DISCARDS real coverage and turns a
 *      covered line into an uncovered one — a false RED in the gate.
 *
 * The fixtures below are hand-written rather than generated so each asserts one
 * shape, and the anchoring fixture reproduces the exact relative form measured above.
 */
import { describe, it, expect } from 'vitest';
import {
  formatLcov,
  indexBySourceFile,
  mergeLcovSources,
  normalizeSourcePath,
  parseLcov,
} from '../../../scripts/lib/lcov-merge.ts';

const REPO_ROOT = '/repo';

/** The shape vitest actually emits: workspace-relative SF, one function, three lines. */
const WS_A_LCOV = [
  'TN:',
  'SF:src/alpha.ts',
  'FN:3,doAlpha',
  'FNDA:2,doAlpha',
  'FNF:1',
  'FNH:1',
  'DA:4,2',
  'DA:5,0',
  'DA:9,1',
  'LF:3',
  'LH:2',
  'end_of_record',
].join('\n');

/** A second workspace that ALSO exercises the shared file below. */
const WS_B_LCOV = [
  'TN:',
  'SF:src/beta.ts',
  'DA:1,7',
  'LF:1',
  'LH:1',
  'end_of_record',
  'TN:',
  'SF:../shared/lib/util.ts',
  'DA:10,0',
  'DA:11,3',
  'LF:2',
  'LH:1',
  'end_of_record',
].join('\n');

const WS_C_LCOV = [
  'TN:',
  'SF:../shared/lib/util.ts',
  'DA:10,4',
  'DA:11,0',
  'LF:2',
  'LH:1',
  'end_of_record',
].join('\n');

describe('normalizeSourcePath', () => {
  it('anchors a workspace-relative SF to the repo root', () => {
    expect(
      normalizeSourcePath('src/console-noise-filter.ts', {
        workspaceDir: '/repo/libs/test-config',
        repoRoot: REPO_ROOT,
      }),
    ).toBe('libs/test-config/src/console-noise-filter.ts');
  });

  it('anchors an ABSOLUTE SF the same way (a differently rooted config emits these)', () => {
    expect(
      normalizeSourcePath('/repo/packages/operator-core/lib/x.ts', {
        workspaceDir: '/repo/packages/operator-core',
        repoRoot: REPO_ROOT,
      }),
    ).toBe('packages/operator-core/lib/x.ts');
  });

  it('accepts a workspaceDir given relative to the repo root', () => {
    expect(
      normalizeSourcePath('src/a.ts', { workspaceDir: 'libs/flags', repoRoot: REPO_ROOT }),
    ).toBe('libs/flags/src/a.ts');
  });

  it('returns null for a file OUTSIDE the repo rather than emitting a `..` path', () => {
    // A `../../..`-escaping path in the merged report would be unmatchable by any
    // git diff entry and would read as "changed file with no coverage" downstream.
    expect(
      normalizeSourcePath('/elsewhere/node_modules/dep/index.js', {
        workspaceDir: '/repo/apps/operator',
        repoRoot: REPO_ROOT,
      }),
    ).toBeNull();
  });
});

describe('parseLcov', () => {
  it('reads DA / FN / FNDA into maps and ignores derived counters', () => {
    const [record] = parseLcov(WS_A_LCOV);
    expect(record.sourceFile).toBe('src/alpha.ts');
    expect(record.lines.get(4)).toBe(2);
    expect(record.lines.get(5)).toBe(0);
    expect(record.functions.get('doAlpha')).toEqual({ line: 3, hits: 2 });
  });

  it('drops the optional DA checksum instead of choking on it', () => {
    const [record] = parseLcov('SF:a.ts\nDA:1,4,abc123\nend_of_record\n');
    expect(record.lines.get(1)).toBe(4);
  });

  it('reads a function name containing a comma', () => {
    const [record] = parseLcov('SF:a.ts\nFN:1,fn<A,B>\nFNDA:5,fn<A,B>\nend_of_record\n');
    expect(record.functions.get('fn<A,B>')).toEqual({ line: 1, hits: 5 });
  });

  it('carries BRDA, mapping the never-evaluated `-` to 0', () => {
    const [record] = parseLcov('SF:a.ts\nBRDA:7,0,0,3\nBRDA:7,0,1,-\nend_of_record\n');
    expect(record.branches.get('7:0:0')?.taken).toBe(3);
    expect(record.branches.get('7:0:1')?.taken).toBe(0);
  });

  it('closes an open record when a second SF arrives without end_of_record', () => {
    // Otherwise a truncated report silently folds one file's lines into another's.
    const records = parseLcov('SF:a.ts\nDA:1,1\nSF:b.ts\nDA:2,2\nend_of_record\n');
    expect(records.map((r) => r.sourceFile)).toEqual(['a.ts', 'b.ts']);
    expect(records[0].lines.has(2)).toBe(false);
  });
});

describe('mergeLcovSources', () => {
  const merged = () =>
    mergeLcovSources(
      [
        { workspaceDir: '/repo/packages/a', text: WS_A_LCOV },
        { workspaceDir: '/repo/packages/b', text: WS_B_LCOV },
        { workspaceDir: '/repo/packages/c', text: WS_C_LCOV },
      ],
      { repoRoot: REPO_ROOT },
    );

  it('anchors every record to a distinct repo-root-relative path', () => {
    const { records } = merged();
    expect(records.map((r) => r.sourceFile)).toEqual([
      'packages/a/src/alpha.ts',
      'packages/b/src/beta.ts',
      'packages/shared/lib/util.ts',
    ]);
  });

  it('SUMS a file two workspaces both covered rather than overwriting it', () => {
    // b covers line 11 and misses 10; c covers 10 and misses 11. Overwriting would
    // leave one of them at 0 hits — a covered line reported as uncovered.
    const util = indexBySourceFile(merged().records).get('packages/shared/lib/util.ts');
    expect(util?.lines.get(10)).toBe(4);
    expect(util?.lines.get(11)).toBe(3);
  });

  it('reports records dropped for resolving outside the repo (never silently)', () => {
    const { records, stats } = mergeLcovSources(
      [
        {
          workspaceDir: '/repo/packages/a',
          text: 'SF:/elsewhere/dep.js\nDA:1,1\nend_of_record\n',
        },
      ],
      { repoRoot: REPO_ROOT },
    );
    expect(records).toHaveLength(0);
    expect(stats.recordsRead).toBe(1);
    expect(stats.droppedOutsideRepo).toEqual(['/elsewhere/dep.js']);
  });

  it('returns records sorted by path, so two runs produce a diffable artifact', () => {
    const paths = merged().records.map((r) => r.sourceFile);
    expect([...paths].sort()).toEqual(paths);
  });
});

describe('formatLcov', () => {
  it('RECOMPUTES the summary counters instead of carrying merged ones', () => {
    // Summing LF/LH across two overlapping records double-counts the file; the
    // counters are derived from DA, so they are derived here too.
    const { records } = mergeLcovSources(
      [
        { workspaceDir: '/repo/packages/b', text: WS_B_LCOV },
        { workspaceDir: '/repo/packages/c', text: WS_C_LCOV },
      ],
      { repoRoot: REPO_ROOT },
    );
    const text = formatLcov(records);
    const util = text.slice(text.indexOf('SF:packages/shared/lib/util.ts'));
    expect(util).toContain('LF:2');
    expect(util).toContain('LH:2'); // both lines covered once the two runs are summed
  });

  it('round-trips: parsing its own output reproduces the same line hits', () => {
    const { records } = mergeLcovSources(
      [{ workspaceDir: '/repo/packages/a', text: WS_A_LCOV }],
      { repoRoot: REPO_ROOT },
    );
    const reparsed = indexBySourceFile(parseLcov(formatLcov(records)));
    const alpha = reparsed.get('packages/a/src/alpha.ts');
    expect(alpha?.lines.get(4)).toBe(2);
    expect(alpha?.lines.get(5)).toBe(0);
    expect(alpha?.functions.get('doAlpha')).toEqual({ line: 3, hits: 2 });
  });

  it('emits nothing at all for zero records (never a header-only fake report)', () => {
    expect(formatLcov([])).toBe('');
  });
});

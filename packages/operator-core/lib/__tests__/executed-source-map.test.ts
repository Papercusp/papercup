import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EXECUTED_MAP_ENV,
  EXECUTED_MAP_RECORD_ENV,
  EXECUTED_MAP_WORKSPACE_ENV,
  executedMapEnabled,
  executedMapRecordingEnabled,
  formatExecutedMapLine,
  gitChangedBetween,
  loadExecutedSourceMap,
  resolveExecutedMapPgUrl,
  rowsToExecutedMap,
} from '../../../../scripts/lib/executed-source-map.mjs';

/**
 * Runner side of the executed-source map (gate-latency-selection-and-retry-policy-2026-09-06,
 * P-002). The pruning RULE is pinned in related-tests-selection.test.ts; this file pins the
 * plumbing that feeds it — row → map re-anchoring, the git drift seam, the env toggles, the
 * database precedence — and the two places scripts/affected-tests.mjs has to wire it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = '/repo';

describe('rowsToExecutedMap', () => {
  it('re-anchors repo-relative rows to absolute paths and keeps the first (newest) row per file', () => {
    const map = rowsToExecutedMap(
      [
        { test_file: 'pkg/a.test.ts', recorded_sha: 'new', executed_modules: ['pkg/a.test.ts', 'pkg/x.ts'] },
        { test_file: 'pkg/a.test.ts', recorded_sha: 'old', executed_modules: ['pkg/a.test.ts', 'pkg/y.ts'] },
        { test_file: 'pkg/b.test.ts', recorded_sha: 'new', executed_modules: ['pkg/b.test.ts'] },
      ],
      { repoRoot: ROOT },
    );
    expect([...map.keys()]).toEqual(['/repo/pkg/a.test.ts', '/repo/pkg/b.test.ts']);
    const a = map.get('/repo/pkg/a.test.ts')!;
    expect(a.recordedSha).toBe('new');
    expect([...a.executed]).toEqual(['/repo/pkg/a.test.ts', '/repo/pkg/x.ts']);
  });

  it('drops malformed rows instead of producing an entry the selector could prune on', () => {
    const map = rowsToExecutedMap(
      [
        { test_file: 'pkg/empty.test.ts', recorded_sha: 'sha', executed_modules: [] },
        { test_file: 'pkg/null.test.ts', recorded_sha: 'sha', executed_modules: null },
        { test_file: 'pkg/nosha.test.ts', recorded_sha: undefined as unknown as string, executed_modules: ['x'] },
        { test_file: 'pkg/blank.test.ts', recorded_sha: 'sha', executed_modules: ['', 'pkg/blank.test.ts'] },
      ],
      { repoRoot: ROOT },
    );
    expect([...map.keys()]).toEqual(['/repo/pkg/blank.test.ts']);
    expect([...map.get('/repo/pkg/blank.test.ts')!.executed]).toEqual(['/repo/pkg/blank.test.ts']);
    expect(rowsToExecutedMap(undefined as never, { repoRoot: ROOT }).size).toBe(0);
  });
});

describe('loadExecutedSourceMap', () => {
  it('asks for the newest row per test file in ONE workspace and returns the re-anchored map', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return {
          rows: [{ test_file: 'w/t.test.ts', recorded_sha: 'abc', executed_modules: ['w/t.test.ts', 'w/s.ts'] }],
        };
      },
    };
    const { map, rows } = await loadExecutedSourceMap({ client, workspaceName: '@x/w', repoRoot: ROOT });
    expect(rows).toBe(1);
    expect(map.get('/repo/w/t.test.ts')?.recordedSha).toBe('abc');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(['@x/w']);
    expect(calls[0]!.text).toMatch(/DISTINCT ON \(test_file\)/);
    expect(calls[0]!.text).toMatch(/harness_shared\.test_executed_sources/);
    expect(calls[0]!.text).toMatch(/ORDER BY test_file, recorded_at DESC/);
  });
});

describe('gitChangedBetween', () => {
  it('runs `git diff --name-only <from> <to>` in the repo root and re-anchors the names', () => {
    const argv: string[][] = [];
    const seam = gitChangedBetween({
      repoRoot: ROOT,
      exec: (file, args) => {
        argv.push([file, ...args]);
        return 'pkg/a.ts\n\npkg/b.ts \n';
      },
    });
    const drift = seam('aaa', 'bbb');
    expect(drift).toEqual(new Set(['/repo/pkg/a.ts', '/repo/pkg/b.ts']));
    expect(argv).toEqual([['git', 'diff', '--name-only', 'aaa', 'bbb']]);
  });

  it('answers null (cannot tell) when git refuses the pair, and caches per pair', () => {
    let calls = 0;
    const seam = gitChangedBetween({
      repoRoot: ROOT,
      exec: () => {
        calls += 1;
        throw new Error('fatal: bad object');
      },
    });
    expect(seam('gone', 'head')).toBeNull();
    expect(seam('gone', 'head')).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('env toggles + database precedence', () => {
  it('pruning and recording are ON by default and only an explicit off value disables them', () => {
    expect(executedMapEnabled({})).toBe(true);
    expect(executedMapRecordingEnabled({})).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
      expect(executedMapEnabled({ [EXECUTED_MAP_ENV]: off })).toBe(false);
      expect(executedMapRecordingEnabled({ [EXECUTED_MAP_RECORD_ENV]: off })).toBe(false);
    }
    expect(executedMapEnabled({ [EXECUTED_MAP_ENV]: '1' })).toBe(true);
  });

  it('reads the map from the SAME database the recording reporter writes to', () => {
    expect(resolveExecutedMapPgUrl({ HARNESS_ADMIN_DATABASE_URL: 'postgresql://a', PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://b' })).toEqual({
      url: 'postgresql://a',
      source: 'HARNESS_ADMIN_DATABASE_URL',
    });
    expect(resolveExecutedMapPgUrl({ PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://b' })).toEqual({
      url: 'postgresql://b',
      source: 'PAPERCUSP_TEST_RUNS_DB_URL',
    });
    const dflt = resolveExecutedMapPgUrl({});
    expect(dflt.source).toBe('default');
    // Pinned against the reporter's own fallback so the two sides cannot drift apart silently.
    const reporter = readFileSync(join(REPO_ROOT, 'libs/test-config/src/admin-test-runs-reporter.ts'), 'utf8');
    expect(reporter).toContain(`'${dflt.url}'`);
  });
});

describe('formatExecutedMapLine', () => {
  it('names every rail, so a selection that did not narrow is never silent about why', () => {
    const line = formatExecutedMapLine(
      '@x/w',
      {
        applied: true,
        reason: null,
        entries: 10,
        pruned: 3,
        prunable: 3,
        wouldEmpty: false,
        kept: { changedTest: 1, unresolved: 0, noEntry: 2, untrusted: 0, unknownDrift: 1, stale: 4, intersects: 5 },
      },
      12,
    );
    expect(line).toMatch(/^EXECUTED_SOURCE_MAP ws=@x\/w applied=true reason=ok rows=12 entries=10 pruned=3 prunable=3 wouldEmpty=false /);
    for (const k of ['keptChangedTest=1', 'keptNoEntry=2', 'keptUnknownDrift=1', 'keptStale=4', 'keptIntersects=5']) {
      expect(line).toContain(k);
    }
    expect(formatExecutedMapLine('@x/w', undefined, 0)).toContain('applied=false reason=no-summary');
  });
});

describe('scripts/affected-tests.mjs wiring (source pins)', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');

  it('feeds the selector the map, the judged sha and the drift seam', () => {
    expect(source).toMatch(/selectRelatedTests\(\{[\s\S]*?executedMap: executedMap\.map,[\s\S]*?judgedSha: executedMapContext\.judgedSha,[\s\S]*?changedBetween: executedMapContext\.changedBetween,/);
  });

  it('stamps the reporter arming env on unit vitest tasks only, and prints one line per workspace', () => {
    expect(source).toMatch(
      /\(spawnTask\.script === "test" \|\| LANE_SCRIPTS\.includes\(spawnTask\.script\)\)\s*\?\s*\{ \[EXECUTED_MAP_WORKSPACE_ENV\]: spawnTask\.ws\.name \}/,
    );
    // The constant the runner stamps IS the env the reporter arms on (vitest-config.ts).
    expect(EXECUTED_MAP_WORKSPACE_ENV).toBe('PC_EXECUTED_SOURCE_MAP_WORKSPACE');
    expect(readFileSync(join(REPO_ROOT, 'libs/test-config/src/vitest-config.ts'), 'utf8')).toContain(
      `PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV = '${EXECUTED_MAP_WORKSPACE_ENV}'`,
    );
    expect(source).toContain('formatExecutedMapLine(t.ws.name, result.executedMap, executedMap.rows)');
  });

  it('is fail-open: no database, no sha, a slow read — each is a reason string, never a thrown selection', () => {
    expect(source).toMatch(/inert\(`pg-unavailable\(/);
    expect(source).toMatch(/inert\("no-judged-sha"\)/);
    expect(source).toMatch(/executed-map read timed out/);
    expect(source).toMatch(/executedMapContext\.client\.end\(\)/);
  });
});

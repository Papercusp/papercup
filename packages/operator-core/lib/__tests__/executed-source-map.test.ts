import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EXECUTED_MAP_ENV,
  EXECUTED_MAP_NO_PERSIST_ENV,
  EXECUTED_MAP_RECORD_ENV,
  EXECUTED_MAP_RESULT_ENV,
  EXECUTED_MAP_WORKSPACE_ENV,
  executedMapEnabled,
  executedMapRecordingEnabled,
  formatExecutedMapLine,
  gitChangedBetween,
  loadExecutedSourceMap,
  loadPassDurations,
  loadReuseProofs,
  resolveExecutedMapPgUrl,
  rowsToExecutedMap,
  rowsToReuseProofs,
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
  const O1 = '1'.repeat(40);
  const O2 = '2'.repeat(40);
  const Z = '0'.repeat(40);
  const rawEntry = (m1: string, m2: string, o1: string, o2: string, st: string, p: string) =>
    `:${m1} ${m2} ${o1} ${o2} ${st}\0${p}\0`;

  it('runs a raw -z diff in the repo root and re-anchors the names', () => {
    const argv: Array<{ cwd: string; args: string[] }> = [];
    const seam = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, args, opts) => {
        argv.push({ cwd: (opts as { cwd: string }).cwd, args });
        return (
          rawEntry('100644', '100644', O1, O2, 'M', 'pkg/a.ts') +
          rawEntry('000000', '100644', Z, O2, 'A', 'pkg/b.ts')
        );
      },
    });
    expect(seam('aaa', 'bbb')).toEqual(new Set(['/repo/pkg/a.ts', '/repo/pkg/b.ts']));
    expect(argv).toEqual([
      { cwd: ROOT, args: ['diff', '--raw', '--no-renames', '--abbrev=40', '-z', 'aaa', 'bbb'] },
    ]);
  });

  // gate-file-level-test-reuse-2026-09-27 D-003: a plain superproject diff names a submodule
  // change only as the gitlink path, which no executed module ever equals, so the stale check
  // was blind to every change inside the ~38 submodules.
  it('recurses into a moved gitlink and names the files changed INSIDE the submodule', () => {
    const calls: string[] = [];
    const seam = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, args, opts) => {
        const cwd = (opts as { cwd: string }).cwd;
        calls.push(`${cwd} ${args.slice(-2).join('..')}`);
        if (cwd === ROOT) return rawEntry('160000', '160000', O1, O2, 'M', 'libs/sub');
        if (cwd === '/repo/libs/sub') return rawEntry('100644', '100644', O1, O2, 'M', 'src/x.ts');
        throw new Error(`unexpected cwd ${cwd}`);
      },
    });
    expect(seam('aaa', 'bbb')).toEqual(new Set(['/repo/libs/sub', '/repo/libs/sub/src/x.ts']));
    expect(calls).toEqual([`${ROOT} aaa..bbb`, `/repo/libs/sub ${O1}..${O2}`]);
  });

  it('answers null (cannot tell) for an added submodule or an undiffable pinned commit', () => {
    const added = gitChangedBetween({
      repoRoot: ROOT,
      exec: () => rawEntry('000000', '160000', Z, O2, 'A', 'libs/new-sub'),
    });
    expect(added('aaa', 'bbb')).toBeNull();
    const missingPin = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, _args, opts) => {
        if ((opts as { cwd: string }).cwd === ROOT) return rawEntry('160000', '160000', O1, O2, 'M', 'libs/sub');
        throw new Error('fatal: bad object');
      },
    });
    expect(missingPin('aaa', 'bbb')).toBeNull();
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
      /const recordsExecutedMap =\s*executedMapRecordingEnabled\(\) &&\s*\(spawnTask\.script === "test" \|\| LANE_SCRIPTS\.includes\(spawnTask\.script\)\);/,
    );
    expect(source).toMatch(/\.\.\.\(recordsExecutedMap \? \{ \[EXECUTED_MAP_WORKSPACE_ENV\]: spawnTask\.ws\.name \} : \{\}\)/);
    // WI-10003603: the result channel — same env name on both sides, and the runner reads it back,
    // prints each task's outcome and a per-invocation total the gate parses.
    expect(EXECUTED_MAP_RESULT_ENV).toBe('PC_EXECUTED_SOURCE_MAP_RESULT');
    expect(readFileSync(join(REPO_ROOT, 'libs/test-config/src/vitest-config.ts'), 'utf8')).toContain(
      `PC_EXECUTED_SOURCE_MAP_RESULT_ENV = '${EXECUTED_MAP_RESULT_ENV}'`,
    );
    expect(source).toMatch(/\.\.\.\(executedMapResultFile \? \{ \[EXECUTED_MAP_RESULT_ENV\]: executedMapResultFile \} : \{\}\)/);
    expect(source).toContain('formatExecutedMapResultLines(label, read)');
    expect(source).toContain('outSync(formatExecutedMapTotalLine(summarizeExecutedMapResults(executedMapReads)))');
    // The constant the runner stamps IS the env the reporter arms on (vitest-config.ts).
    expect(EXECUTED_MAP_WORKSPACE_ENV).toBe('PC_EXECUTED_SOURCE_MAP_WORKSPACE');
    expect(readFileSync(join(REPO_ROOT, 'libs/test-config/src/vitest-config.ts'), 'utf8')).toContain(
      `PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV = '${EXECUTED_MAP_WORKSPACE_ENV}'`,
    );
    expect(source).toContain('formatExecutedMapLine(t.ws.name, result.executedMap, executedMap.rows)');
    // EI-24542010215430349: the gate's rescue reruns arm no-persist through this constant.
    expect(EXECUTED_MAP_NO_PERSIST_ENV).toBe('PC_EXECUTED_SOURCE_MAP_NO_PERSIST');
    expect(readFileSync(join(REPO_ROOT, 'libs/test-config/src/vitest-config.ts'), 'utf8')).toContain(
      `PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV = '${EXECUTED_MAP_NO_PERSIST_ENV}'`,
    );
  });

  it('is fail-open: no database, no sha, a slow read — each is a reason string, never a thrown selection', () => {
    expect(source).toMatch(/inert\(`pg-unavailable\(/);
    expect(source).toMatch(/inert\("no-judged-sha"\)/);
    expect(source).toMatch(/executed-map read timed out/);
    expect(source).toMatch(/executedMapContext\.client\.end\(\)/);
  });
});

// gate-file-level-test-reuse-2026-09-27 P-008: the pass-proof loader feeding selectReusablePasses.
describe('reuse proofs loader', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    test_file: 'pkg/a.test.ts',
    recorded_sha: 'sha1',
    recorded_at: new Date('2026-09-27T10:00:00Z'),
    executed_modules: ['pkg/a.test.ts', 'pkg/a.ts'],
    read_paths: ['pkg/fixtures/'],
    inputs_captured: true,
    opaque_reasons: [],
    run_context: 'green-checkpoint',
    runner_identity: 'v25.9.0 linux x64',
    ...over,
  });

  it('keys proofs repo-relative, newest-first wins, and maps every column', () => {
    const proofs = rowsToReuseProofs([row(), row({ recorded_sha: 'older' }), row({ test_file: 'pkg/b.test.ts', recorded_at: '2026-09-27T09:00:00Z' })]);
    expect([...proofs.keys()]).toEqual(['pkg/a.test.ts', 'pkg/b.test.ts']);
    expect(proofs.get('pkg/a.test.ts')).toEqual({
      recordedSha: 'sha1',
      recordedAtMs: Date.parse('2026-09-27T10:00:00Z'),
      executedModules: ['pkg/a.test.ts', 'pkg/a.ts'],
      readPaths: ['pkg/fixtures/'],
      inputsCaptured: true,
      opaqueReasons: [],
      runContext: 'green-checkpoint',
      runnerIdentity: 'v25.9.0 linux x64',
    });
    expect(proofs.get('pkg/b.test.ts')?.recordedAtMs).toBe(Date.parse('2026-09-27T09:00:00Z'));
  });

  it('degrades unreadable columns toward "not reusable", never toward a valid proof', () => {
    const p = rowsToReuseProofs([
      row({ inputs_captured: null, read_paths: null, opaque_reasons: 'x', run_context: null, recorded_at: 'garbage' }),
      { test_file: 7, recorded_sha: 'x' },
    ]).get('pkg/a.test.ts');
    expect(p?.inputsCaptured).toBe(false);
    expect(p?.readPaths).toEqual([]);
    expect(p?.runContext).toBeNull();
    expect(Number.isNaN(p?.recordedAtMs)).toBe(true);
  });

  it('queries ONE workspace and ONE run context, newest row per file', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [row()] };
      },
    };
    const out = await loadReuseProofs({ client, workspaceName: '@papercusp/x', runContext: 'green-checkpoint' });
    expect(out.rows).toBe(1);
    expect(out.proofs.has('pkg/a.test.ts')).toBe(true);
    expect(calls[0]?.values).toEqual(['@papercusp/x', 'green-checkpoint']);
    expect(calls[0]?.text).toMatch(/DISTINCT ON \(test_file\)/);
    expect(calls[0]?.text).toMatch(/run_context = \$2/);
    expect(calls[0]?.text).toMatch(/ORDER BY test_file, recorded_at DESC/);
  });

  it('loadPassDurations reads the newest CI PASS per file, and drops unusable durations (P-013)', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return {
          rows: [
            { file_path: 'pkg/a.test.ts', duration_ms: 1200 },
            { file_path: 'pkg/b.test.ts', duration_ms: '35' },
            { file_path: 'pkg/c.test.ts', duration_ms: null },
            { file_path: 'pkg/d.test.ts', duration_ms: -4 },
            { file_path: 'pkg/e.test.ts', duration_ms: 'nope' },
          ],
        };
      },
    };
    const out = await loadPassDurations({ client, files: ['pkg/a.test.ts', 'pkg/b.test.ts'] });
    expect([...out]).toEqual([
      ['pkg/a.test.ts', 1200],
      ['pkg/b.test.ts', 35],
    ]);
    expect(calls[0]?.values).toEqual([['pkg/a.test.ts', 'pkg/b.test.ts']]);
    // CI rows only: `test_runs` mixes local/admin-ui/mutation-probe rows, and statuses are
    // 'pass'/'fail' (never 'passed'), so a wrong literal would silently match nothing.
    expect(calls[0]?.text).toMatch(/source = 'ci' AND status = 'pass'/);
    expect(calls[0]?.text).toMatch(/DISTINCT ON \(file_path\)/);
    expect(calls[0]?.text).toMatch(/ORDER BY file_path, finished_at DESC/);
  });

  it('loadPassDurations does not query for an empty skip list', async () => {
    let queried = false;
    const client = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    };
    expect((await loadPassDurations({ client, files: [] })).size).toBe(0);
    expect(queried).toBe(false);
  });

  it('gitChangedBetween({ relative: true }) returns repo-relative drift', () => {
    const exec = () => ':100644 100644 aaaa bbbb M\0pkg/a.ts\0:100644 100644 cccc dddd M\0lib/b.ts\0';
    const rel = gitChangedBetween({ repoRoot: '/repo', exec, relative: true })('x', 'y');
    expect(rel ? [...rel].sort() : rel).toEqual(['lib/b.ts', 'pkg/a.ts']);
    const abs = gitChangedBetween({ repoRoot: '/repo', exec })('x', 'y');
    expect(abs ? [...abs].sort() : abs).toEqual(['/repo/lib/b.ts', '/repo/pkg/a.ts']);
  });
});

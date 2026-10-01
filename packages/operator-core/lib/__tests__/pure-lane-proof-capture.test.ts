import { describe, expect, it } from 'vitest';

import {
  PURE_PROOF_CAPTURE_BUDGET_MS_DEFAULT,
  PURE_PROOF_CAPTURE_SLICE_DEFAULT,
  buildCaptureEnv,
  buildCaptureVitestArgs,
  decideNextSlice,
  orderCaptureCandidates,
  pureProofCaptureBudgetMs,
  pureProofCaptureEnabled,
  pureProofCaptureSliceSize,
  repoRelativeLaneFiles,
  runPureLaneProofCapture,
} from '../../../../scripts/lib/pure-lane-proof-capture.mjs';

/**
 * gate-test-reuse-yield-2026-10-01 P-006 part 1 (Decision D-005 §1): the post-verdict phase that
 * re-runs pure-lane files ISOLATED so the recorder writes the proofs the pure lane (isolate:false)
 * never records. The rails under test: never capture over a failure at the sha, never re-capture a
 * file already proven at it, order the useful files first, stop before the budget or the next gate
 * fire, and skip (never throw) whenever the checkout or database cannot support a proof.
 */

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW = Date.parse('2026-10-01T12:00:00Z');
const HOUR = 3600_000;
const MAX_AGE = 24 * HOUR;
const RUNNER = 'p1 v25.9.0 linux x64';
const WS = 'packages/operator-core';
const rr = (f: string) => `${WS}/${f}`;

const proof = (sha: string, ageMs: number, runnerIdentity: string | null = RUNNER) => ({
  recordedSha: sha,
  recordedAtMs: NOW - ageMs,
  runnerIdentity,
});

describe('env switches', () => {
  it('is ON by default and off only for an explicit off value', () => {
    expect(pureProofCaptureEnabled({})).toBe(true);
    expect(pureProofCaptureEnabled({ PC_PURE_PROOF_CAPTURE: '1' })).toBe(true);
    for (const off of ['0', 'false', 'OFF', ' no ']) {
      expect(pureProofCaptureEnabled({ PC_PURE_PROOF_CAPTURE: off })).toBe(false);
    }
  });

  it('reads budget and slice size, falling back on anything that is not a positive integer', () => {
    expect(pureProofCaptureBudgetMs({})).toBe(PURE_PROOF_CAPTURE_BUDGET_MS_DEFAULT);
    expect(pureProofCaptureBudgetMs({ PC_PURE_PROOF_CAPTURE_BUDGET_MS: '60000' })).toBe(60000);
    expect(pureProofCaptureBudgetMs({ PC_PURE_PROOF_CAPTURE_BUDGET_MS: '-5' })).toBe(PURE_PROOF_CAPTURE_BUDGET_MS_DEFAULT);
    expect(pureProofCaptureSliceSize({})).toBe(PURE_PROOF_CAPTURE_SLICE_DEFAULT);
    expect(pureProofCaptureSliceSize({ PC_PURE_PROOF_CAPTURE_SLICE: '2' })).toBe(2);
    expect(pureProofCaptureSliceSize({ PC_PURE_PROOF_CAPTURE_SLICE: 'x' })).toBe(PURE_PROOF_CAPTURE_SLICE_DEFAULT);
  });
});

describe('orderCaptureCandidates', () => {
  const base = {
    sha: SHA,
    nowMs: NOW,
    maxAgeMs: MAX_AGE,
    runnerIdentity: RUNNER,
    failedAtSha: new Set<string>(),
    passedInSuite: new Set<string>(),
  };

  it('excludes files that failed at the sha and files already proven at it', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['f.test.ts', 'p.test.ts', 'n.test.ts'],
      failedAtSha: new Set(['f.test.ts']),
      proofs: new Map([['p.test.ts', proof(SHA, HOUR)]]),
    });
    expect(r.order).toEqual(['n.test.ts']);
    expect(r.excluded).toEqual({ failed: 1, proven: 1 });
  });

  it('a failure at the sha wins even over a fresh proof at the same sha (never capture over a failure)', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['x.test.ts'],
      failedAtSha: new Set(['x.test.ts']),
      proofs: new Map([['x.test.ts', proof(SHA, HOUR)]]),
    });
    expect(r.order).toEqual([]);
    expect(r.excluded).toEqual({ failed: 1, proven: 0 });
  });

  it('orders ran-and-passed first, then unproven, then refresh oldest-first; by path within a tier', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['z-ran.test.ts', 'a-ran.test.ts', 'm-none.test.ts', 'b-none.test.ts', 'r-new.test.ts', 'r-old.test.ts'],
      passedInSuite: new Set(['z-ran.test.ts', 'a-ran.test.ts']),
      proofs: new Map([
        ['z-ran.test.ts', proof(OLD, 2 * HOUR)],
        ['r-new.test.ts', proof(OLD, 2 * HOUR)],
        ['r-old.test.ts', proof(OLD, 20 * HOUR)],
      ]),
    });
    expect(r.order).toEqual([
      'a-ran.test.ts',
      'z-ran.test.ts',
      'b-none.test.ts',
      'm-none.test.ts',
      'r-old.test.ts',
      'r-new.test.ts',
    ]);
    expect(r.tiers).toEqual({ ranPassed: 2, unproven: 2, refresh: 2 });
  });

  it('treats an expired proof, an unreadable timestamp or another runner identity as no proof', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['expired.test.ts', 'nan.test.ts', 'other-node.test.ts', 'other-node-at-sha.test.ts'],
      proofs: new Map([
        ['expired.test.ts', proof(OLD, MAX_AGE + 1)],
        ['nan.test.ts', { recordedSha: OLD, recordedAtMs: Number.NaN, runnerIdentity: RUNNER }],
        ['other-node.test.ts', proof(OLD, HOUR, 'p1 v24.0.0 linux x64')],
        ['other-node-at-sha.test.ts', proof(SHA, HOUR, 'p1 v24.0.0 linux x64')],
      ]),
    });
    expect(r.tiers).toEqual({ ranPassed: 0, unproven: 4, refresh: 0 });
    expect(r.excluded.proven).toBe(0);
  });

  it('de-duplicates the lane list', () => {
    const r = orderCaptureCandidates({ ...base, laneFiles: ['a.test.ts', 'a.test.ts'], proofs: new Map() });
    expect(r.order).toEqual(['a.test.ts']);
  });
});

describe('decideNextSlice', () => {
  const at = { startedAtMs: NOW, budgetMs: 15 * 60_000, estimateMs: 60_000 };

  it('goes when the slice fits the budget and ends before the next-fire margin', () => {
    expect(decideNextSlice({ ...at, nowMs: NOW, nextFireAtMs: NOW + 10 * 60_000 })).toEqual({ go: true, reason: null });
  });

  it('stops on the budget', () => {
    expect(decideNextSlice({ ...at, nowMs: NOW + 14.5 * 60_000, nextFireAtMs: null })).toEqual({ go: false, reason: 'budget' });
  });

  it('stops when the slice would end inside the 2-minute margin of the next fire, or the fire is overdue', () => {
    expect(decideNextSlice({ ...at, nowMs: NOW, nextFireAtMs: NOW + 2.5 * 60_000 })).toEqual({ go: false, reason: 'next-fire' });
    expect(decideNextSlice({ ...at, nowMs: NOW, nextFireAtMs: NOW - 1 })).toEqual({ go: false, reason: 'next-fire' });
  });

  it('an unknown next fire leaves only the budget', () => {
    expect(decideNextSlice({ ...at, nowMs: NOW, nextFireAtMs: null })).toEqual({ go: true, reason: null });
  });
});

describe('argv and env', () => {
  it('names every file and refuses a zero-file pass', () => {
    expect(buildCaptureVitestArgs(['lib/a.test.ts', 'lib/b.test.ts'])).toEqual([
      'run',
      '--no-passWithNoTests',
      'lib/a.test.ts',
      'lib/b.test.ts',
    ]);
    expect(() => buildCaptureVitestArgs([])).toThrow(/empty slice/);
  });

  it('runs the isolated default config with recording armed and rows marked local, without mutating the input', () => {
    const input = {
      GREEN_CHECKPOINT: '1',
      PC_TEST_LANE: 'pure',
      PC_TEST_REUSE_SKIP_LIST: '/tmp/skip.json',
      PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
      PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/out.json',
      PAPERCUSP_TEST_RUN_SOURCE: 'ci',
      PAPERCUSP_TEST_RUN_GROUP: 'suite-run',
      VITEST_MAX_WORKERS: '6',
    };
    const env = buildCaptureEnv(input, { resultFile: '/tmp/r.jsonl', runGroupId: 'run-1:pure-proof-capture', sha: SHA });
    expect(env.PC_TEST_LANE).toBeUndefined();
    expect(env.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
    expect(env.PC_EXECUTED_SOURCE_MAP_NO_PERSIST).toBeUndefined();
    expect(env.PC_EXECUTED_SOURCE_MAP_OUT).toBeUndefined();
    expect(env.PC_EXECUTED_SOURCE_MAP_WORKSPACE).toBe('@papercusp/operator-core');
    expect(env.PC_EXECUTED_SOURCE_MAP_RESULT).toBe('/tmp/r.jsonl');
    expect(env.PAPERCUSP_TEST_RUN_SOURCE).toBe('local');
    expect(env.PAPERCUSP_TEST_RUN_GROUP).toBe('run-1:pure-proof-capture');
    expect(env.PAPERCUSP_TEST_RUN_COMMIT).toBe(SHA);
    expect(env.GREEN_CHECKPOINT).toBe('1');
    expect(env.VITEST_MAX_WORKERS).toBe('6');
    expect(input.PC_TEST_LANE).toBe('pure');
    expect(input.PAPERCUSP_TEST_RUN_SOURCE).toBe('ci');
  });

  it('maps workspace-relative and absolute include entries to repo-relative paths', () => {
    expect(repoRelativeLaneFiles('/r', '/r/packages/operator-core', ['lib/a.test.ts', '/r/packages/operator-core/lib/b.test.ts'])).toEqual([
      'packages/operator-core/lib/a.test.ts',
      'packages/operator-core/lib/b.test.ts',
    ]);
  });
});

type Slice = { args: string[]; env: Record<string, string | undefined>; cwd: string; timeoutMs: number };

function harness(over: Record<string, unknown> = {}) {
  const clock = { now: NOW };
  const slices: Slice[] = [];
  const logs: string[] = [];
  const removed: string[] = [];
  const lane = ['lib/a.test.ts', 'lib/b.test.ts', 'lib/c.test.ts', 'lib/d.test.ts', 'lib/e.test.ts'];
  const deps = {
    git: (_root: string, args: string[]) => (args[0] === 'rev-parse' ? `${SHA}\n` : args[0] === 'status' ? '' : null),
    laneInclude: () => lane,
    runnerIdentity: () => RUNNER,
    connect: async () => ({ end: async () => {} }),
    loadShaOutcomes: async () => ({
      failed: new Set([rr('lib/e.test.ts')]),
      passedInSuite: new Set([rr('lib/c.test.ts'), rr('lib/d.test.ts')]),
      ranInSuite: 5,
    }),
    loadProofs: async () => ({ proofs: new Map([[rr('lib/a.test.ts'), proof(SHA, HOUR)]]), rows: 1 }),
    loadSliceFailures: async ({ files }: { files: string[] }) => files.filter((f) => f === rr('lib/d.test.ts')),
    readResults: () => ({
      status: 'ok',
      results: [{ outcome: 'persisted', rows: 2, retired: 1, skipped: 0, dirty: false, sha: SHA }],
      malformed: 0,
    }),
    runSlice: async (s: Slice) => {
      slices.push(s);
      clock.now += 30_000;
      return { code: 0, signal: null, timedOut: false, spawnError: null };
    },
    readNextFireAtMs: async (): Promise<number | null> => null,
    now: () => clock.now,
    makeTempDir: () => '/tmp/capture-test',
    removeTempDir: (dir: string) => removed.push(dir),
    log: (line: string) => logs.push(line),
    ...over,
  };
  const env = { GREEN_CHECKPOINT: '1', PC_PURE_PROOF_CAPTURE_SLICE: '2' } as Record<string, string | undefined>;
  return { deps, env, slices, logs, removed, clock };
}

const run = (h: ReturnType<typeof harness>, env = h.env) =>
  runPureLaneProofCapture({ root: '/r', env, runGroupId: 'run-1:pure-proof-capture', deps: h.deps as never });

describe('runPureLaneProofCapture', () => {
  it('captures the ordered candidates in slices, isolated, and reports what was recorded', async () => {
    const h = harness();
    const r = await run(h);
    // a: proven at the sha; e: failed at the sha. c, d ran-and-passed (tier i), then b (unproven).
    expect(h.slices.map((s) => s.args)).toEqual([
      ['run', '--no-passWithNoTests', 'lib/c.test.ts', 'lib/d.test.ts'],
      ['run', '--no-passWithNoTests', 'lib/b.test.ts'],
    ]);
    expect(h.slices[0].cwd).toBe('/r/packages/operator-core');
    expect(h.slices[0].env.PAPERCUSP_TEST_RUN_SOURCE).toBe('local');
    expect(h.slices[0].env.PC_TEST_LANE).toBeUndefined();
    expect(h.slices[0].env.PC_EXECUTED_SOURCE_MAP_RESULT).toBe('/tmp/capture-test/executed-map-result-1.jsonl');
    expect(r).toMatchObject({
      state: 'done',
      sha: SHA,
      slices: 2,
      files: 3,
      rows: 4,
      retired: 2,
      failed: 1,
      isolatedFail: 1,
      remaining: 0,
      stoppedBy: 'complete',
    });
    expect(h.logs).toContain(`PURE_PROOF_CAPTURE_ISOLATED_FAIL file=${rr('lib/d.test.ts')} sha=${SHA.slice(0, 12)}`);
    expect(h.logs.some((l) => l.startsWith('PURE_PROOF_CAPTURE state=planned') && l.includes('excludedFailed=1 excludedProven=1'))).toBe(true);
    expect(h.logs.some((l) => l.startsWith('PURE_PROOF_CAPTURE_EXECUTED_SOURCE_MAP_RESULT task=pure-proof-capture#1'))).toBe(true);
    expect(h.removed).toEqual(['/tmp/capture-test']);
  });

  it('skips without touching git when switched off', async () => {
    let gitCalls = 0;
    const h = harness({ git: () => ((gitCalls += 1), null) });
    const r = await run(h, { ...h.env, PC_PURE_PROOF_CAPTURE: '0' });
    expect(r).toMatchObject({ state: 'skipped', reason: 'disabled-by-env' });
    expect(gitCalls).toBe(0);
  });

  it('skips outside the gate run context and when recording is off', async () => {
    const h = harness();
    expect((await run(h, { PC_PURE_PROOF_CAPTURE_SLICE: '2' })).reason).toBe('not-gate-context');
    expect((await run(h, { ...h.env, AFFECTED_RECORD_EXECUTED_SOURCES: '0' })).reason).toBe('recording-disabled');
    expect(h.slices).toHaveLength(0);
  });

  it('skips a dirty or sha-less checkout', async () => {
    const dirty = harness({ git: (_r: string, a: string[]) => (a[0] === 'rev-parse' ? SHA : ' M lib/x.ts\n') });
    expect((await run(dirty)).reason).toBe('dirty-checkout(1)');
    const noSha = harness({ git: () => null });
    expect((await run(noSha)).reason).toBe('no-judged-sha');
    expect(dirty.slices.length + noSha.slices.length).toBe(0);
  });

  it('skips when the suite never ran the pure lane at this sha', async () => {
    const h = harness({ loadShaOutcomes: async () => ({ failed: new Set(), passedInSuite: new Set(), ranInSuite: 0 }) });
    expect(await run(h)).toMatchObject({ state: 'skipped', reason: 'pure-lane-not-run-at-sha' });
    expect(h.slices).toHaveLength(0);
  });

  it('skips when the database is unavailable, and never throws', async () => {
    const h = harness({
      connect: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const r = await run(h);
    expect(r.state).toBe('skipped');
    expect(r.reason).toMatch(/^pg-unavailable\(connect_ECONNREFUSED\)$/);
  });

  it('stops before a slice that would exceed the budget', async () => {
    const h = harness();
    // Slice estimate is 2 files × 250ms = 0.5s; a 30s slice then raises it to 15s/file → 30s.
    const r = await run(h, { ...h.env, PC_PURE_PROOF_CAPTURE_BUDGET_MS: '40000' });
    expect(r).toMatchObject({ slices: 1, files: 2, remaining: 1, stoppedBy: 'budget' });
  });

  it('stops before running into the next scheduled gate fire', async () => {
    const h = harness();
    h.deps.readNextFireAtMs = async () => h.clock.now + 60_000;
    expect(await run(h)).toMatchObject({ slices: 0, remaining: 3, stoppedBy: 'next-fire' });
  });

  it('stops if the checkout moved off the judged sha between slices', async () => {
    let revParses = 0;
    const h = harness({
      git: (_r: string, a: string[]) => {
        if (a[0] === 'status') return '';
        revParses += 1;
        return revParses <= 2 ? SHA : OLD;
      },
    });
    expect(await run(h)).toMatchObject({ slices: 1, stoppedBy: `head-moved(${OLD.slice(0, 12)})` });
  });

  it('stops after a slice that timed out', async () => {
    const h = harness({ runSlice: async () => ({ code: 1, signal: null, timedOut: true, spawnError: null }) });
    expect(await run(h)).toMatchObject({ slices: 1, remaining: 1, stoppedBy: 'slice-timeout' });
  });

  it('reports nothing to capture when every candidate is already proven or failed', async () => {
    const h = harness({ laneInclude: () => ['lib/a.test.ts', 'lib/e.test.ts'] });
    expect(await run(h)).toMatchObject({ state: 'done', slices: 0, stoppedBy: 'nothing-to-capture' });
    expect(h.slices).toHaveLength(0);
  });
});

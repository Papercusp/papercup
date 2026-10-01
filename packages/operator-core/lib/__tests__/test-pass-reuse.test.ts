import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyLanes, isUnitTestFile } from '@papercusp/test-config/lane-split';

import {
  auditDraw,
  estimateReuseSavings,
  formatReuseAlarmLine,
  formatTestReuseLine,
  formatTestReuseTotalLine,
  isGlobalRunnerInput,
  laneOfFromSplit,
  laneOfTaskScript,
  laneScopedCandidates,
  REUSE_SKIP_LIST_SCHEMA,
  reuseCandidates,
  reuseSoundnessAlarms,
  selectReusablePasses,
  testReuseAuditRate,
  testReuseEnabled,
  testReuseMaxAgeMs,
  TEST_REUSE_AUDIT_RATE_DEFAULT,
  TEST_REUSE_MAX_AGE_MS_DEFAULT,
  writeReuseSkipList,
} from '../../../../scripts/lib/test-pass-reuse.mjs';
import {
  decideReuseSkip,
  parseReuseSkipList,
  REUSE_SKIP_LIST_SCHEMA as READER_SCHEMA,
} from '@papercusp/test-config/test-pass-reuse-skip';

/**
 * gate-file-level-test-reuse-2026-09-27 P-008 / D-004: a selected test file is SKIPPED only
 * when its recorded pass proof is still valid at the judged sha. Every other case must RUN it.
 */

const NOW = Date.parse('2026-09-27T16:00:00Z');
const CTX = 'green-checkpoint';
const RUNNER = 'v25.9.0 linux x64';

type Proof = Parameters<typeof selectReusablePasses>[0]['proofs'] extends Map<string, infer P> ? P : never;

function proof(file: string, over: Partial<Proof> = {}): Proof {
  return {
    recordedSha: 'old',
    recordedAtMs: NOW - 3600_000,
    executedModules: [file, 'pkg/src/a.ts', 'libs/sub/src/b.ts'],
    readPaths: ['pkg/fixtures/data.json', 'sql/'],
    inputsCaptured: true,
    opaqueReasons: [],
    runContext: CTX,
    runnerIdentity: RUNNER,
    ...over,
  };
}

function run(files: string[], proofs: Map<string, Proof>, drift: Set<string> | null) {
  return selectReusablePasses({
    candidates: files,
    proofs,
    judgedSha: 'new',
    changedBetween: () => drift,
    runContext: CTX,
    runnerIdentity: RUNNER,
    nowMs: NOW,
    maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
  });
}

const T = 'pkg/src/a.test.ts';

describe('selectReusablePasses', () => {
  it('reuses a valid proof when nothing it depends on drifted', () => {
    const r = run([T], new Map([[T, proof(T)]]), new Set(['other/unrelated.ts']));
    expect(r.skip).toEqual([T]);
    expect(r.summary.reused).toBe(1);
  });

  it('runs the file when the test file, an executed module or a submodule module changed', () => {
    for (const changed of [T, 'pkg/src/a.ts', 'libs/sub/src/b.ts']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
      expect(r.summary.inputChanged, changed).toBe(1);
    }
  });

  it('runs the file when a runtime-read file or anything under a read directory changed', () => {
    for (const changed of ['pkg/fixtures/data.json', 'sql/1236-new.sql', 'sql']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
    }
  });

  it('runs the file when a package.json or tsconfig above an executed module changed', () => {
    for (const changed of ['pkg/package.json', 'pkg/tsconfig.json', 'libs/sub/package.json', 'libs/tsconfig.base.json']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
    }
    // ...but a sibling package's manifest does not touch this proof.
    const r = run([T], new Map([[T, proof(T)]]), new Set(['other-pkg/package.json']));
    expect(r.skip).toEqual([T]);
  });

  it('invalidates every proof on a global runner input change', () => {
    for (const changed of ['package-lock.json', 'package.json', 'libs/test-config/src/vitest-config.ts', 'patches/x.patch']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
      expect(r.summary.globalInput, changed).toBe(1);
    }
  });

  it('runs on unknown drift, missing, foreign, expired, uncaptured or opaque proofs', () => {
    expect(run([T], new Map([[T, proof(T)]]), null).summary.unknownDrift).toBe(1);
    expect(run([T], new Map(), new Set()).summary.noProof).toBe(1);
    expect(run([T], new Map([[T, proof(T, { executedModules: ['pkg/src/a.ts'] })]]), new Set()).summary.noProof).toBe(1);
    expect(run([T], new Map([[T, proof(T, { runContext: 'clean-local' })]]), new Set()).summary.otherContext).toBe(1);
    expect(run([T], new Map([[T, proof(T, { runnerIdentity: 'v22.0.0 linux x64' })]]), new Set()).summary.otherRunner).toBe(1);
    expect(run([T], new Map([[T, proof(T, { recordedAtMs: NOW - 25 * 3600_000 })]]), new Set()).summary.expired).toBe(1);
    expect(run([T], new Map([[T, proof(T, { inputsCaptured: false })]]), new Set()).summary.notCaptured).toBe(1);
    expect(run([T], new Map([[T, proof(T, { opaqueReasons: ['child-process'] })]]), new Set()).summary.opaque).toBe(1);
  });

  it('treats a proof recorded at the judged sha as zero drift without calling git', () => {
    let calls = 0;
    const r = selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, proof(T, { recordedSha: 'new' })]]),
      judgedSha: 'new',
      changedBetween: () => {
        calls += 1;
        return null;
      },
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
    });
    expect(r.skip).toEqual([T]);
    expect(calls).toBe(0);
  });

  it('reads a throwing drift seam as unknown (runs the file)', () => {
    const r = selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, proof(T)]]),
      judgedSha: 'new',
      changedBetween: () => {
        throw new Error('boom');
      },
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
    });
    expect(r.skip).toEqual([]);
    expect(r.summary.unknownDrift).toBe(1);
  });
});

describe('isGlobalRunnerInput', () => {
  it('treats libs/test-config TEST files as ordinary tests, not runner inputs', () => {
    expect(isGlobalRunnerInput('libs/test-config/src/pg-container.test.ts')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/pg-container.ts')).toBe(true);
    expect(isGlobalRunnerInput('packages/operator-core/package.json')).toBe(false);
    expect(isGlobalRunnerInput('packages/operator-core/vitest.config.ts')).toBe(true);
  });

  // WI-10003752: replayed from real commits (592850d, ff4e267, e1cb05e) — each discarded every
  // pass proof fleet-wide while changing nothing any other workspace's runner reads.
  it('ignores test-config fixtures and swept non-source temps, but not real runner sources', () => {
    expect(isGlobalRunnerInput('libs/test-config/src/__fixtures__/armed-capture/sample.txt')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/__fixtures__/armed-capture/nested/x.ts')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/vitest-config.test.ts.tmp.4121.a1b2c3')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/vitest-config.ts.tmp')).toBe(false);
    // The calibration half: every real runner source still invalidates (a rule that excluded
    // these would pass the lines above vacuously).
    expect(isGlobalRunnerInput('libs/test-config/src/vitest-config.ts')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/src/executed-source-map-reporter.ts')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/src/setup.mjs')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/src/quarantine.json')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/package.json')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/tsconfig.json')).toBe(true);
  });
});

describe('env toggles and the report line', () => {
  it('is ON by default and OFF for the documented values', () => {
    expect(testReuseEnabled({})).toBe(true);
    for (const v of ['0', 'false', 'off', 'no']) expect(testReuseEnabled({ AFFECTED_TEST_REUSE: v })).toBe(false);
    expect(testReuseMaxAgeMs({})).toBe(TEST_REUSE_MAX_AGE_MS_DEFAULT);
    expect(testReuseMaxAgeMs({ AFFECTED_TEST_REUSE_MAX_AGE_HOURS: '6' })).toBe(6 * 3600_000);
  });

  it('prints every counter on one greppable line', () => {
    const r = run([T], new Map([[T, proof(T)]]), new Set());
    const line = formatTestReuseLine('@papercusp/x', r.summary);
    expect(line).toMatch(/^TEST_PASS_REUSE ws=@papercusp\/x candidates=1 reused=1 /);
    expect(line).toMatch(/ audited=0 expiredClean=0$/);
  });

  it('reads the P-012 audit rate: 5% by default, clamped to [0,1], garbage falls back', () => {
    expect(TEST_REUSE_AUDIT_RATE_DEFAULT).toBe(0.05);
    expect(testReuseAuditRate({})).toBe(0.05);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: ' ' })).toBe(0.05);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: '0' })).toBe(0);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: '0.2' })).toBe(0.2);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: '7' })).toBe(1);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: '-1' })).toBe(0);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: 'lots' })).toBe(0.05);
  });
});

/**
 * P-012 soundness backstop. Every proof expires after maxAgeMs (so every file re-runs at least
 * that often), a deterministic sample of reusable files runs anyway, and a failure among the files
 * reuse WOULD have skipped is an alarm.
 */
describe('P-012 audit sample and expired-clean watch', () => {
  const runWith = (
    files: string[],
    proofs: Map<string, Proof>,
    drift: Set<string> | null,
    over: { auditRate?: number; changedBetween?: () => Set<string> | null } = {},
  ) =>
    selectReusablePasses({
      candidates: files,
      proofs,
      judgedSha: 'new',
      changedBetween: over.changedBetween ?? (() => drift),
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
      auditRate: over.auditRate,
    });

  it('auditDraw is deterministic per (file, sha), in [0,1), and rotates with the sha', () => {
    expect(auditDraw(T, 'sha1')).toBe(auditDraw(T, 'sha1'));
    const draws = Array.from({ length: 50 }, (_, i) => auditDraw(T, `sha${i}`));
    for (const d of draws) expect(d >= 0 && d < 1).toBe(true);
    expect(new Set(draws).size).toBe(50);
  });

  it('samples roughly auditRate of the reusable files', () => {
    const files = Array.from({ length: 2000 }, (_, i) => `pkg/src/f${i}.test.ts`);
    const proofs = new Map(files.map((f) => [f, proof(f)]));
    const r = runWith(files, proofs, new Set(), { auditRate: 0.05 });
    expect(r.summary.audited + r.summary.reused).toBe(2000);
    expect(r.summary.audited).toBeGreaterThan(60);
    expect(r.summary.audited).toBeLessThan(140);
    expect(r.watch.size).toBe(r.summary.audited);
    for (const [f, why] of r.watch) {
      expect(why).toBe('audit');
      expect(r.skip).not.toContain(f);
    }
  });

  it('an audited file RUNS (not skipped) and is watched', () => {
    const r = runWith([T], new Map([[T, proof(T)]]), new Set(), { auditRate: 1 });
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ reused: 0, audited: 1 });
    expect([...r.watch]).toEqual([[T, 'audit']]);
  });

  it('auditRate 0 (the pure-rule default) audits nothing', () => {
    const r = runWith([T], new Map([[T, proof(T)]]), new Set());
    expect(r.skip).toEqual([T]);
    expect(r.watch.size).toBe(0);
  });

  it('a recently-expired proof that is otherwise clean RUNS and is watched as expired-clean', () => {
    const r = runWith([T], new Map([[T, proof(T, { recordedAtMs: NOW - 25 * 3600_000 })]]), new Set(), {
      auditRate: 1,
    });
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ expired: 1, expiredClean: 1, audited: 0, reused: 0 });
    expect([...r.watch]).toEqual([[T, 'expired-clean']]);
  });

  it('a recently-expired proof whose inputs drifted is counted ONLY as expired and not watched', () => {
    const r = runWith([T], new Map([[T, proof(T, { recordedAtMs: NOW - 25 * 3600_000 })]]), new Set(['pkg/src/a.ts']));
    expect(r.summary).toMatchObject({ expired: 1, expiredClean: 0, inputChanged: 0 });
    expect(r.watch.size).toBe(0);
    const nc = runWith([T], new Map([[T, proof(T, { recordedAtMs: NOW - 25 * 3600_000, inputsCaptured: false })]]), new Set());
    expect(nc.summary).toMatchObject({ expired: 1, notCaptured: 0 });
    expect(nc.watch.size).toBe(0);
  });

  it('a proof older than 2x maxAge stops at expiry without diffing its sha', () => {
    let diffs = 0;
    const r = runWith([T], new Map([[T, proof(T, { recordedAtMs: NOW - 49 * 3600_000 })]]), null, {
      changedBetween: () => {
        diffs += 1;
        return new Set();
      },
    });
    expect(diffs).toBe(0);
    expect(r.summary).toMatchObject({ expired: 1, expiredClean: 0 });
    expect(r.watch.size).toBe(0);
  });
});

describe('reuseSoundnessAlarms', () => {
  const watch = new Map<string, 'audit' | 'expired-clean'>([
    ['packages/x/lib/a.test.ts', 'audit'],
    ['packages/x/lib/b.test.ts', 'expired-clean'],
  ]);

  it('maps runner-printed (workspace-relative) failures onto the watched repo-relative files', () => {
    expect(
      reuseSoundnessAlarms({
        failedFiles: ['lib/b.test.ts', './lib/a.test.ts', 'lib/c.test.ts', 'lib/a.test.ts'],
        watch,
        prefix: 'packages/x/',
      }),
    ).toEqual([
      { file: 'packages/x/lib/a.test.ts', reason: 'audit' },
      { file: 'packages/x/lib/b.test.ts', reason: 'expired-clean' },
    ]);
  });

  it('accepts a failure already printed repo-relative', () => {
    expect(reuseSoundnessAlarms({ failedFiles: ['packages/x/lib/a.test.ts'], watch, prefix: 'packages/x/' })).toEqual([
      { file: 'packages/x/lib/a.test.ts', reason: 'audit' },
    ]);
  });

  it('is empty when nothing watched failed, or there is nothing to watch', () => {
    expect(reuseSoundnessAlarms({ failedFiles: ['lib/c.test.ts'], watch, prefix: 'packages/x/' })).toEqual([]);
    expect(reuseSoundnessAlarms({ failedFiles: ['lib/a.test.ts'], watch: new Map(), prefix: 'packages/x/' })).toEqual([]);
    expect(reuseSoundnessAlarms({ failedFiles: ['lib/a.test.ts'], watch: undefined, prefix: 'packages/x/' })).toEqual([]);
    expect(reuseSoundnessAlarms({ failedFiles: null, watch, prefix: 'packages/x/' })).toEqual([]);
  });

  it('estimates the saved test time as a lower bound over measured files (P-013)', () => {
    const durations = new Map([
      ['a', 1000],
      ['b', 250.4],
    ]);
    expect(estimateReuseSavings(['a', 'b', 'c'], durations)).toEqual({ savedMs: 1250, measured: 2, unmeasured: 1 });
    expect(estimateReuseSavings([], durations)).toEqual({ savedMs: 0, measured: 0, unmeasured: 0 });
  });

  it('rolls every armed task into one TOTAL line, and says "unknown" when a duration read failed', () => {
    const s1 = run([T], new Map([[T, proof(T)]]), new Set()).summary;
    const s2 = { ...s1, candidates: 3, reused: 1, audited: 2 };
    expect(formatTestReuseTotalLine({ tasks: 2, summaries: [s1, s2], savedMs: 4200, unmeasured: 1 })).toBe(
      'TEST_PASS_REUSE_TOTAL tasks=2 candidates=4 reused=2 audited=2 expiredClean=0 minSavedTestMs=4200 unmeasured=1',
    );
    expect(formatTestReuseTotalLine({ tasks: 1, summaries: [s1], savedMs: null, unmeasured: 0 })).toMatch(
      / minSavedTestMs=unknown /,
    );
  });

  it('formats one greppable alarm line per file', () => {
    expect(formatReuseAlarmLine('@papercusp/x::test', { file: 'packages/x/lib/a.test.ts', reason: 'audit' })).toMatch(
      /^TEST_PASS_REUSE_ALARM ws=@papercusp\/x::test file=packages\/x\/lib\/a\.test\.ts proof=audit — /,
    );
  });
});

describe('reuseCandidates', () => {
  it('uses a narrowed selection, re-anchored repo-relative', () => {
    expect(
      reuseCandidates({ wsRel: 'packages/x', relatedFiles: ['lib/a.test.ts', './lib/b.test.ts'], proofFiles: [] }),
    ).toEqual(['packages/x/lib/a.test.ts', 'packages/x/lib/b.test.ts']);
  });

  it('falls back to every proof under the workspace for an un-narrowed task', () => {
    const proofFiles = ['packages/x/lib/a.test.ts', 'packages/xy/lib/c.test.ts', 'packages/y/lib/b.test.ts'];
    expect(reuseCandidates({ wsRel: 'packages/x', relatedFiles: undefined, proofFiles })).toEqual([
      'packages/x/lib/a.test.ts',
    ]);
    expect(reuseCandidates({ wsRel: 'packages/x', relatedFiles: [], proofFiles })).toEqual([
      'packages/x/lib/a.test.ts',
    ]);
    // The repo-root workspace owns every path.
    expect(reuseCandidates({ wsRel: '', relatedFiles: null, proofFiles })).toEqual(proofFiles);
  });
});

// WI-10004617: both lane tasks receive the same lane-agnostic selection, so the other lane's
// files were counted as candidates. Pure-lane files never record a proof (isolate:false), which
// made ~1.9k of them read as lane-stateful `noProof` on the 599dbeeb gate run.
describe('lane-scoped reuse candidates (WI-10004617)', () => {
  it('maps only the two lane scripts to a lane', () => {
    expect(laneOfTaskScript('test:lane-pure')).toBe('pure');
    expect(laneOfTaskScript('test:lane-stateful')).toBe('stateful');
    expect(laneOfTaskScript('test')).toBeNull();
    expect(laneOfTaskScript('test:lane-stateful-extra')).toBeNull();
    expect(laneOfTaskScript('test:integration')).toBeNull();
  });

  it("keeps only the task's own lane and counts the rest", () => {
    const lanes: Record<string, 'pure' | 'stateful' | null> = {
      'lib/a.test.ts': 'stateful',
      'lib/b.test.ts': 'pure',
      'lib/c.test.ts': 'pure',
      'lib/d.integration.test.ts': null,
    };
    const candidates = Object.keys(lanes).map((f) => `packages/x/${f}`);
    const laneOf = (rel: string) => lanes[rel] ?? null;
    expect(laneScopedCandidates({ candidates, wsRel: 'packages/x', lane: 'stateful', laneOf })).toEqual({
      candidates: ['packages/x/lib/a.test.ts'],
      otherLane: 3,
    });
    expect(laneScopedCandidates({ candidates, wsRel: 'packages/x', lane: 'pure', laneOf })).toEqual({
      candidates: ['packages/x/lib/b.test.ts', 'packages/x/lib/c.test.ts'],
      otherLane: 2,
    });
  });

  it('leaves an un-split task and out-of-workspace paths untouched', () => {
    const never = () => {
      throw new Error('an un-split task must not classify anything');
    };
    const candidates = ['packages/x/lib/a.test.ts'];
    expect(laneScopedCandidates({ candidates, wsRel: 'packages/x', lane: null, laneOf: never })).toEqual({
      candidates,
      otherLane: 0,
    });
    expect(
      laneScopedCandidates({ candidates: ['packages/y/lib/z.test.ts'], wsRel: 'packages/x', lane: 'stateful', laneOf: () => 'pure' }),
    ).toEqual({ candidates: ['packages/y/lib/z.test.ts'], otherLane: 0 });
  });

  it('classifies with the real lane-split rule the lane configs use', () => {
    const ws = mkdtempSync(join(tmpdir(), 'lane-scoped-reuse-'));
    try {
      mkdirSync(join(ws, 'lib'), { recursive: true });
      // Built by concatenation so THIS file's own lane classification is unchanged.
      const statefulMarker = 'vi.' + 'mock("./dep");';
      writeFileSync(join(ws, 'lib/mocked.test.ts'), `${statefulMarker}\nit("x", () => {});\n`);
      writeFileSync(join(ws, 'lib/plain.test.ts'), 'it("y", () => {});\n');
      writeFileSync(join(ws, 'lib/db.integration.test.ts'), 'it("z", () => {});\n');
      const rels = ['lib/mocked.test.ts', 'lib/plain.test.ts', 'lib/db.integration.test.ts', 'lib/gone.test.ts'];
      const laneOf = laneOfFromSplit({ classifyLanes, isUnitTestFile }, ws, rels);
      expect(laneOf('lib/mocked.test.ts')).toBe('stateful');
      expect(laneOf('lib/plain.test.ts')).toBe('pure');
      // Not a unit test file: no lane task runs it.
      expect(laneOf('lib/db.integration.test.ts')).toBeNull();
      // Unreadable is stateful in lane-split (the safe direction); mirror it.
      expect(laneOf('lib/gone.test.ts')).toBe('stateful');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// P-011: within one gate run, the selective phase (narrowed to the repair radius) and the full
// phase judge the SAME sha. A pass the selective phase recorded is therefore a zero-drift proof
// for the un-narrowed full task, so the full phase skips it instead of re-running it. This pins
// the composition: un-narrowed candidates come from the recorded proofs, and a same-sha proof is
// reused without diffing.
describe('P-011: the full phase reuses passes the selective phase recorded at the same sha', () => {
  it('skips a file the narrowed selective run passed, when the un-narrowed full task judges that sha', () => {
    const passed = 'packages/x/lib/a.test.ts';
    const proofs = new Map([[passed, proof(passed, { recordedSha: 'repair-head' })]]);
    const candidates = reuseCandidates({ wsRel: 'packages/x', relatedFiles: undefined, proofFiles: [...proofs.keys()] });
    const r = selectReusablePasses({
      candidates,
      proofs,
      judgedSha: 'repair-head',
      changedBetween: () => {
        throw new Error('a same-sha proof must not be diffed');
      },
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
    });
    expect(r.skip).toEqual([passed]);
    expect(r.summary.reused).toBe(1);
  });

  it('still runs a file whose selective-phase pass was recorded in a different run context', () => {
    const passed = 'packages/x/lib/a.test.ts';
    const proofs = new Map([[passed, proof(passed, { recordedSha: 'repair-head', runContext: 'clean-local' })]]);
    const r = selectReusablePasses({
      candidates: [passed],
      proofs,
      judgedSha: 'repair-head',
      changedBetween: () => null,
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
    });
    expect(r.skip).toEqual([]);
    expect(r.summary.otherContext).toBe(1);
  });
});

describe('skip-list channel: affected-tests writer -> vitest-config reader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'reuse-skip-'));
    dirs.push(d);
    return d;
  };
  const META = { runContext: CTX, runnerIdentity: RUNNER, judgedSha: 'abc123' };

  it('writes a sorted, de-duplicated, content-addressed list the reader accepts', () => {
    const dir = tmp();
    const a = writeReuseSkipList(dir, { files: ['lib/b.test.ts', 'lib/a.test.ts', 'lib/b.test.ts'], ...META });
    const again = writeReuseSkipList(dir, { files: ['lib/a.test.ts', 'lib/b.test.ts'], ...META });
    const other = writeReuseSkipList(dir, { files: ['lib/a.test.ts'], ...META });
    expect(a.count).toBe(2);
    expect(again.path).toBe(a.path); // same content => same file (EEXIST tolerated)
    expect(other.digest).not.toBe(a.digest);
    const parsed = parseReuseSkipList(readFileSync(a.path, 'utf8'));
    expect(parsed.files).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(parsed).toMatchObject(META);
    expect(REUSE_SKIP_LIST_SCHEMA).toBe(READER_SCHEMA);
  });

  it('applies only in the same run context and runner identity', () => {
    const list = parseReuseSkipList(
      readFileSync(writeReuseSkipList(tmp(), { files: ['lib/a.test.ts'], ...META }).path, 'utf8'),
    );
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: RUNNER })).toEqual({
      applied: true,
      exclude: ['lib/a.test.ts'],
      skipped: 1,
    });
    expect(decideReuseSkip(list, { runContext: 'clean-local', runnerIdentity: RUNNER }).applied).toBe(false);
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: 'v24.0.0 linux x64' }).applied).toBe(false);
  });

  it('escapes glob metacharacters so a route-group or dynamic-segment path excludes only itself', () => {
    // Measured against tinyglobby (vitest's matcher): an UNESCAPED `app/(grp)/[id]/page.test.ts`
    // in `ignore` does not match its own file, so reuse would silently run it; escaped, it
    // excludes exactly that file and not its sibling.
    const list = parseReuseSkipList(
      readFileSync(writeReuseSkipList(tmp(), { files: ['app/(grp)/[id]/page.test.ts'], ...META }).path, 'utf8'),
    );
    const d = decideReuseSkip(list, { runContext: CTX, runnerIdentity: RUNNER });
    expect(d.applied && d.exclude).toEqual(['app/\\(grp\\)/\\[id\\]/page.test.ts']);
  });

  it('refuses a malformed or foreign-schema list (the caller then runs every file)', () => {
    expect(() => parseReuseSkipList('["lib/a.test.ts"]')).toThrow();
    expect(() => parseReuseSkipList(JSON.stringify({ schema: 2, files: [], ...META }))).toThrow();
    expect(() => parseReuseSkipList(JSON.stringify({ schema: 1, files: [''], ...META }))).toThrow();
  });
});

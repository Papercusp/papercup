import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyLanes, isUnitTestFile } from '@papercusp/test-config/lane-split';

// The subject module is overridable (TEST_PASS_REUSE_SUBJECT = an absolute path to a copy) so
// scripts/mutation-probe.sh can run this suite against a frozen historical or mutated snapshot
// without touching the shared tree (WI-10004712). Unset, it is the real module.
type ReuseSubject = typeof import('../../../../scripts/lib/test-pass-reuse.mjs');
const reuseSubjectOverride = process.env.TEST_PASS_REUSE_SUBJECT;
const reuseSubject: ReuseSubject = reuseSubjectOverride
  ? await import(pathToFileURL(reuseSubjectOverride).href)
  : await import('../../../../scripts/lib/test-pass-reuse.mjs');
const {
  auditDraw,
  estimateReuseSavings,
  formatReuseAlarmLine,
  formatTestReuseLine,
  formatTestReuseTotalLine,
  isGlobalRunnerInput,
  isRunnerAffectingScript,
  laneOfFromSplit,
  laneOfTaskScript,
  laneScopedCandidates,
  packageLockChangeIsInert,
  packageLockInstallView,
  REUSE_PROOF_FORMAT,
  REUSE_SKIP_LIST_SCHEMA,
  reuseCandidates,
  reuseRunnerIdentity,
  reuseSoundnessAlarms,
  rootPackageJsonChangeIsInert,
  selectReusablePasses,
  testReuseAuditRate,
  testReuseEnabled,
  testReuseMaxAgeMs,
  TEST_REUSE_AUDIT_RATE_DEFAULT,
  TEST_REUSE_MAX_AGE_MS_DEFAULT,
  writeReuseSkipList,
} = reuseSubject;
import {
  decideReuseSkip,
  executedSourceRunnerIdentity,
  parseReuseSkipList,
  REUSE_PROOF_FORMAT as RECORDER_PROOF_FORMAT,
  REUSE_SKIP_LIST_SCHEMA as READER_SCHEMA,
} from '@papercusp/test-config/test-pass-reuse-skip';
import { gitInertGlobalChange } from '../../../../scripts/lib/executed-source-map.mjs';
import { LANE_SCRIPTS } from '../../../../scripts/lib/targeted-task-reuse.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

describe('P-001 (gate-test-reuse-yield-2026-10-01): nested vitest configs are per-proof inputs', () => {
  const OC_CFG = 'packages/operator-core/vitest.config.ts';
  const SEARCH_CFG = 'libs/generic/search/vitest.config.ts';
  const REPO = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));

  it('keeps ROOT runner configs global and scopes nested ones', () => {
    expect(isGlobalRunnerInput('vitest.config.ts')).toBe(true);
    expect(isGlobalRunnerInput('vitest.workspace.ts')).toBe(true);
    expect(isGlobalRunnerInput(OC_CFG)).toBe(false);
    expect(isGlobalRunnerInput('packages/operator-core/vitest.integration.config.ts')).toBe(false);
  });

  it('a nested config change voids exactly the proofs that recorded that config as an input', () => {
    const ocTest = 'packages/operator-core/lib/x.test.ts';
    const searchTest = 'libs/generic/search/src/y.test.ts';
    const proofs = new Map([
      [ocTest, proof(ocTest, { readPaths: ['pkg/fixtures/data.json', OC_CFG] })],
      [searchTest, proof(searchTest, { readPaths: [SEARCH_CFG] })],
    ]);
    const r = run([ocTest, searchTest], proofs, new Set([SEARCH_CFG]));
    // Before P-001 the search config was global and BOTH ran; the proof that loaded it must still run.
    expect(r.skip).toEqual([ocTest]);
    expect(r.summary.inputChanged).toBe(1);
    expect(r.summary.globalInput).toBe(0);
  });

  it('the proof format rides in the runner identity, identically on the selector and recorder sides', () => {
    expect(REUSE_PROOF_FORMAT).toBe(RECORDER_PROOF_FORMAT);
    expect(reuseRunnerIdentity(' v25.9.0 linux x64\n')).toBe(`${REUSE_PROOF_FORMAT} v25.9.0 linux x64`);
    expect(reuseRunnerIdentity('')).toBeNull();
    expect(reuseRunnerIdentity(null)).toBeNull();
    expect(reuseRunnerIdentity(`${process.version} ${process.platform} ${process.arch}`)).toBe(executedSourceRunnerIdentity());
  });

  it('an older-format proof (no config input recorded) is never judged under the narrowed rule', () => {
    const f = 'packages/operator-core/lib/x.test.ts';
    const r = selectReusablePasses({
      candidates: [f],
      proofs: new Map([[f, proof(f, { runnerIdentity: RUNNER })]]),
      judgedSha: 'new',
      changedBetween: () => new Set([OC_CFG]),
      runContext: CTX,
      runnerIdentity: reuseRunnerIdentity(RUNNER) ?? '',
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
    });
    expect(r.skip).toEqual([]);
    expect(r.summary.otherRunner).toBe(1);
  });

  // Vite records a config's RELATIVE imports in configFileDependencies but externalizes BARE ones,
  // so a proof never sees a bare import. That is sound only while every bare import of a nested
  // config resolves into node_modules (package-lock.json is global) or to libs/test-config (global).
  type SpecClass = 'builtin' | 'relative' | 'test-config' | 'npm' | 'workspace' | 'unresolved';
  function classify(spec: string, fromFile: string): SpecClass {
    if (spec.startsWith('node:') || builtinModules.includes(spec)) return 'builtin';
    if (spec.startsWith('.')) return 'relative';
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    for (let dir = dirname(`${REPO}/${fromFile}`); ; dir = dirname(dir)) {
      const candidate = `${dir}/node_modules/${name}`;
      if (existsSync(candidate)) {
        const real = realpathSync(candidate);
        if (real.split(sep).includes('node_modules')) return 'npm';
        return relative(REPO, real) === 'libs/test-config' ? 'test-config' : 'workspace';
      }
      if (dir === REPO || dir === dirname(dir)) return 'unresolved';
    }
  }

  it('every nested vitest config imports only what a proof or a global rule covers', () => {
    const configs = execFileSync('git', ['ls-files', '--recurse-submodules'], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\n')
      .filter((f) => /\/vitest\.[^/]*config[^/]*\.[cm]?[jt]s$/.test(f) && existsSync(`${REPO}/${f}`));
    const counts: Record<SpecClass, number> = { builtin: 0, relative: 0, 'test-config': 0, npm: 0, workspace: 0, unresolved: 0 };
    const violations: string[] = [];
    const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;
    for (const f of configs) {
      const src = readFileSync(`${REPO}/${f}`, 'utf8');
      for (const m of src.matchAll(SPEC_RE)) {
        const c = classify(m[2], f);
        counts[c] += 1;
        if (c === 'workspace' || c === 'unresolved') violations.push(`${f} imports '${m[2]}' (${c})`);
      }
    }
    // Positive controls: the scan saw the real population, so an empty violation list is not vacuous.
    expect(configs.length).toBeGreaterThanOrEqual(40);
    expect(counts['test-config']).toBeGreaterThanOrEqual(40);
    expect(counts.npm).toBeGreaterThan(0);
    // Negative control: the classifier CAN report a workspace import.
    const otherWorkspace = readdirSync(`${REPO}/node_modules/@papercusp`).find(
      (n) => n !== 'test-config' && !realpathSync(`${REPO}/node_modules/@papercusp/${n}`).split(sep).includes('node_modules'),
    );
    expect(otherWorkspace).toBeDefined();
    expect(classify(`@papercusp/${otherWorkspace}`, 'packages/operator-core/vitest.config.ts')).toBe('workspace');
    expect(violations).toEqual([]);
  });
});

describe('isGlobalRunnerInput', () => {
  it('treats libs/test-config TEST files as ordinary tests, not runner inputs', () => {
    expect(isGlobalRunnerInput('libs/test-config/src/pg-container.test.ts')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/pg-container.ts')).toBe(true);
    expect(isGlobalRunnerInput('packages/operator-core/package.json')).toBe(false);
    // P-001: a nested vitest config is a per-proof input (proof-v2 records it), not global.
    expect(isGlobalRunnerInput('packages/operator-core/vitest.config.ts')).toBe(false);
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

/**
 * gate-test-reuse-yield-2026-10-01 P-002: a root package.json change is global only when something
 * a proof cannot see changed. Measured: 12 of 43 global-touching commits in 72h touched it.
 */
describe('P-002: scripts-only root package.json changes are not global', () => {
  const pkg = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
      devDependencies: { vitest: '4.0.0' },
      scripts: { test: 'node scripts/affected-tests.mjs', 'lint:x': 'node x.mjs', 'gen:y': 'node y.mjs' },
      ...over,
    });

  it('judges only non-runner script edits as inert', () => {
    const base = pkg();
    // Inert: an added, changed or removed non-task script, and pure key reordering.
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: { test: 'node scripts/affected-tests.mjs', 'lint:x': 'node x2.mjs', 'gen:y': 'node y.mjs', 'lint:new': 'z' } }))).toBe(true);
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: { test: 'node scripts/affected-tests.mjs' } }))).toBe(true);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(base) as Record<string, unknown>).reverse()));
    expect(reordered).not.toBe(base);
    expect(rootPackageJsonChangeIsInert(base, reordered)).toBe(true);
    // 'prettier' starts with "pre" but is no task's hook.
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: { ...JSON.parse(base).scripts, prettier: 'prettier .' } }))).toBe(true);
    // Global: any field outside scripts.
    expect(rootPackageJsonChangeIsInert(base, pkg({ devDependencies: { vitest: '4.0.1' } }))).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ workspaces: ['packages/*', 'libs/*'] }))).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ overrides: { esbuild: '0.25.0' } }))).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ type: 'module' }))).toBe(false);
  });

  it('keeps task scripts, their pre/post hooks and install lifecycle scripts global', () => {
    const base = pkg();
    const withScript = (name: string, body: string) =>
      pkg({ scripts: { ...JSON.parse(base).scripts, [name]: body } });
    for (const name of [
      'test', 'test:lane-pure', 'test:lane-stateful', 'test:lane-future', 'test:integration', 'test:el-suite',
      'lint:el-tools', 'pretest', 'posttest', 'pretest:lane-pure', 'posttest:integration',
      'postinstall', 'preinstall', 'install', 'prepare', 'dependencies',
    ]) {
      expect(isRunnerAffectingScript(name), name).toBe(true);
      expect(rootPackageJsonChangeIsInert(base, withScript(name, 'changed')), name).toBe(false);
    }
    for (const name of ['lint:x', 'gen:y', 'test:file', 'test:affected', 'prettier', 'postgres:up']) {
      expect(isRunnerAffectingScript(name), name).toBe(false);
    }
  });

  it('fails closed on anything it cannot parse as two JSON objects with object scripts', () => {
    const base = pkg();
    expect(rootPackageJsonChangeIsInert(base, '{ not json')).toBe(false);
    expect(rootPackageJsonChangeIsInert('[]', '[]')).toBe(false);
    expect(rootPackageJsonChangeIsInert('null', 'null')).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: 'node x.mjs' }))).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: ['a'] }))).toBe(false);
  });

  // The lane list is the gate's task vocabulary (targeted-task-reuse.mjs), and affected-tests
  // pushes further task scripts by literal name. Every one must count as runner-affecting, or a
  // root edit to it would be wrongly judged inert.
  it('covers every task script the gate runs (derived from the runners, not hand-listed)', () => {
    for (const name of LANE_SCRIPTS) expect(isRunnerAffectingScript(name), name).toBe(true);
    const repo = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
    const src = readFileSync(join(repo, 'scripts/affected-tests.mjs'), 'utf8');
    const pushed = [...src.matchAll(/tasks\.push\(\{\s*ws,\s*script:\s*"([^"]+)"\s*\}\)/g)].map((m) => m[1]!);
    // Positive control: the scan must find the known literal pushes, or it is checking nothing.
    expect(pushed).toEqual(expect.arrayContaining(['test', 'lint:el-tools', 'test:integration', 'test:el-suite']));
    for (const name of pushed) expect(isRunnerAffectingScript(name), name).toBe(true);
  });

  function runWithSeam(
    drift: Set<string>,
    inertGlobalChange: ((rel: string, from: string, to: string) => boolean) | null,
    p: Proof = proof(T),
  ) {
    return selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, p]]),
      judgedSha: 'new',
      changedBetween: () => drift,
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
      inertGlobalChange,
    });
  }

  it('reuses a proof across an inert root package.json change and counts it as inertGlobal', () => {
    const asked: string[] = [];
    const r = runWithSeam(new Set(['package.json', 'other/unrelated.ts']), (rel, from, to) => {
      asked.push(`${rel}@${from}..${to}`);
      return true;
    });
    expect(r.skip).toEqual([T]);
    expect(r.summary).toMatchObject({ reused: 1, globalInput: 0, inputChanged: 0, inertGlobal: 1 });
    // Only GLOBAL drift paths are put to the seam, with the proof's recorded sha and the judged sha.
    expect(asked).toEqual(['package.json@old..new']);
  });

  it('still invalidates a proof that read the root package.json itself', () => {
    const p = proof(T, { readPaths: ['package.json'] });
    const r = runWithSeam(new Set(['package.json']), () => true, p);
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ globalInput: 0, inputChanged: 1, inertGlobal: 1 });
  });

  it('keeps the change global when the seam says no, throws, answers non-true, or is absent', () => {
    const seams: Array<((rel: string, from: string, to: string) => boolean) | null> = [
      () => false,
      () => {
        throw new Error('git show failed');
      },
      () => 1 as unknown as boolean,
      () => 'yes' as unknown as boolean,
      null,
    ];
    for (const seam of seams) {
      const r = runWithSeam(new Set(['package.json']), seam);
      expect(r.skip).toEqual([]);
      expect(r.summary).toMatchObject({ globalInput: 1, inertGlobal: 0 });
    }
  });

  it('stays global when any other global path drifted alongside the inert one', () => {
    const r = runWithSeam(new Set(['package.json', 'package-lock.json']), (rel) => rel === 'package.json');
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ globalInput: 1, inertGlobal: 0 });
  });

  it('gitInertGlobalChange reads both shas with git show, judges only the root package.json, and caches', () => {
    const texts: Record<string, string> = {
      'old:package.json': pkg(),
      'new:package.json': pkg({ scripts: { test: 'node scripts/affected-tests.mjs', 'lint:x': 'changed' } }),
      'dep:package.json': pkg({ devDependencies: { vitest: '9.9.9' } }),
    };
    const calls: string[][] = [];
    const exec = (file: string, args: string[]) => {
      calls.push([file, ...args]);
      const t = texts[args[1]!];
      if (t === undefined) throw new Error(`fatal: invalid object name ${args[1]}`);
      return t;
    };
    const seam = gitInertGlobalChange({ repoRoot: '/repo', exec });
    expect(seam('package.json', 'old', 'new')).toBe(true);
    expect(seam('package.json', 'old', 'new')).toBe(true);
    expect(calls).toEqual([
      ['git', 'show', 'old:package.json'],
      ['git', 'show', 'new:package.json'],
    ]);
    expect(seam('package.json', 'old', 'dep')).toBe(false);
    // A sha this clone lacks reads as "cannot tell": global.
    expect(seam('package.json', 'gone', 'new')).toBe(false);
    // Only the root manifest and the lockfile (P-005, below) can be inert; nothing else is read.
    const before = calls.length;
    expect(seam('libs/test-config/src/vitest-config.ts', 'old', 'new')).toBe(false);
    expect(seam('patches/x.patch', 'old', 'new')).toBe(false);
    expect(seam('packages/operator-core/package.json', 'old', 'new')).toBe(false);
    expect(calls.length).toBe(before);
  });
});

/**
 * gate-test-reuse-yield-2026-10-01 P-005: package-lock.json is global unless the installed tree is
 * identical at both shas. Proofs record no node_modules path (the reporter drops external modules),
 * so any installed-entry change stays global. Measured: 5 of 17 lockfile commits in the 7 days to
 * 2026-10-01 changed only workspace entries, and each one discarded every proof.
 */
describe('P-005: a lockfile edit that installs nothing different is not global', () => {
  const lock = (over: { packages?: Record<string, unknown>; top?: Record<string, unknown> } = {}) =>
    JSON.stringify({
      name: 'root',
      version: '0.0.1',
      lockfileVersion: 3,
      requires: true,
      ...over.top,
      packages: over.packages ?? {
        '': { name: 'root', workspaces: ['packages/*'], devDependencies: { vitest: '4.0.0' } },
        'packages/a': { name: '@x/a', version: '1.0.0', dependencies: { zod: '^3.0.0' } },
        'node_modules/@x/a': { resolved: 'packages/a', link: true },
        'node_modules/zod': { version: '3.1.0', resolved: 'https://r/zod-3.1.0.tgz', integrity: 'sha512-z' },
        'packages/a/node_modules/kleur': { version: '4.0.0', integrity: 'sha512-k' },
      },
    });
  const base = JSON.parse(lock()) as { packages: Record<string, Record<string, unknown>> };
  const withPackages = (edit: (p: Record<string, Record<string, unknown>>) => void) => {
    const p = structuredClone(base.packages);
    edit(p);
    return lock({ packages: p });
  };

  it('treats workspace-entry-only edits and key reordering as inert', () => {
    // A workspace declares a dependency that is already installed, and bumps its own version.
    const declared = withPackages((p) => {
      p['packages/a'] = { ...p['packages/a'], version: '1.1.0', dependencies: { zod: '^3.0.0', kleur: '^4.0.0' } };
    });
    expect(packageLockChangeIsInert(lock(), declared)).toBe(true);
    // The root entry's declarations mirror the root package.json (judged on its own, P-002).
    const rootDeclared = withPackages((p) => {
      p[''] = { ...p[''], devDependencies: { vitest: '4.0.0', zod: '^3.0.0' } };
    });
    expect(packageLockChangeIsInert(lock(), rootDeclared)).toBe(true);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(lock()) as Record<string, unknown>).reverse()));
    expect(reordered).not.toBe(lock());
    expect(packageLockChangeIsInert(lock(), reordered)).toBe(true);
  });

  it('keeps every installed-tree change global, at any depth', () => {
    const changes: Array<[string, string]> = [
      ['version bump', withPackages((p) => void (p['node_modules/zod'] = { ...p['node_modules/zod'], version: '3.2.0' }))],
      ['integrity only', withPackages((p) => void (p['node_modules/zod'] = { ...p['node_modules/zod'], integrity: 'sha512-y' }))],
      ['nested copy', withPackages((p) => void (p['packages/a/node_modules/kleur'] = { version: '4.1.0' }))],
      // A brand-new package can still change behaviour through an optional require probe.
      ['new package', withPackages((p) => void (p['node_modules/bufferutil'] = { version: '4.0.8' }))],
      ['removed package', withPackages((p) => void delete p['packages/a/node_modules/kleur'])],
      ['hoisting move', withPackages((p) => {
        p['node_modules/kleur'] = p['packages/a/node_modules/kleur']!;
        delete p['packages/a/node_modules/kleur'];
      })],
      ['workspace link retarget', withPackages((p) => void (p['node_modules/@x/a'] = { resolved: 'packages/b', link: true }))],
      // The two workspace-entry fields that act at install time.
      ['workspace install script', withPackages((p) => void (p['packages/a'] = { ...p['packages/a'], hasInstallScript: true }))],
      ['workspace bin', withPackages((p) => void (p['packages/a'] = { ...p['packages/a'], bin: { a: 'cli.js' } }))],
      ['lockfile version', lock({ top: { lockfileVersion: 2 } })],
    ];
    for (const [label, after] of changes) {
      expect(after, label).not.toBe(lock());
      expect(packageLockChangeIsInert(lock(), after), label).toBe(false);
    }
  });

  it('fails closed on anything it cannot judge', () => {
    expect(packageLockChangeIsInert(lock(), '{ not json')).toBe(false);
    expect(packageLockChangeIsInert('[]', '[]')).toBe(false);
    expect(packageLockChangeIsInert('null', 'null')).toBe(false);
    expect(packageLockChangeIsInert('{}', '{}')).toBe(false);
    expect(packageLockInstallView(JSON.stringify({ packages: { 'packages/a': 'x' } }))).toBeNull();
    // Calibration: the same text judges inert, so the lines above are not vacuous.
    expect(packageLockChangeIsInert(lock(), lock())).toBe(true);
  });

  it('gitInertGlobalChange judges the lockfile by install view, reading each sha once', () => {
    const texts: Record<string, string> = {
      'old:package-lock.json': lock(),
      'ws:package-lock.json': withPackages((p) => void (p['packages/a'] = { ...p['packages/a'], version: '2.0.0' })),
      'bump:package-lock.json': withPackages((p) => void (p['node_modules/zod'] = { ...p['node_modules/zod'], version: '3.9.0' })),
    };
    const calls: string[] = [];
    const exec = (_file: string, args: string[]) => {
      calls.push(args[1]!);
      const t = texts[args[1]!];
      if (t === undefined) throw new Error(`fatal: invalid object name ${args[1]}`);
      return t;
    };
    const seam = gitInertGlobalChange({ repoRoot: '/repo', exec });
    expect(seam('package-lock.json', 'old', 'ws')).toBe(true);
    expect(seam('package-lock.json', 'bump', 'ws')).toBe(false);
    expect(seam('package-lock.json', 'gone', 'ws')).toBe(false);
    // The judged sha ('ws') is shared by every proof; its 1 MB lockfile is read once.
    expect(calls.filter((c) => c === 'ws:package-lock.json')).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('reuses a proof across an inert lockfile change, unless the proof read the lockfile', () => {
    const T = 'packages/a/src/x.test.ts';
    const prf = (readPaths: string[] = []) => ({
      recordedSha: 'old',
      recordedAtMs: 1_000,
      executedModules: [T, 'packages/a/src/x.ts'],
      readPaths,
      inputsCaptured: true,
      opaqueReasons: [],
      runContext: 'green-checkpoint',
      runnerIdentity: 'id',
    });
    const run = (p: ReturnType<typeof prf>, inert: boolean) =>
      selectReusablePasses({
        candidates: [T],
        proofs: new Map([[T, p]]),
        judgedSha: 'new',
        changedBetween: () => new Set(['package-lock.json']),
        runContext: 'green-checkpoint',
        runnerIdentity: 'id',
        nowMs: 2_000,
        maxAgeMs: 1_000_000,
        inertGlobalChange: (rel: string) => inert && rel === 'package-lock.json',
      });
    expect(run(prf(), true).skip).toEqual([T]);
    expect(run(prf(), true).summary).toMatchObject({ reused: 1, globalInput: 0, inertGlobal: 1 });
    expect(run(prf(['package-lock.json']), true).summary).toMatchObject({ reused: 0, inputChanged: 1 });
    // Calibration: the same drift without the inert verdict is a global discard.
    expect(run(prf(), false).summary).toMatchObject({ reused: 0, globalInput: 1 });
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
    expect(line).toMatch(/ audited=0 expiredClean=0 inertGlobal=0$/);
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

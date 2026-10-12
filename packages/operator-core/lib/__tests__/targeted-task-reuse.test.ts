import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  armTargetedTaskReuse,
  isUnitVitestTaskScript,
  LANE_SCRIPTS,
  resolveWorkspacePackage,
} from '../../../../scripts/lib/targeted-task-reuse.mjs';
import { decideReuseSkip, parseReuseSkipList } from '@papercusp/test-config/test-pass-reuse-skip';
import { gateReuseObservations, recordGateReuseDecision } from '../../../../scripts/lib/test-pass-reuse.mjs';
import { summarizeFallbackWindow } from '../degradation/fallback-observations';
import { judgeDegradation } from '../system-health/degradation-watchdog';

/**
 * EI-24538088938561684: the green checkpoint's frozen-repair verification re-runs a failing
 * workspace task (`<ws> :: test:lane-stateful`) directly at the repair head. That re-run must get
 * the suite's per-file pass reuse (with its audit sample) and record pass proofs; every uncertain
 * case must run every file, exactly as before.
 */

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW = Date.parse('2026-10-01T06:00:00Z');
const RUNNER = 'v25.9.0 linux x64';
const CTX = 'green-checkpoint';
const WS = '@fixture/lane-ws';
const SCRIPT = 'test:lane-stateful';

const proof = (sha: string, modules: string[]) => ({
  recordedSha: sha,
  recordedAtMs: NOW - 3600_000,
  executedModules: modules,
  readPaths: [] as string[],
  inputsCaptured: true,
  opaqueReasons: [] as string[],
  runContext: CTX,
  runnerIdentity: RUNNER,
});

let root: string;
let temps: string[];
let ended: number;

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture(scriptBody = 'vitest run --passWithNoTests') {
  writeJson(join(root, 'package.json'), { name: 'fixture-root', workspaces: ['packages/*'] });
  writeJson(join(root, 'packages/lane-ws/package.json'), {
    name: WS,
    scripts: { [SCRIPT]: scriptBody, test: scriptBody, 'lint:tsc': 'tsc --noEmit' },
  });
}

/** The injection seams, typed from the module's own declaration (fakes are partial on purpose). */
type Deps = NonNullable<Parameters<typeof armTargetedTaskReuse>[0]['deps']>;

/** Seams for a clean checkout at HEAD with two proofs: a.test.ts reusable, b.test.ts input-changed. */
function deps(over: Record<string, unknown> = {}): Deps {
  return {
    recordReuse: async () => undefined,
    git: (_root: string, args: string[]) => (args[0] === 'rev-parse' ? `${HEAD}\n` : ''),
    runnerIdentity: () => RUNNER,
    connect: async () => ({ end: async () => void (ended += 1) }),
    loadProofs: async () => ({
      proofs: new Map([
        ['packages/lane-ws/a.test.ts', proof(HEAD, ['packages/lane-ws/a.test.ts', 'packages/lane-ws/src/a.ts'])],
        ['packages/lane-ws/b.test.ts', proof(OLD, ['packages/lane-ws/b.test.ts', 'packages/lane-ws/src/b.ts'])],
      ]),
      rows: 2,
    }),
    changedBetween: () => (a: string, b: string) =>
      a === OLD && b === HEAD ? new Set(['packages/lane-ws/src/b.ts']) : new Set<string>(),
    now: () => NOW,
    makeTempDir: () => {
      const d = mkdtempSync(join(tmpdir(), 'targeted-reuse-test-'));
      temps.push(d);
      return d;
    },
    ...over,
  } as unknown as Deps;
}

const baseEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  GREEN_CHECKPOINT: '1',
  AFFECTED_TEST_REUSE_AUDIT_RATE: '0',
  PATH: process.env.PATH,
  ...extra,
});

describe('gate reuse on the degradation rail (P-004)', () => {
  const TASK = `${WS}::${SCRIPT}`;

  it('records the real repair selector mismatch and composes it into a degraded task key', async () => {
    fixture();
    const observations: ReturnType<typeof gateReuseObservations> = [];
    const proofs = new Map(Array.from({ length: 25 }, (_, i) => {
      const file = `packages/lane-ws/${i}.test.ts`;
      return [file, { ...proof(HEAD, [file]), runnerIdentity: 'proof-v2 old-runner' }];
    }));
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD,
      env: baseEnv(), deps: deps({ loadProofs: async () => ({ proofs, rows: 25 }),
        recordReuse: async (task: string, decision: Parameters<typeof gateReuseObservations>[1]) => observations.push(...gateReuseObservations(task, decision)) }) });
    expect(armed.reused).toBe(0);
    expect(observations).toEqual([{ eligible: 25, applied: 0, reason: 'otherRunner', scope: TASK }]);
    const window = summarizeFallbackWindow('gate-pass-reuse', 60_000, observations.map((row) => ({ ...row, samples: 1 })));
    expect(judgeDegradation(window, { mechanism: 'gate-pass-reuse', scope: TASK })).toMatchObject({ kind: 'collapsed', reason: 'otherRunner' });
    armed.finish();
  });

  it.each(['dirty-checkout(2)', 'proofs-unavailable(timeout)', 'disabled-by-env', 'script-cannot-run-zero-files'])('keeps a positive denominator for %s', async (reason) => {
    const decisions = gateReuseObservations(TASK, { offReason: reason, eligible: 0 });
    expect(decisions).toEqual([{ eligible: 1, applied: 0, reason: reason.split('(')[0], scope: TASK }]);
  });

  it('records healthy primary decisions and excludes overlapping diagnostic counters', () => {
    const decisions = gateReuseObservations(TASK, { summary: { candidates: 25, reused: 25, inertGlobal: 25, expiredClean: 25 } });
    expect(decisions).toEqual([{ eligible: 25, applied: 25, reason: 'applied', scope: TASK }]);
    const window = summarizeFallbackWindow('gate-pass-reuse', 60_000, decisions.map((row) => ({ ...row, samples: 1 })));
    expect(judgeDegradation(window, { mechanism: 'gate-pass-reuse', scope: TASK }).kind).toBe('recovered');
  });

  it('uses the same primitive for both round types, flushes before exit, and never throws on telemetry failure', async () => {
    const calls: Array<{ mechanism: string; eligible: number; applied: number }> = [];
    let flushed = 0;
    const writer = {
      observeFallback: (mechanism: string, decision: { eligible: number; applied: number }) => calls.push({ mechanism, ...decision }),
      flushFallbackObservations: async () => { flushed++; return { failed: 0 }; },
    };
    expect(await recordGateReuseDecision(TASK, { summary: { candidates: 20, otherRunner: 20, reused: 0 } }, writer)).toBe(true);
    expect(await recordGateReuseDecision(TASK, { offReason: 'proofs-unavailable' }, writer)).toBe(true);
    expect(calls.map((row) => row.mechanism)).toEqual(['gate-pass-reuse', 'gate-pass-reuse']);
    expect(flushed).toBe(2);
    expect(await recordGateReuseDecision(TASK, { offReason: 'dirty-checkout' }, { ...writer,
      flushFallbackObservations: async () => { throw new Error('database offline'); } })).toBe(false);
  });

  it('does not let a throwing observation dependency change the repair skip decision', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(),
      deps: deps({ recordReuse: async () => { throw new Error('telemetry unavailable'); } }) });
    expect(armed.reused).toBe(1);
    armed.finish();
  });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'targeted-reuse-root-'));
  temps = [];
  ended = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('isUnitVitestTaskScript / LANE_SCRIPTS', () => {
  it('names the unit tasks affected-tests arms reuse on, and nothing else', () => {
    expect([...LANE_SCRIPTS]).toEqual(['test:lane-pure', 'test:lane-stateful']);
    expect(isUnitVitestTaskScript('test')).toBe(true);
    expect(isUnitVitestTaskScript('test:lane-stateful')).toBe(true);
    expect(isUnitVitestTaskScript('test:integration')).toBe(false);
    expect(isUnitVitestTaskScript('lint:tsc')).toBe(false);
  });
});

describe('resolveWorkspacePackage', () => {
  it('finds a root workspace by package name through the workspaces globs', () => {
    fixture();
    expect(resolveWorkspacePackage(root, WS)).toMatchObject({
      dirRel: 'packages/lane-ws',
      scripts: { [SCRIPT]: 'vitest run --passWithNoTests' },
    });
    expect(resolveWorkspacePackage(root, '@fixture/absent')).toBeNull();
  });
});

describe('armTargetedTaskReuse', () => {
  it('skips the file whose proof is valid at the repair head, runs the input-changed one, and arms recording', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: SCRIPT,
      expectedSha: HEAD,
      env: baseEnv(),
      scope: 'targeted-gate',
      deps: deps(),
    });

    expect(armed.reused).toBe(1);
    expect(armed.recording).toBe(true);
    expect(armed.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE).toBe(WS);
    expect(armed.env.PC_EXECUTED_SOURCE_MAP_NO_PERSIST).toBeUndefined();
    expect(armed.lines).toHaveLength(1);
    expect(armed.lines[0]).toMatch(
      /^TARGETED_TEST_PASS_REUSE ws=@fixture\/lane-ws::test:lane-stateful candidates=2 reused=1 .*inputChanged=1 .* scope=targeted-gate rows=2 sha=aaaaaaaaaaaa$/,
    );
    expect(ended).toBe(1);

    // The skip list is what the workspace's vitest config reads: workspace-relative, and accepted
    // by the reader under the same run context and runner identity.
    const listPath = armed.env.PC_TEST_REUSE_SKIP_LIST!;
    const list = parseReuseSkipList(readFileSync(listPath, 'utf8'));
    expect(list.files).toEqual(['a.test.ts']);
    expect(list.judgedSha).toBe(HEAD);
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: RUNNER })).toMatchObject({ applied: true });

    expect(armed.finish()).toEqual([
      expect.stringMatching(/^TARGETED_EXECUTED_SOURCE_MAP_RESULT task=@fixture\/lane-ws::test:lane-stateful outcome=no-report/),
    ]);
    expect(existsSync(listPath)).toBe(false);
  });

  // WI-6554700010008589: gate run 762a13a6 judged a frozen repair head whose recorder writes proof-v2
  // while this selector's constant is newer, and reused nothing (every proof `otherRunner`). The arm
  // must take the JUDGED tree's format for the identity, the skip list and the legacy drift rule.
  it('matches the judged tree recorder format and applies the legacy drift rule to its proofs', async () => {
    const LEGACY_RUNNER = `proof-v2 ${RUNNER}`;
    const legacyProofs = async () => ({
      proofs: new Map([
        ['packages/lane-ws/a.test.ts', { ...proof(OLD, ['packages/lane-ws/a.test.ts', 'packages/lane-ws/src/a.ts']), runnerIdentity: LEGACY_RUNNER }],
        ['packages/lane-ws/b.test.ts', { ...proof(OLD, ['packages/lane-ws/b.test.ts', 'packages/lane-ws/src/b.ts']), runnerIdentity: LEGACY_RUNNER }],
      ]),
      rows: 2,
    });
    const legacyDeps = (drift: string[]) =>
      deps({
        proofFormat: () => 'proof-v2',
        runnerIdentity: (_root: string, _env: unknown, format: string) => `${format} ${RUNNER}`,
        loadProofs: legacyProofs,
        changedBetween: () => (a: string, b: string) => (a === OLD && b === HEAD ? new Set(drift) : new Set<string>()),
      });

    fixture();
    const armed = await armTargetedTaskReuse({
      root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), scope: 'targeted-gate',
      deps: legacyDeps(['packages/lane-ws/c.test.ts']),
    });
    expect(armed.reused).toBe(2);
    expect(armed.lines[0]).toMatch(/ otherRunner=0 /);
    expect(armed.lines[0]).toMatch(/ proofFormat=proof-v2\(legacy\)$/);
    const list = parseReuseSkipList(readFileSync(armed.env.PC_TEST_REUSE_SKIP_LIST!, 'utf8'));
    expect(list.runnerIdentity).toBe(LEGACY_RUNNER);
    // The judged tree's own consumer computes ITS identity, so it accepts the list.
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: LEGACY_RUNNER })).toMatchObject({ applied: true });
    armed.finish();

    // A non-test drift path may be a module a legacy proof loaded without recording it: run both.
    fixture();
    const strict = await armTargetedTaskReuse({
      root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), scope: 'targeted-gate',
      deps: legacyDeps(['packages/lane-ws/c.test.ts', 'packages/lane-ws/src/unrecorded.ts']),
    });
    expect(strict.reused).toBe(0);
    expect(strict.lines[0]).toMatch(/ legacyFormatDrift=2 /);
    strict.finish();
  });

  // gate-test-reuse-yield-2026-10-01 P-006 (D-005): the pure-lane runner's script never names
  // --passWithNoTests, yet it runs zero files as a pass, so the repair-head rerun may reuse too.
  it('arms reuse for the pure-lane runner script, which runs an all-reused lane as a pass', async () => {
    fixture('PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- node ../../scripts/run-vitest-pure-lane.mjs');
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: SCRIPT,
      expectedSha: HEAD,
      env: baseEnv(),
      deps: deps(),
    });
    expect(armed.reused).toBe(1);
    expect(armed.lines.join('\n')).not.toMatch(/script-cannot-run-zero-files/);
  });

  it('keeps the soundness audit: an audit draw runs a reusable file instead of skipping it', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: SCRIPT,
      expectedSha: HEAD,
      env: baseEnv({ AFFECTED_TEST_REUSE_AUDIT_RATE: '1' }),
      deps: deps(),
    });
    expect(armed.reused).toBe(0);
    expect(armed.env.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
    expect(armed.lines[0]).toMatch(/ reused=0 .*audited=1 /);
    armed.finish();
  });

  it('reuses plain Vitest passes while changed and unproven files still run', async () => {
    fixture('vitest run');
    for (const file of ['a.test.ts', 'b.test.ts', 'c.test.ts']) writeFileSync(join(root, 'packages/lane-ws', file), '');
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), deps: deps() });
    expect(armed.reused).toBe(1);
    expect(armed.args).toEqual([]);
    const list = JSON.parse(readFileSync(armed.env.PC_TEST_REUSE_SKIP_LIST!, 'utf8'));
    expect(list.files).toEqual(['a.test.ts']);
    expect(armed.lines.join('\n')).toMatch(/inputChanged=1/);
    armed.finish();
  });

  it('supplies the zero-file flag only when the complete disk population is reused', async () => {
    fixture('vitest run');
    writeFileSync(join(root, 'packages/lane-ws/a.test.ts'), '');
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), deps: deps({
      loadProofs: async () => ({ proofs: new Map([['packages/lane-ws/a.test.ts', proof(HEAD, ['packages/lane-ws/a.test.ts'])]]), rows: 1 }),
    }) });
    expect(armed.reused).toBe(1);
    expect(armed.args).toEqual(['--passWithNoTests']);
    armed.finish();
  });

  it('the real Vitest consumer skips an unchanged pass and executes changed and unproven files', async () => {
    fixture('vitest run');
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const wsRoot = join(root, 'packages/lane-ws');
    symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(wsRoot, 'src'));
    const skipConsumer = join(repoRoot, 'libs/test-config/src/test-pass-reuse-skip.ts');
    writeFileSync(join(wsRoot, 'vitest.config.mts'),
      `import { resolveReuseSkipExclude } from ${JSON.stringify(skipConsumer)};\n` +
      `export default { test: { include: ['*.test.ts'], exclude: resolveReuseSkipExclude(), maxWorkers: 1 } };\n`);
    for (const name of ['a', 'b']) {
      writeFileSync(join(wsRoot, `src/${name}.ts`), 'export const value = true;\n');
      writeFileSync(join(wsRoot, `${name}.test.ts`),
        `import { it, expect } from 'vitest'; import { value } from './src/${name}';\n` +
        `it('${name}', () => expect(value).toBe(true));\n`);
    }
    const run = (env: Record<string, string | undefined>, args: string[] = []) => {
      const result = spawnSync(join(repoRoot, 'node_modules/.bin/vitest'), ['run', '--reporter=json', ...args], {
        cwd: wsRoot, env, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error, result.stderr).toBeUndefined();
      return { status: result.status, report: JSON.parse(result.stdout) };
    };
    const env = { ...process.env, ...baseEnv(), PC_TEST_LANE: undefined, PC_TEST_REUSE_SKIP_LIST: undefined,
      PC_EXECUTED_SOURCE_MAP_WORKSPACE: undefined, PC_EXECUTED_SOURCE_MAP_RESULT: undefined,
      PC_EXECUTED_SOURCE_MAP_OUT: undefined, PC_TEST_FILTER_LIST: undefined };
    const first = run(env);
    expect(first.status).toBe(0);
    expect(first.report.testResults.map((r: { name: string }) => r.name.split('/').at(-1)).sort()).toEqual(['a.test.ts', 'b.test.ts']);
    writeFileSync(join(wsRoot, 'src/b.ts'), 'export const value = false;\n');
    writeFileSync(join(wsRoot, 'c.test.ts'), "import { it, expect } from 'vitest'; it('c', () => expect(true).toBe(true));\n");
    const identity = `proof-v3 ${process.version} ${process.platform} ${process.arch}`;
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env,
      deps: deps({ runnerIdentity: () => identity, loadProofs: async () => ({ rows: 2, proofs: new Map(
        ['a', 'b'].map(name => [`packages/lane-ws/${name}.test.ts`, {
          ...proof(OLD, [`packages/lane-ws/${name}.test.ts`, `packages/lane-ws/src/${name}.ts`]), runnerIdentity: identity,
        }]),
      ) }) }) });
    try {
      expect(armed.reused).toBe(1);
      const second = run(armed.env, armed.args);
      expect(second.status).toBe(1);
      expect(second.report.testResults.map((r: { name: string }) => r.name.split('/').at(-1)).sort()).toEqual(['b.test.ts', 'c.test.ts']);
      expect(second.report.numFailedTests).toBe(1);
      expect(second.report.numPassedTests).toBe(1);
    } finally { armed.finish(); }
  }, 30_000);

  it('reports what the recorder did after the task ran', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), deps: deps() });
    const resultFile = armed.env.PC_EXECUTED_SOURCE_MAP_RESULT!;
    writeFileSync(
      resultFile,
      `${JSON.stringify({ workspaceName: WS, outcome: 'written', rows: 3, retired: 0, skipped: 1, sha: HEAD, dirty: false, error: null })}\n`,
    );
    expect(armed.finish()).toEqual([
      `TARGETED_EXECUTED_SOURCE_MAP_RESULT task=${WS}::${SCRIPT} outcome=written rows=3 retired=0 skipped=1 dirty=false sha=aaaaaaaaaaaa`,
    ]);
    expect(existsSync(resultFile)).toBe(false);
  });

  it('strips skip-list, no-persist and result channels inherited from an outer environment', async () => {
    fixture();
    const inherited = baseEnv({
      PC_TEST_REUSE_SKIP_LIST: '/tmp/foreign-skip.json',
      PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
      PC_EXECUTED_SOURCE_MAP_RESULT: '/tmp/foreign-result.jsonl',
      PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/foreign-out.json',
    });
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: 'lint:tsc',
      expectedSha: HEAD,
      env: inherited,
      deps: deps(),
    });
    expect(armed.lines).toEqual([]);
    expect(armed.recording).toBe(false);
    for (const key of [
      'PC_TEST_REUSE_SKIP_LIST',
      'PC_EXECUTED_SOURCE_MAP_NO_PERSIST',
      'PC_EXECUTED_SOURCE_MAP_RESULT',
      'PC_EXECUTED_SOURCE_MAP_OUT',
      'PC_EXECUTED_SOURCE_MAP_WORKSPACE',
    ]) {
      expect(armed.env[key]).toBeUndefined();
    }
    // The caller's env object is not mutated.
    expect(inherited.PC_TEST_REUSE_SKIP_LIST).toBe('/tmp/foreign-skip.json');
  });

  it('does not arm recording when the runner switch is off', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: SCRIPT,
      expectedSha: HEAD,
      env: baseEnv({ AFFECTED_RECORD_EXECUTED_SOURCES: '0' }),
      deps: deps(),
    });
    expect(armed.recording).toBe(false);
    expect(armed.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE).toBeUndefined();
    armed.finish();
  });

  describe('fails open: no skip list, every file runs, recording stays armed', () => {
    const cases: Array<[string, () => void, Record<string, unknown>, Record<string, string>, RegExp]> = [
      ['the checkout is not the expected sha', fixture, {}, {}, /reason=head-mismatch\(aaaaaaaaaaaa!=cccccccccccc\)/],
      ['the checkout is dirty', fixture, { git: (_r: string, a: string[]) => (a[0] === 'rev-parse' ? HEAD : ' M x.ts\n') }, {}, /reason=dirty-checkout\(1\)/],
      ['git status cannot be read', fixture, { git: (_r: string, a: string[]) => (a[0] === 'rev-parse' ? HEAD : null) }, {}, /reason=checkout-status-unknown/],
      ['the script cannot receive Vitest args', () => fixture('node --test'), {}, {}, /reason=script-cannot-run-zero-files/],
      ['reuse is disabled by env', fixture, {}, { AFFECTED_TEST_REUSE: '0' }, /reason=disabled-by-env/],
      ['the database is unreachable', fixture, { connect: async () => { throw new Error('ECONNREFUSED 5432'); } }, {}, /reason=pg-unavailable\(ECONNREFUSED_5432\)/],
      ['the proof read fails', fixture, { loadProofs: async () => { throw new Error('relation missing'); } }, {}, /reason=proofs-unavailable\(relation_missing\)/],
      ['the runner identity is unknown', fixture, { runnerIdentity: () => null }, {}, /reason=no-runner-identity/],
    ];
    it.each(cases)('when %s', async (_name, setup, over, extraEnv, reason) => {
      setup();
      const expectedSha = String(reason).includes('head-mismatch') ? 'c'.repeat(40) : HEAD;
      const armed = await armTargetedTaskReuse({
        root,
        workspace: WS,
        script: SCRIPT,
        expectedSha,
        env: baseEnv(extraEnv),
        deps: deps(over),
      });
      expect(armed.reused).toBe(0);
      expect(armed.env.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
      expect(armed.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE).toBe(WS);
      expect(armed.lines).toHaveLength(1);
      expect(armed.lines[0]).toMatch(/^TARGETED_TEST_PASS_REUSE ws=@fixture\/lane-ws::test:lane-stateful scope=targeted applied=false /);
      expect(armed.lines[0]).toMatch(reason);
      armed.finish();
    });

    it('when the workspace cannot be resolved', async () => {
      fixture();
      const armed = await armTargetedTaskReuse({
        root,
        workspace: '@fixture/absent',
        script: SCRIPT,
        expectedSha: HEAD,
        env: baseEnv(),
        deps: deps(),
      });
      expect(armed.env.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
      expect(armed.lines[0]).toMatch(/reason=workspace-unresolved/);
      armed.finish();
    });

    it('closes the database client even when the proof read fails', async () => {
      fixture();
      const armed = await armTargetedTaskReuse({
        root,
        workspace: WS,
        script: SCRIPT,
        expectedSha: HEAD,
        env: baseEnv(),
        deps: deps({ loadProofs: async () => { throw new Error('boom'); } }),
      });
      expect(ended).toBe(1);
      armed.finish();
    });
  });
});

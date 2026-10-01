import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  armTargetedTaskReuse,
  isUnitVitestTaskScript,
  LANE_SCRIPTS,
  resolveWorkspacePackage,
} from '../../../../scripts/lib/targeted-task-reuse.mjs';
import { decideReuseSkip, parseReuseSkipList } from '@papercusp/test-config/test-pass-reuse-skip';

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
      ['the script cannot run zero files', () => fixture('vitest run'), {}, {}, /reason=script-cannot-run-zero-files/],
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

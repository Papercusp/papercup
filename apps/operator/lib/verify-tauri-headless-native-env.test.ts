import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../../..');
const helper = resolve(root, 'scripts/lib/verify-tauri-native-env.mjs');
const { nativeVerifierEnv, preflightNativeVerifier, desktopPortalNativeTiming,
  desktopPortalNativeTestTimeoutMs, admitDesktopPortalNativeParent } = await import(pathToFileURL(helper).href);
const { admitTaskDeadline } = await import(pathToFileURL(resolve(root, 'scripts/lib/task-deadline.mjs')).href);

describe('real native verifier process boundary', () => {
  it('uses the physical donor while keeping a retained shadow and its acceptance source pinned', () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-donor-'));
    const donor = join(directory, 'installed');
    const source = join(directory, 'retained');
    const git = (args: string[], cwd = donor) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    try {
      mkdirSync(donor);
      git(['init', '--quiet']);
      writeFileSync(join(donor, 'acceptance.txt'), 'committed source');
      git(['add', 'acceptance.txt']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'native source']);
      const sha = git(['rev-parse', 'HEAD']);
      git(['clone', '--quiet', '--local', donor, source]);
      writeFileSync(join(source, '.git/lint-as-committed-owner.json'), JSON.stringify({ sha, sourceRepoRoot: donor }));
      const metadata = 'apps/operator-public/node_modules/.mf';
      mkdirSync(join(donor, metadata), { recursive: true });
      mkdirSync(join(source, 'apps/operator-public/node_modules'), { recursive: true });
      symlinkSync(join(donor, metadata), join(source, metadata));
      mkdirSync(join(donor, 'node_modules'));
      writeFileSync(join(donor, 'acceptance.txt'), 'mutable donor source');
      const parent = { PAPERCUSP_REPO_DIR: source };
      const child = nativeVerifierEnv(parent, { repoRoot: source });
      const observed = JSON.parse(execFileSync(process.execPath, ['-e',
        'const cp=require("node:child_process");console.log(JSON.stringify({donor:process.env.PAPERCUSP_REPO_DIR,source:cp.execFileSync("git",["show",process.env.VERIFY_TAURI_SOURCE_REF+":acceptance.txt"],{encoding:"utf8"})}))'],
      { cwd: source, env: child, encoding: 'utf8' }));
      expect(observed).toEqual({ donor: realpathSync(donor), source: 'committed source' });
      expect(child.VERIFY_TAURI_SOURCE_REF).toBe(sha);
      expect(child.VERIFY_TAURI_SOURCE_INPUTS).toContain('apps/operator/bin/desktop-portal-native.test.ts');
      expect(parent.PAPERCUSP_REPO_DIR).toBe(source);
      expect(lstatSync(join(source, metadata)).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(donor, metadata)).isDirectory()).toBe(true);
      expect(() => nativeVerifierEnv({ VERIFY_TAURI_SOURCE_REF: 'wrong' }, { repoRoot: source }))
        .toThrow('source ref must match');
      const noInstall = join(directory, 'not-installed');
      mkdirSync(noInstall);
      expect(() => nativeVerifierEnv({}, { repoRoot: noInstall })).toThrow('physical installed dependency donor');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves the rig allocation after parent setup without extending the inherited deadline', () => {
    const start = 1_000_000;
    const setupEnd = start + 115_000; // native14's measured readiness/PG setup
    const nativeMs = desktopPortalNativeTiming.nativeTimeoutMs;
    const parent = { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(start + 3_445_000) };
    const child = nativeVerifierEnv(parent, { timeoutMs: nativeMs, nowMs: setupEnd });
    expect(admitTaskDeadline({ env: child, nowMs: setupEnd, knownEstimateMs: 2_640_000 }))
      .toMatchObject({ remainingMs: nativeMs });
    expect(parent.PAPERCUSP_TASK_DEADLINE_EPOCH_MS).toBe(String(start + 3_445_000));
    const clipped = nativeVerifierEnv(parent, { timeoutMs: nativeMs, nowMs: start + 1_000_000 });
    expect(clipped.PAPERCUSP_TASK_DEADLINE_EPOCH_MS).toBe(parent.PAPERCUSP_TASK_DEADLINE_EPOCH_MS);
    expect(() => admitTaskDeadline({ env: clipped, nowMs: start + 1_000_000, knownEstimateMs: 2_640_000 }))
      .toThrow('TASK_DEADLINE_REFUSAL');
  });

  it('admits the composed parent budget and rejects an undersized parent before setup', () => {
    const start = 1_000_000;
    const total = desktopPortalNativeTestTimeoutMs();
    expect(total).toBe(desktopPortalNativeTiming.setupTimeoutMs
      + desktopPortalNativeTiming.nativeTimeoutMs + desktopPortalNativeTiming.cleanupTimeoutMs);
    const env = { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(total + 120_000),
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(start + total + 240_000) };
    expect(admitDesktopPortalNativeParent(env, start)).toMatchObject({ knownEstimateMs: total });
    expect(() => admitDesktopPortalNativeParent({ ...env,
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(start + 3_000_000) }, start)).toThrow('TASK_DEADLINE_REFUSAL');
    expect(() => admitDesktopPortalNativeParent({ ...env, PAPERCUSP_TEST_FILE_TIMEOUT_MS: '2880000' }, start))
      .toThrow('refusing before PostgreSQL or dependency copying');
  });

  it('keeps the parent unit rail active while the real child has no unit runner or fake census', () => {
    const parent = { ...process.env, PAPERCUSP_FORBID_REAL_PG: '1', VITEST: 'true',
      VITEST_WORKER_ID: '9', VITEST_POOL_ID: '2', PAPERCUSP_SID: 'test-owner',
      PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: '/test-only-census.json',
      PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT: 'admitted-by-vitest',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '123456789', PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' };
    const child = nativeVerifierEnv(parent);
    const observed = JSON.parse(execFileSync(process.execPath, ['-e',
      'console.log(JSON.stringify({rail:process.env.PAPERCUSP_FORBID_REAL_PG??null,vitest:process.env.VITEST??null,owner:process.env.PAPERCUSP_SID}))'],
    { env: child, encoding: 'utf8' }));
    expect(observed).toEqual({ rail: null, vitest: null, owner: 'test-owner' });
    expect(parent.PAPERCUSP_FORBID_REAL_PG).toBe('1');
    expect(process.env.PAPERCUSP_FORBID_REAL_PG).toBe('1');
    expect(child.PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE).toBeUndefined();
    expect(child).toMatchObject({ PAPERCUSP_SID: 'test-owner',
      PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT: 'admitted-by-vitest',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '123456789', PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' });
  });

  it('actually runs the committed tree census even with inherited upstream admission', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: 'RESTRICTED_HOLD_PREFLIGHT {"verdict":"admit"}\n' }));
    preflightNativeVerifier(root, { VITEST: 'true', PAPERCUSP_FORBID_REAL_PG: '1',
      PAPERCUSP_WORKSPACE_ID: 'source-workspace',
      PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT: 'testing-run' }, spawn);
    expect(spawn).toHaveBeenCalledOnce();
    const [, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args).toContain('--tree');
    expect(args.at(-1)).toBe(root);
    expect(args.join(' ')).toContain('committed-source-loader.mjs');
    expect(options.env.PAPERCUSP_FORBID_REAL_PG).toBeUndefined();
    expect(options.env.NODE_OPTIONS).toContain('committed-source-loader.mjs');
  });

  it.each([
    { PAPERCUSP_WORKSPACE_ID: 'explicit-source', PAPERCUSP_WORKSPACE: 'ambient-source',
      PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-source', expected: 'explicit-source' },
    { PAPERCUSP_WORKSPACE: 'ambient-source', PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-source',
      expected: 'ambient-source' },
    { PAPERCUSP_WORKSPACE_ID: ' ', PAPERCUSP_WORKSPACE: '',
      PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-source', expected: 'ledger-source' },
  ])('gives the real native child its source workspace after hermetic worker setup: %j', input => {
    const { expected, ...parent } = input;
    const child = nativeVerifierEnv(parent);
    const observed = execFileSync(process.execPath, ['-e',
      'process.stdout.write(process.env.PAPERCUSP_WORKSPACE_ID ?? "missing")'],
    { env: child, encoding: 'utf8' });
    expect(observed).toBe(expected);
    expect(parent.PAPERCUSP_WORKSPACE_ID).toBe(input.PAPERCUSP_WORKSPACE_ID);
  });

  it.each([{}, { PAPERCUSP_WORKSPACE_ID: ' ', PAPERCUSP_WORKSPACE: '',
    PAPERCUSP_TEST_RUN_WORKSPACE: '\t' }])('refuses missing workspace before the expensive census: %j', env => {
    const spawn = vi.fn(() => ({ status: 0, stdout: 'RESTRICTED_HOLD_PREFLIGHT {"verdict":"admit"}\n' }));
    expect(() => preflightNativeVerifier(root, env, spawn)).toThrow('Native verifier requires a source workspace');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { status: 3, stdout: 'RESTRICTED_HOLD_PREFLIGHT {"verdict":"refuse","error":"restricted_write_held","hint":"held input"}\n' },
    { status: 3, stdout: 'RESTRICTED_HOLD_PREFLIGHT {"verdict":"refuse","error":"restricted_hold_state_unknown","hint":"database unavailable"}\n' },
    { status: 0, stdout: '' },
    { status: null, signal: 'SIGTERM' },
  ])('refuses native preparation on an unsafe or unavailable census: %j', result => {
    expect(() => preflightNativeVerifier(root, { PAPERCUSP_WORKSPACE_ID: 'source-workspace' }, () => result))
      .toThrow('Native verifier census is not ready');
  });

  it('checks readiness before PostgreSQL creation and uses the child environment at native launch', () => {
    const test = readFileSync(resolve(root, 'apps/operator/bin/desktop-portal-persistence.test.ts'), 'utf8');
    expect(test.indexOf("[nativeEnvHelper, '--preflight', repo]")).toBeLessThan(test.indexOf("join(pg, 'initdb')"));
    expect(test).toContain("env: { ...nativeEnv(), VERIFY_TAURI_ISOLATED_DB: '1'");
  });
});

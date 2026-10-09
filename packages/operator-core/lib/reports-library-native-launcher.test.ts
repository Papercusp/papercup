import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({ execute: vi.fn(), authenticate: vi.fn(),
  reportRuntime: vi.fn(), end: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: seams.execute }));
vi.mock('../../../libs/generic/tauri-verify/src/bridge-client', () => ({ bridgeEval: seams.authenticate }));
vi.mock('./runtime-vintage', () => ({ reportRuntimeVintage: seams.reportRuntime,
  listRuntimeVintage: async () => [], measureRuntimeVintageEnvironment: () => 'measured-native' }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: { end: seams.end } }) }));
import { runNativeE2e } from '../../../scripts/tauri-surface-verify-reports.mts';
import { verifierSourceFiles } from './verifier-source';

describe('Reports native launcher at the Vitest temp-directory boundary', () => {
  let root: string;
  let nativeRoot: string;
  let runnerRoot: string;
  let sourceRoot: string;
  let receiptPath: string;
  let profilePath: string;
  beforeEach(() => {
    vi.resetAllMocks();
    seams.authenticate.mockResolvedValue({ ok: true, value: true });
    seams.reportRuntime.mockResolvedValue(undefined);
    seams.end.mockResolvedValue(undefined);
    root = mkdtempSync(join(tmpdir(), 'reports-native-launcher-test-'));
    nativeRoot = join(root, 'native');
    runnerRoot = join(root, 'vitest');
    mkdirSync(nativeRoot);
    mkdirSync(runnerRoot);
    const source = 'a'.repeat(40);
    sourceRoot = join(root, 'source');
    const files = ['packages/operator-core/lib/reports-library-native.e2e.test.ts',
      'packages/operator-core/lib/blueprint/morning-ai-intelligence.native.e2e.test.ts'];
    for (const file of files) {
      mkdirSync(join(sourceRoot, file, '..'), { recursive: true });
      writeFileSync(join(sourceRoot, file), '// committed native test fixture\n');
    }
    const sourceFiles = verifierSourceFiles(sourceRoot);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: source,
      testedInputs: sourceFiles.map(({ path, sha256 }) => ({ path, sha256 })), files: sourceFiles };
    receiptPath = join(root, 'source.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(sourceRoot, '.verifier-source.json'), JSON.stringify(receipt));
    writeFileSync(join(nativeRoot, `tauri-dev-bridge-${process.pid}.token`),
      JSON.stringify({ pid: process.pid, port: 1234, token: 'fixture-bridge' }));
    vi.stubEnv('TMPDIR', nativeRoot);
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', 'postgresql://fixture/ledger');
    vi.stubEnv('OPERATOR_SOURCE_ROOT', sourceRoot);
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', source);
    vi.stubEnv('VERIFY_TAURI_PID', String(process.pid));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('preserves the parent discovery root and removes the profile after runner failure=%s', async (fail) => {
    seams.execute.mockImplementation((_command, args, options) => {
      profilePath = options.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
      // This is the boundary that caused the incident: the running native
      // bridge stays in its original directory while the test runner moves.
      vi.stubEnv('TMPDIR', runnerRoot);
      expect(tmpdir()).toBe(runnerRoot);
      const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
      expect(profile.nativeTmpDir).toBe(nativeRoot);
      expect(profile.tauriPID).toBe(process.pid);
      expect(existsSync(join(tmpdir(), `tauri-dev-bridge-${profile.tauriPID}.token`))).toBe(false);
      expect(JSON.parse(readFileSync(join(profile.nativeTmpDir,
        `tauri-dev-bridge-${profile.tauriPID}.token`), 'utf8')).pid).toBe(process.pid);
      expect(existsSync(join(options.cwd, '.git'))).toBe(false);
      expect(options.cwd).toBe(sourceRoot);
      expect(args).toEqual(['run', 'test:file', '--', 'packages/operator-core/lib/reports-library-native.e2e.test.ts']);
      expect(args.at(-1)).toBe('packages/operator-core/lib/reports-library-native.e2e.test.ts');
      if (fail) throw new Error('native test failed');
      return '';
    });
    if (fail) await expect(runNativeE2e()).rejects.toThrow('native test failed');
    else await runNativeE2e();
    expect(seams.execute).toHaveBeenCalledTimes(1);
    expect(existsSync(profilePath)).toBe(false);
  });

  it('runs the AI consumer through the same committed-source and native runtime boundary', async () => {
    const file = 'packages/operator-core/lib/blueprint/morning-ai-intelligence.native.e2e.test.ts';
    await runNativeE2e([file]);
    const [command, args, options] = seams.execute.mock.calls[0];
    expect(command).toBe('npm');
    expect(args).toEqual(['run', 'test:file', '--', file]);
    expect(options.cwd).toBe(sourceRoot);
    expect(seams.reportRuntime).toHaveBeenCalledTimes(1);
    expect(existsSync(options.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE)).toBe(false);
  });

  it.each([{ files: [] }, { files: ['../foreign.e2e.test.ts'] }, { files: ['--ref=other'] }])(
    'refuses invalid native test selection $files', async ({ files }) => {
    await expect(runNativeE2e(files)).rejects.toThrow('Use maintained operator-core native E2E test files');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it('refuses a shared live desktop before authentication, runtime writes or test launch', async () => {
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '0');
    await expect(runNativeE2e()).rejects.toThrow('Use the isolated native verifier');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it('refuses an unconfigured shared ledger before bridge authentication or runtime writes', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', '');
    await expect(runNativeE2e()).rejects.toThrow('Keep native results in the shared test ledger');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it.each(['source bytes', 'archive manifest', 'source root', 'source commit'] as const)(
    'refuses changed %s before authentication, runtime writes or test launch', async (changed) => {
    if (changed === 'source bytes') writeFileSync(join(sourceRoot,
      'packages/operator-core/lib/reports-library-native.e2e.test.ts'), '// foreign bytes\n');
    if (changed === 'archive manifest') writeFileSync(join(sourceRoot, '.verifier-source.json'), '{}');
    if (changed === 'source root') vi.stubEnv('OPERATOR_SOURCE_ROOT', runnerRoot);
    if (changed === 'source commit') vi.stubEnv('VERIFY_TAURI_SOURCE_REF', 'b'.repeat(40));
    await expect(runNativeE2e()).rejects.toThrow();
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it('refuses a maintained test absent from the attested snapshot before any native effects', async () => {
    await expect(runNativeE2e(['packages/operator-core/lib/missing.native.e2e.test.ts']))
      .rejects.toThrow('Native test selection must belong to the verified source snapshot');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });
});

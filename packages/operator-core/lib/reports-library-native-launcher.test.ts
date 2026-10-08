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

describe('Reports native launcher at the Vitest temp-directory boundary', () => {
  let root: string;
  let nativeRoot: string;
  let runnerRoot: string;
  let profilePath: string;
  beforeEach(() => {
    vi.clearAllMocks();
    seams.authenticate.mockResolvedValue({ ok: true, value: true });
    seams.reportRuntime.mockResolvedValue(undefined);
    seams.end.mockResolvedValue(undefined);
    root = mkdtempSync(join(tmpdir(), 'reports-native-launcher-test-'));
    nativeRoot = join(root, 'native');
    runnerRoot = join(root, 'vitest');
    mkdirSync(nativeRoot);
    mkdirSync(runnerRoot);
    const source = 'a'.repeat(40);
    const receipt = join(root, 'source.json');
    writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: source }));
    writeFileSync(join(nativeRoot, `tauri-dev-bridge-${process.pid}.token`),
      JSON.stringify({ pid: process.pid, port: 1234, token: 'fixture-bridge' }));
    vi.stubEnv('TMPDIR', nativeRoot);
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', 'postgresql://fixture/ledger');
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receipt);
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
      expect(args).toContain(`--ref=${'a'.repeat(40)}`);
      if (fail) throw new Error('native test failed');
      return '';
    });
    if (fail) await expect(runNativeE2e()).rejects.toThrow('native test failed');
    else await runNativeE2e();
    expect(seams.execute).toHaveBeenCalledTimes(1);
    expect(existsSync(profilePath)).toBe(false);
  });

  it('refuses a shared live desktop before authentication, runtime writes or test launch', async () => {
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '0');
    await expect(runNativeE2e()).rejects.toThrow('Use the isolated native verifier');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });
});

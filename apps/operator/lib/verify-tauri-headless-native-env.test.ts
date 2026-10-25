import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../../..');
const helper = resolve(root, 'scripts/lib/verify-tauri-native-env.mjs');
const { nativeVerifierEnv, preflightNativeVerifier } = await import(pathToFileURL(helper).href);

describe('real native verifier process boundary', () => {
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

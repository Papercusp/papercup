import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { engineeringEvidenceReleaseInstrument } from './engineering-evidence-release-instrument';
// The executable is ordinary Node ESM; exercise its actual orchestration, not a copy.
import { verifyEngineeringRelease, type EngineeringReleaseChildResult } from '../../../../scripts/verify-engineering-evidence-release.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe('exact shipped engineering evidence detector', () => {
  function fixture() {
    const bytes = JSON.stringify({ workspaceId: 'workspace-fixture', clientId: 'session-fixture',
      buildSha: 'a'.repeat(40), promotionReceipt: 'canonical-green-log' });
    const nonce = 'fresh-invocation', receipt = JSON.stringify({ driver: 'tauri-agent-tools', plane: 'final-release', buildSha: 'a'.repeat(40),
      manifestSha256: hash(bytes), nonce });
    const proof = { plane: 'final-release', buildSha: 'a'.repeat(40), manifestSha256: hash(bytes), nonce,
      receiptPath: '/fixture/browser-receipt.json', receiptSha256: hash(receipt) };
    const run = vi.fn<NonNullable<Parameters<typeof verifyEngineeringRelease>[0]['run']>>(() => ({
      status: 0, stdout: 'ENGINEERING_EVIDENCE_JOURNEY_VERIFIED ' + JSON.stringify(proof) }));
    const read = vi.fn((path: string) => path === '/fixture/inputs.json' ? bytes : receipt);
    const files = new Map<string, string>();
    const write = vi.fn((path: string, body: string) => { files.set(path, body); });
    return { bytes, nonce, proof, run, read, write, files,
      args: { root: '/repository', inputsPath: '/fixture/inputs.json', nonce, run, read, write, env: {} } };
  }
  it('runs the owned Tauri executor and accepts only the freshly emitted artifact and manifest', () => {
    const f = fixture(), result = verifyEngineeringRelease(f.args);
    expect(result.status).toBe('pass');
    expect(f.run.mock.calls[0]?.[0]).toBe('bash');
    expect(f.run.mock.calls[0]?.[1]).toContain('/repository/scripts/verify-tauri-headless.sh');
    expect(f.run.mock.calls[0]?.[1]).toContain('exec node --import tsx "$OPERATOR_SOURCE_ROOT/scripts/verify-engineering-evidence-tauri.mjs"');
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({ env: { PAPERCUSP_WORKSPACE: 'workspace-fixture', PAPERCUSP_SID: 'session-fixture' } });
    expect(engineeringEvidenceReleaseInstrument('/repository').parse(JSON.stringify(result), { now: Date.now() })).toBe(0);
  });
  it('makes absent inputs, a failed child, zero-test success and a replayed nonce unknown', () => {
    const missing = fixture(); missing.read.mockImplementation(() => { throw new Error('absent'); });
    expect(verifyEngineeringRelease(missing.args).status).toBe('unknown'); expect(missing.run).not.toHaveBeenCalled();
    const malformed = fixture(); malformed.read.mockReturnValue('null');
    expect(verifyEngineeringRelease(malformed.args).status).toBe('unknown'); expect(malformed.run).not.toHaveBeenCalled();
    const failed = fixture(); failed.run.mockReturnValue({ status: 1, stdout: '' });
    expect(verifyEngineeringRelease(failed.args).status).toBe('unknown');
    const empty = fixture(); empty.run.mockReturnValue({ status: 0, stdout: '0 tests' });
    expect(verifyEngineeringRelease(empty.args).status).toBe('unknown');
    const replay = fixture(); replay.run.mockReturnValue({ status: 0,
      stdout: 'ENGINEERING_EVIDENCE_JOURNEY_VERIFIED ' + JSON.stringify({ ...replay.proof, nonce: 'old' }) });
    expect(verifyEngineeringRelease(replay.args).status).toBe('unknown');
  });
  it('rejects a current-build receipt, altered artifact bytes and a hand-written success lacking exact pins', () => {
    const wrongPlane = fixture(); wrongPlane.run.mockReturnValue({ status: 0,
      stdout: 'ENGINEERING_EVIDENCE_JOURNEY_VERIFIED ' + JSON.stringify({ ...wrongPlane.proof, plane: 'current-build' }) });
    expect(verifyEngineeringRelease(wrongPlane.args).status).toBe('unknown');
    const changed = fixture(); changed.read.mockImplementation(path => path === '/fixture/inputs.json' ? changed.bytes : '{}');
    expect(verifyEngineeringRelease(changed.args).status).toBe('unknown');
    expect(engineeringEvidenceReleaseInstrument('/repository').parse(JSON.stringify({ status: 'pass' }), { now: Date.now() })).toBeNull();
  });
  it('runs the existing integration/UI suite before the current-build browser and retains both receipts', () => {
    const f = fixture();
    const receipt = JSON.stringify({ driver: 'tauri-agent-tools', plane: 'current-build', buildSha: f.proof.buildSha, manifestSha256: f.proof.manifestSha256, nonce: f.nonce });
    const proof = { ...f.proof, plane: 'current-build', receiptSha256: hash(receipt) };
    f.read.mockImplementation(path => path === '/fixture/inputs.json' ? f.bytes : receipt);
    f.run.mockReturnValueOnce({ status: 0, stdout: 'TEST_FILE_RESULT requested=4 executed=4 matched=4 status=passed head=fixture uncommittedPaths=0/4 childSubstituted=0 skippedTests=0' })
      .mockReturnValueOnce({ status: 0, stdout: 'ENGINEERING_EVIDENCE_JOURNEY_VERIFIED ' + JSON.stringify(proof) });
    const write = vi.fn();
    const result = verifyEngineeringRelease({ ...f.args, plane: 'current-build', write });
    expect(result.status).toBe('pass');
    expect(f.run.mock.calls[0]?.[1]).toContain('/repository/scripts/with-test-pg.mjs');
    expect(f.run.mock.calls[0]?.[1]).toContain('--ref=' + f.proof.buildSha);
    expect(f.run.mock.calls[0]?.[1]).toContain('lint:as-committed');
    expect(f.run.mock.calls[1]?.[2]).toMatchObject({ env: { PAPERCUSP_ENGINEERING_PLANE: 'current-build', OPERATOR_E2E_BASE_URL: 'http://127.0.0.1:3170' } });
    expect(write).toHaveBeenCalledWith(expect.stringContaining('/runs/fresh-invocation/canonical-integration.log'), expect.any(String));
    expect(engineeringEvidenceReleaseInstrument('/repository', 'current-build').parse(JSON.stringify(result), { now: Date.now() })).toBe(0);
    expect(engineeringEvidenceReleaseInstrument('/repository').parse(JSON.stringify(result), { now: Date.now() })).toBeNull();
  });
  it('refuses a failed, skipped, substituted or dirty integration run before the browser starts', () => {
    for (const receipt of ['0 tests',
      'TEST_FILE_RESULT requested=4 executed=4 matched=4 status=passed uncommittedPaths=1/4 childSubstituted=0 skippedTests=0',
      'TEST_FILE_RESULT requested=4 executed=4 matched=4 status=passed uncommittedPaths=0/4 childSubstituted=1 skippedTests=0',
      'TEST_FILE_RESULT requested=4 executed=4 matched=4 status=passed uncommittedPaths=0/4 childSubstituted=0 skippedTests=2']) {
      const f = fixture(); f.run.mockReturnValue({ status: 0, stdout: receipt });
      expect(verifyEngineeringRelease({ ...f.args, plane: 'current-build', write: vi.fn() }).status).toBe('unknown');
      expect(f.run).toHaveBeenCalledOnce();
    }
  });
  it('retains browser failure output and terminal metadata before returning unknown', () => {
    const f = fixture();
    f.run.mockReturnValue({ status: 1, stdout: '1 failed: ee.current-or-shipped', stderr: 'expected source containment' });
    const result = verifyEngineeringRelease(f.args);
    expect(result.status).toBe('unknown');
    const browser = result.phases.browser!;
    expect(f.files.get(browser.stdoutPath)).toBe('1 failed: ee.current-or-shipped');
    expect(f.files.get(browser.stderrPath)).toBe('expected source containment');
    expect(JSON.parse(f.files.get(browser.metadataPath)!)).toMatchObject({
      phase: 'browser', status: 1, signal: null, error: null, nonce: f.nonce,
      buildSha: f.proof.buildSha, manifestSha256: f.proof.manifestSha256,
    });
    expect(engineeringEvidenceReleaseInstrument('/repository').parse(JSON.stringify(result), { now: Date.now() })).toBeNull();
  });
  it('retains timeout and launch errors, including partial output, without inventing a test verdict', () => {
    for (const child of [
      { status: null, signal: 'SIGTERM', stdout: 'partial browser output', stderr: 'timed out',
        error: Object.assign(new Error('spawnSync bash ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
      { status: null, signal: null, stdout: '', stderr: '',
        error: Object.assign(new Error('spawnSync bash ENOENT'), { code: 'ENOENT' }) },
    ] satisfies EngineeringReleaseChildResult[]) {
      const f = fixture(); f.run.mockReturnValue(child);
      const result = verifyEngineeringRelease(f.args);
      expect(result.status).toBe('unknown');
      const metadata = JSON.parse(f.files.get(result.phases.browser!.metadataPath)!);
      expect(metadata).toMatchObject({ status: null, signal: child.signal,
        error: { name: 'Error', message: child.error.message, code: child.error.code } });
      expect(f.files.get(result.phases.browser!.stdoutPath)).toBe(child.stdout);
    }
  });
  it('retains a failed integration phase and does not start the browser', () => {
    const f = fixture(); f.run.mockReturnValue({ status: 2, stdout: 'failing integration assertion', stderr: 'private PG stopped' });
    const result = verifyEngineeringRelease({ ...f.args, plane: 'current-build' });
    expect(result.status).toBe('unknown');
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.files.get(result.phases.integration!.stdoutPath)).toContain('failing integration assertion');
    expect(f.files.get(result.phases.integration!.stderrPath)).toContain('private PG stopped');
    expect(JSON.parse(f.files.get(result.phases.integration!.metadataPath)!)).toMatchObject({ status: 2 });
  });
  it('keeps successful integration evidence when the subsequent browser fails', () => {
    const f = fixture();
    f.run.mockReturnValueOnce({ status: 0, stdout: 'TEST_FILE_RESULT requested=4 executed=4 matched=4 status=passed uncommittedPaths=0/4 childSubstituted=0 skippedTests=0' })
      .mockReturnValueOnce({ status: 1, stdout: 'browser assertion failed' });
    const result = verifyEngineeringRelease({ ...f.args, plane: 'current-build' });
    expect(result.status).toBe('unknown');
    expect(result.integration!.result).toContain('status=passed');
    expect(f.files.get(result.integration!.logPath)).toContain('TEST_FILE_RESULT');
    expect(result.phases.browser!.status).toBe(1);
  });
  it('isolates native artifacts by invocation and retains zero-receipt failures', () => {
    const f = fixture(); f.run.mockReturnValue({ status: 0, stdout: '0 tests' });
    const first = verifyEngineeringRelease(f.args);
    const second = verifyEngineeringRelease({ ...f.args, nonce: 'second-invocation' });
    expect(first.status).toBe('unknown'); expect(second.status).toBe('unknown');
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({ env: {
      PAPERCUSP_ENGINEERING_JOURNEY_OUTPUT: '/fixture/runs/fresh-invocation/tauri',
      VERIFY_TAURI_SOURCE_REF: f.proof.buildSha,
    } });
    expect(f.run.mock.calls[1]?.[2]).toMatchObject({ env: {
      PAPERCUSP_ENGINEERING_JOURNEY_OUTPUT: '/fixture/runs/second-invocation/tauri',
    } });
    expect(first.phases.browser!.metadataPath).not.toBe(second.phases.browser!.metadataPath);
    expect(f.files.get(first.phases.browser!.stdoutPath)).toBe('0 tests');
    expect(f.files.get(second.phases.browser!.stdoutPath)).toBe('0 tests');
  });
  it('writes readable evidence from an actual failed process through the default file sink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engineering-phase-'));
    try {
      const f = fixture(), inputsPath = join(dir, 'inputs.json');
      writeFileSync(inputsPath, f.bytes);
      const result = verifyEngineeringRelease({ root: '/repository', inputsPath, nonce: f.nonce, env: {},
        run: () => spawnSync(process.execPath, ['-e', 'process.stdout.write("phase output"); process.stderr.write("assertion failure"); process.exit(7)'], { encoding: 'utf8' }) });
      expect(result.status).toBe('unknown');
      const phase = result.phases.browser!;
      const stdout = readFileSync(phase.stdoutPath, 'utf8'), stderr = readFileSync(phase.stderrPath, 'utf8');
      expect(stdout).toBe('phase output'); expect(stderr).toBe('assertion failure');
      expect(JSON.parse(readFileSync(phase.metadataPath, 'utf8'))).toMatchObject({ status: 7, signal: null,
        stdoutSha256: hash(stdout), stderrSha256: hash(stderr) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses a pass when phase diagnostics cannot be retained', () => {
    const f = fixture(); f.write.mockImplementation(() => { throw new Error('disk full'); });
    expect(verifyEngineeringRelease(f.args)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('retained') });
  });
  it('rejects a fresh artifact from a previous executor even with matching pins and hashes', () => {
    const f = fixture();
    const receipt = JSON.stringify({ plane: f.proof.plane, buildSha: f.proof.buildSha,
      manifestSha256: f.proof.manifestSha256, nonce: f.nonce });
    f.read.mockImplementation(path => path === '/fixture/inputs.json' ? f.bytes : receipt);
    f.run.mockReturnValue({ status: 0, stdout: 'ENGINEERING_EVIDENCE_JOURNEY_VERIFIED '
      + JSON.stringify({ ...f.proof, receiptSha256: hash(receipt) }) });
    expect(verifyEngineeringRelease(f.args).status).toBe('unknown');
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { engineeringEvidenceReleaseInstrument } from './engineering-evidence-release-instrument';
// The executable is ordinary Node ESM; exercise its actual orchestration, not a copy.
import { verifyEngineeringRelease } from '../../../../scripts/verify-engineering-evidence-release.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe('exact shipped engineering evidence detector', () => {
  function fixture() {
    const bytes = JSON.stringify({ workspaceId: 'workspace-fixture', clientId: 'session-fixture',
      buildSha: 'a'.repeat(40), promotionReceipt: 'canonical-green-log' });
    const nonce = 'fresh-invocation', receipt = JSON.stringify({ plane: 'final-release', buildSha: 'a'.repeat(40),
      manifestSha256: hash(bytes), nonce });
    const proof = { plane: 'final-release', buildSha: 'a'.repeat(40), manifestSha256: hash(bytes), nonce,
      receiptPath: '/fixture/browser-receipt.json', receiptSha256: hash(receipt) };
    const run = vi.fn((..._args: unknown[]) => ({ status: 0, stdout: 'ENGINEERING_EVIDENCE_JOURNEY_VERIFIED ' + JSON.stringify(proof) }));
    const read = vi.fn((path: string) => path === '/fixture/inputs.json' ? bytes : receipt);
    return { bytes, nonce, proof, run, read, args: { root: '/repository', inputsPath: '/fixture/inputs.json', nonce, run, read, env: {} } };
  }
  it('runs the maintained browser profile and accepts only the freshly emitted artifact and manifest', () => {
    const f = fixture(), result = verifyEngineeringRelease(f.args);
    expect(result.status).toBe('pass');
    expect(f.run.mock.calls[0]?.[0]).toBe('bash');
    expect(f.run.mock.calls[0]?.[1]).toContain('playwright.engineering-evidence.config.ts');
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
    const receipt = JSON.stringify({ plane: 'current-build', buildSha: f.proof.buildSha, manifestSha256: f.proof.manifestSha256, nonce: f.nonce });
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
    expect(write).toHaveBeenCalledOnce();
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
});

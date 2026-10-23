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
});

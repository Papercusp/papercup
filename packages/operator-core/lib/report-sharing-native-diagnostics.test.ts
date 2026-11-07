import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordReportSharingFailure, runReportSharingTestFile } from '../../../scripts/tauri-surface-verify-report-sharing.mts';

const nativeProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: nativeProcess.execFileSync,
}));

describe('report sharing native router custody', () => {
  afterEach(() => nativeProcess.execFileSync.mockReset());

  it('preserves the terminal receipt when router finalization crosses six minutes', () => {
    const phases: string[] = [];
    const env = { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '7200000', PAPERCUSP_TEST_RUN_COMMIT: 'source' };
    nativeProcess.execFileSync.mockImplementation((_command, _args, options) => {
      phases.push('assertions-returned');
      // Model the measured boundary: assertions returned at 280s; provenance
      // needs another 120s. An npm-level 360s timer destroys this receipt.
      if (options.timeout > 0 && options.timeout < 400_000) {
        throw Object.assign(new Error('spawnSync npm ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
      }
      expect(options.env).toEqual(env);
      expect(options.cwd).toBe('/frozen-source');
      phases.push('provenance-persisted', 'router-closed');
    });
    runReportSharingTestFile('/frozen-source', env);
    expect(phases).toEqual(['assertions-returned', 'provenance-persisted', 'router-closed']);
    expect(nativeProcess.execFileSync.mock.calls[0][1]).toEqual([
      'run', 'test:file', '--', 'packages/operator-core/lib/report-sharing-native.e2e.test.ts',
      '--', '--reporter=default', '--reporter=hanging-process', '-t', 'shares the selected harmless edition',
    ]);
  });

  it('propagates a canonical router failure and includes the deployed obligation in final release', () => {
    const failure = Object.assign(new Error('canonical finalization failed'), { status: 3 });
    nativeProcess.execFileSync.mockImplementation(() => { throw failure; });
    expect(() => runReportSharingTestFile('/frozen-source', { PAPERCUSP_REPORT_SHARING_FINAL_RELEASE: '1' }))
      .toThrow(failure);
    expect(nativeProcess.execFileSync.mock.calls[0][1]).not.toContain('-t');
    expect(nativeProcess.execFileSync.mock.calls[0][1]).toContain('--reporter=hanging-process');
  });
});

describe('report sharing native failure evidence', () => {
  it('persists the original failure before reading the pre-cleanup UI and operation', async () => {
    const evidence: Record<string, unknown> = { phase: 'published-local-fixture' };
    const writes: Record<string, unknown>[] = [];
    const original = new Error('shared URL never became ready');
    const diagnosis = { ui: { text: 'Restore the dedicated viewer repository before sharing.' },
      status: { rows: [{ phase: 'inactive' }] } };
    await recordReportSharingFailure(evidence, original, async () => {
      expect(writes).toHaveLength(1);
      expect(writes[0].failure).toMatchObject({ phase: 'published-local-fixture', message: String(original) });
      return diagnosis;
    }, () => writes.push(structuredClone(evidence)));
    expect(writes).toHaveLength(2);
    expect(writes[1].failureDiagnostics).toEqual(diagnosis);
    expect(writes[1].failure).toMatchObject({ message: String(original), stack: original.stack });
  });

  it('retains the journey error when the diagnostic transport also fails', async () => {
    const evidence: Record<string, unknown> = { phase: 'shared' };
    const writes: Record<string, unknown>[] = [];
    await recordReportSharingFailure(evidence, new Error('anonymous reader failed'), async () => {
      throw new Error('native bridge unavailable');
    }, () => writes.push(structuredClone(evidence)));
    expect(writes).toHaveLength(2);
    expect(writes[1].failure).toMatchObject({ phase: 'shared', message: 'Error: anonymous reader failed' });
    expect(writes[1].failureDiagnosticError).toBe('Error: native bridge unavailable');
    expect(writes[1]).not.toHaveProperty('failureDiagnostics');
  });
});

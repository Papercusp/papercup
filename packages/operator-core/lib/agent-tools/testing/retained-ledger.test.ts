import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { captureConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';
import { TestRunArtifactPacket, testRunDeadline } from './run-artifacts';
import { recoverRetainedVitestLedger } from './retained-ledger';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(options: { childState?: 'closed' | 'pending'; passed?: number; runtimeLayer?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'retained-vitest-ledger-')); roots.push(root);
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', join(root, 'retained'));
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'subject.test.ts'), 'export {};');
  const runId = randomUUID();
  const input = { runId, workItemId: 'WI-original', workspaceId: 'workspace', harnessSlug: 'harness' };
  const packet = new TestRunArtifactPacket(runId, source, testRunDeadline(60_000));
  packet.bindNativeIdentity(input.workspaceId, input.harnessSlug);
  packet.captureSelectedSources(['subject.test.ts'], { commit: 'a'.repeat(40), porcelain: ' M subject.test.ts' });
  packet.write('ledger.json', { runGroup: runId, workspace: input.workspaceId, harness: input.harnessSlug,
    workItem: input.workItemId, testNamePattern: null });
  packet.write('router.json', { code: 0, childState: 'closed', signal: null, timedOut: false, aborted: false });
  packet.write('configuration.json', captureConfigurationSnapshot({ NODE_ENV: 'test' }));
  const report = { ...(options.runtimeLayer ? { papercuspRuntime: { schemaVersion: 1, root: source,
    runGroupId: runId, workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
    files: [{ filePath: join(source, 'subject.test.ts'), projectRoot: source, testLayer: options.runtimeLayer }] } } : {}),
    success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
    numTodoTests: 0, numTotalTests: 1, startTime: Date.now() - 100, testResults: [{ name: join(source, 'subject.test.ts'),
    status: 'passed', startTime: Date.now() - 50, endTime: Date.now(),
    assertionResults: [{ status: 'passed', fullName: 'original assertion', title: 'original assertion' }] }] };
  writeFileSync(join(packet.paths.reports, 'report.json'), JSON.stringify(report));
  packet.childState = options.childState ?? 'closed';
  await packet.finish({ result: { ok: true, runId, root: source, passed: options.passed ?? 1,
    failed: 0, skipped: 0, byFile: { 'subject.test.ts': { passed: 1, failed: 0, skipped: 0 } } } });
  return { input: { ...input, directory: packet.paths.directory }, packet, source };
}

describe('retained Vitest ledger recovery', () => {
  it('recovers the child-measured layer from sealed JSON independently of the current environment', async () => {
    const { input } = await fixture({ runtimeLayer: 'integration' });
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'another-run');
    const persist = vi.fn().mockResolvedValue([{ id: 124 }]);
    await recoverRetainedVitestLedger(input, persist);
    expect(persist.mock.calls[0]![0].rows[0].execution).toMatchObject({ passed: 1, testLayer: 'integration' });
    expect(persist.mock.calls[0]![0].rows[0].execution).not.toHaveProperty('passedCaseTitles');
  });
  it('uses verified copies and original scope, counts, start, config and dirty provenance without executing tests', async () => {
    const { input, packet, source } = await fixture();
    writeFileSync(join(packet.paths.reports, 'report.json'), '{"tampered":true}');
    const persist = vi.fn().mockResolvedValue([{ id: 123 }]);
    const result = await recoverRetainedVitestLedger(input, persist);
    expect(result).toMatchObject({ runId: input.runId, root: source, testRunIds: [123], worktreeDirty: true });
    expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runGroupId: input.runId, workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
      root: source, source: 'local', worktreeDirty: true, commit: 'a'.repeat(40),
      configurationSnapshot: captureConfigurationSnapshot({ NODE_ENV: 'test' }),
      rows: [expect.objectContaining({ filePath: 'subject.test.ts', status: 'pass',
        execution: expect.objectContaining({ passed: 1, failed: 0, skipped: 0 }) })],
    }));
  });
  it('refuses a different work item before writing', async () => {
    const { input } = await fixture(); const persist = vi.fn();
    await expect(recoverRetainedVitestLedger({ ...input, workItemId: 'WI-other' }, persist))
      .rejects.toThrow('scope_mismatch');
    expect(persist).not.toHaveBeenCalled();
  });
  it('refuses a different authenticated tenant before writing', async () => {
    const { input } = await fixture(); const persist = vi.fn();
    await expect(recoverRetainedVitestLedger({ ...input, workspaceId: 'other' }, persist)).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });
  it('refuses corrupted retained report bytes before writing', async () => {
    const { input, packet } = await fixture(); const persist = vi.fn();
    const manifest = JSON.parse(readFileSync(packet.paths.manifest, 'utf8'));
    const native = JSON.parse(readFileSync(join(packet.paths.nativeProof, 'objects',
      manifest.nativeCustody.locator.manifest.ref), 'utf8'));
    const pin = native.groups[0].auxiliary.find((row: { role: string }) => row.role === 'reports/report.json').artifact;
    writeFileSync(join(packet.paths.nativeProof, 'objects', pin.ref), '{}');
    await expect(recoverRetainedVitestLedger(input, persist)).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });
  it('refuses a pending child without interpreting retained counts as completion', async () => {
    const { input } = await fixture({ childState: 'pending' }); const persist = vi.fn();
    await expect(recoverRetainedVitestLedger(input, persist)).rejects.toThrow('not_successful_closed_run');
    expect(persist).not.toHaveBeenCalled();
  });
  it('refuses a sealed result whose counts disagree with the report', async () => {
    const { input } = await fixture({ passed: 2 }); const persist = vi.fn();
    await expect(recoverRetainedVitestLedger(input, persist)).rejects.toThrow('result_mismatch');
    expect(persist).not.toHaveBeenCalled();
  });
});

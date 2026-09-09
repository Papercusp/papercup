import { describe, expect, it, vi } from 'vitest';
import { prepareTestEvidence, finishTestEvidence, recoverTestEvidence, testEvidenceOutcome, testEvidenceSchema } from './evidence';
import type { TestFilesCoreResult } from './run';

const runId = 'ca5fce52-7c67-4d38-8c26-96a952f6a2a2';
const scope = { workspaceId: 'ws', harnessSlug: 'h1', actorId: 'su-test', root: '/repo' };
const binding = { specId: 'R-1', specRevision: 2, testPath: 'test/feature.test.ts', sourcePaths: ['src/feature.ts'],
  testLayer: 'unit' as const, scenarioIds: ['happy'], causalPairId: 'original-failure' };
const request = { workItemId: 'WI-1', planSlug: 'p1', bindings: [binding] };
const result = (counts: { passed?: number; failed?: number; skipped?: number; collectionFailed?: boolean } = {}): TestFilesCoreResult => ({
  ok: true, runId, root: '/repo', passed: 1, failed: 0, skipped: 0, files: 1,
  failures: [], failuresTruncated: false, durationMs: 10,
  byFile: { [binding.testPath]: { passed: 1, failed: 0, skipped: 0, collectionFailed: false, ...counts } },
});
const deps = () => ({
  bind: vi.fn().mockResolvedValue({ status: 'created', id: 1 }),
  measure: vi.fn().mockResolvedValue({ sourceFingerprint: 'source-before', testFingerprint: 'test-before' }),
  ledger: vi.fn().mockResolvedValue([{ id: 42, file_path: binding.testPath, status: 'pass', finished_at: '2026-09-08T00:00:00Z' }]),
  list: vi.fn().mockResolvedValue([]),
});

describe('test-time evidence continuity', () => {
  it('persists exact requirement/correction links before execution and adds measured ledger proof afterward', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    expect(d.bind.mock.calls[0][0]).toMatchObject({ workItemId: 'WI-1', specRevision: 2,
      sourceFingerprint: 'source-before', details: { adequacy: { outcome: 'pending', executed: false,
        scenarioIds: ['happy'], causalPairIds: ['original-failure'] } } });
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, result(), d);
    expect(bundle).toMatchObject({ status: 'recorded', acceptance: 'requires-review', total: 1,
      rows: [{ testRunId: 42, outcome: 'pass', phase: 'settled' }] });
    expect(d.bind.mock.calls[1][0]).toMatchObject({ testRunId: 42, sourceFingerprint: 'source-before',
      details: { currentMeasurement: { sourcePaths: ['src/feature.ts'], testPaths: [binding.testPath] },
        adequacy: { collected: true, executed: true, skipped: false, outcome: 'pass' } } });
    expect(d.bind.mock.calls[1][0].details.adequacy).not.toHaveProperty('oracleIndependent');
  });

  it('refuses an unselected test before registering any mapping', async () => {
    const d = deps();
    await expect(prepareTestEvidence(request, runId, ['test/unrelated.test.ts'], scope, d)).rejects.toThrow('evidence_test_not_selected');
    expect(d.bind).not.toHaveBeenCalled();
    expect(() => testEvidenceSchema.parse({ ...request, bindings: [{ ...binding, sourcePaths: ['../secret'] }] })).toThrow();
  });

  it.each([
    [{ passed: 0, collectionFailed: true }, 'error', false],
    [{ passed: 0, skipped: 1, collectionFailed: true }, 'error', false],
    [{ passed: 0, failed: 1 }, 'fail', true],
    [{ passed: 0, skipped: 1 }, 'skip', false],
    [{ passed: 1, skipped: 1 }, 'skip', true],
    [{ passed: 0 }, 'unknown', false],
  ] as const)('never converts an incomplete or failing execution into success: %j', (counts, outcome, executed) => {
    expect(testEvidenceOutcome(binding, result(counts))).toMatchObject({ outcome, executed });
  });

  it('does not turn explicitly name-filtered exclusions into a skipped proof', () => {
    const filtered = { ...result({ passed: 2, skipped: 519 }), testNamePattern: 'P-001' };
    expect(testEvidenceOutcome(binding, filtered)).toMatchObject({ outcome: 'pass', executed: true, skipped: true });
  });

  it('requires the exact declared assertion for a successful counterexample', () => {
    const counterexample = { ...binding, counterexample: { test: 'restores omitted duty', messageIncludes: 'expected delivered' } };
    const failed = result({ passed: 0, failed: 1 });
    if (failed.error) throw new Error('fixture');
    failed.failures = [{ file: binding.testPath, test: 'restores omitted duty', message: 'expected delivered but omitted' }];
    expect(testEvidenceOutcome(counterexample, failed).outcome).toBe('killed');
    failed.failures[0].test = 'unrelated failure';
    expect(testEvidenceOutcome(counterexample, failed).outcome).toBe('fail');
  });

  it.each([
    [{ passed: 0, collectionFailed: true }, 'error'],
    [{ passed: 0, skipped: 1 }, 'skip'],
    [{ passed: 0 }, 'unknown'],
  ] as const)('preserves an unexecuted counterexample outcome: %j', (counts, outcome) => {
    const counterexample = { ...binding, counterexample: { test: 'target assertion', messageIncludes: 'expected' } };
    expect(testEvidenceOutcome(counterexample, result(counts))).toMatchObject({ outcome, executed: false });
  });

  it.each([null, [], [{ id: 98, file_path: 'other.test.ts', status: 'pass', finished_at: 'now' }]])('keeps missing/unreadable/misattributed ledger proof pending', async ledger => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    d.ledger.mockResolvedValue(ledger);
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, result(), d);
    expect(bundle.rows[0]).toMatchObject({ testRunId: null, phase: 'pending', outcome: 'unknown' });
  });

  it('retains the original fingerprint when files change during execution', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    d.measure.mockResolvedValue({ sourceFingerprint: 'changed', testFingerprint: 'test-before' });
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, result(), d);
    expect(bundle.rows[0].phase).toBe('source-changed');
    expect(d.bind.mock.calls[1][0].sourceFingerprint).toBe('source-before');
  });

  it('rehydrates recorded mappings after a timeout without claiming unmeasured collection/skip details', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const detached = '1a40bd16-98ca-4092-8b88-5707ed6e0e64';
    await finishTestEvidence(prepared, runId, detached, scope, { ok: false, runId, root: '/repo', error: 'timeout' }, d);
    const stored = d.bind.mock.calls[1][0];
    d.list.mockResolvedValue([{ ...stored, id: 2,
      fingerprints: { sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1', originRunId: runId, runId: detached }, scope, d);
    expect(bundle.rows[0]).toMatchObject({ testRunId: 42, phase: 'review-required', outcome: 'unknown' });
    expect(d.bind.mock.calls[2][0].details.adequacy.executed).toBe(false);
    await expect(recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1', originRunId: runId,
      runId: 'faf310d9-ea4e-498c-be6b-6773fe46a276' }, scope, d)).rejects.toThrow('evidence_recovery_not_found');
  });

  it.each([{ id: 42, status: 'fail' }, { id: 43, status: 'pass' }])(
    'invalidates settled passing recovery when ledger attribution changes: %j', async changed => {
      const d = deps();
      const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
      await finishTestEvidence(prepared, runId, runId, scope, result(), d);
      const stored = d.bind.mock.calls[1][0];
      d.list.mockResolvedValue([{ ...stored, id: 2,
        fingerprints: { sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
      const recovery = { workItemId: 'WI-1', planSlug: 'p1', originRunId: runId, runId };
      expect((await recoverTestEvidence(recovery, scope, d)).rows[0])
        .toMatchObject({ testRunId: 42, phase: 'settled', outcome: 'pass' });
      d.ledger.mockResolvedValue([{ ...changed, file_path: binding.testPath, finished_at: 'now' }]);
      expect((await recoverTestEvidence(recovery, scope, d)).rows[0])
        .toMatchObject({ testRunId: changed.id, phase: 'review-required', outcome: 'unknown' });
      expect(d.bind.mock.calls.at(-1)![0].details.adequacy.executed).toBe(false);
    },
  );

  const detached = '1a40bd16-98ca-4092-8b88-5707ed6e0e64';
  const measured = { schemaVersion: 1, root: scope.root, filePath: binding.testPath,
    workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: detached,
    testNamePattern: null, passed: 2, failed: 0, skipped: 0, collectionFailed: false };
  async function pendingRecovery(detail: unknown, status = 'pass', sourceChanged = false) {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    await finishTestEvidence(prepared, runId, detached, scope,
      { ok: false, runId, root: scope.root, error: 'timeout' }, d);
    const stored = d.bind.mock.calls.at(-1)![0];
    d.list.mockResolvedValue([{ ...stored, id: 2, fingerprints: {
      sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
    d.ledger.mockResolvedValue([{ id: 42, file_path: binding.testPath, status,
      finished_at: '2026-09-09T00:00:00Z', execution_details: detail }]);
    if (sourceChanged) d.measure.mockResolvedValue({ sourceFingerprint: 'changed', testFingerprint: 'test-before' });
    return { d, bundle: await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId: detached }, scope, d) };
  }
  it('settles a recovered run from complete measured details, not its pass status', async () => {
    const { bundle } = await pendingRecovery(measured);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42 });
    expect(bundle.verificationFingerprint).toBeTruthy();
  });
  it.each([
    [{ skipped: 1 }, 'pass', 'skip'],
    [{ passed: 0, failed: 1 }, 'fail', 'fail'],
    [{ passed: 0, skipped: 1, collectionFailed: true }, 'fail', 'error'],
    [{ passed: 0 }, 'pass', 'unknown'],
  ])('preserves measured non-passing recovery %j', async (delta, status, outcome) => {
    const { bundle } = await pendingRecovery({ ...measured, ...delta }, status);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome });
  });
  it.each([
    null, {}, { ...measured, skipped: undefined }, { ...measured, passed: -1 },
    { ...measured, workspaceId: 'other' }, { ...measured, harnessSlug: 'other' },
    { ...measured, runGroupId: runId }, { ...measured, root: '/other' },
    { ...measured, filePath: 'other.test.ts' }, { ...measured, collectionFailed: true },
  ])('keeps missing, malformed, contradictory or wrong-scope details unproven: %j', async detail => {
    const { bundle } = await pendingRecovery(detail);
    expect(bundle.rows[0]).toMatchObject({ phase: 'review-required', outcome: 'unknown' });
    expect(bundle.verificationFingerprint).toBeNull();
  });
  it('does not make measured recovery source-current after a source edit', async () => {
    const { bundle } = await pendingRecovery(measured, 'pass', true);
    expect(bundle.rows[0].phase).toBe('source-changed');
    expect(bundle.verificationFingerprint).toBeNull();
  });
});

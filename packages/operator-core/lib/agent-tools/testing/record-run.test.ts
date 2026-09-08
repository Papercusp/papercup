import { describe, expect, it, vi } from 'vitest';
import {
  parseOperationalEvidenceArtifact,
  recordOperationalRun,
  type CommittedOperationalEvidence,
  type RecordOperationalRunDeps,
} from './record-run';

const ARTIFACT = {
  schemaVersion: 1 as const,
  kind: 'operational-test-evidence' as const,
  name: 'two-host chat parity',
  framework: 'playwright' as const,
  command: ['node', 'driver.mjs'],
  exitCode: 0,
  startedAt: '2026-09-08T02:01:00.000Z',
  finishedAt: '2026-09-08T02:05:00.000Z',
  summary: 'Desktop and portal assertions passed.',
  assertions: [
    { id: 'desktop', passed: true, evidence: 'desktop marker' },
    { id: 'portal', passed: true, evidence: 'portal marker' },
  ],
};

const EVIDENCE: CommittedOperationalEvidence = {
  artifact: ARTIFACT,
  filePath: 'docs/evidence/p013-run.json',
  sha256: 'a'.repeat(64),
  commit: 'b'.repeat(40),
};

function deps(overrides: Partial<RecordOperationalRunDeps> = {}): RecordOperationalRunDeps {
  return {
    inspectEvidence: vi.fn(() => EVIDENCE),
    findIds: vi.fn(async () => []),
    persist: vi.fn(async () => ({ written: 1, ids: [77] })),
    ...overrides,
  };
}

describe('testing:record-run', () => {
  it('derives a pass, persists through the shared writer, and returns numeric IDs', async () => {
    const d = deps();
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toMatchObject({ ok: true, alreadyRecorded: false, status: 'pass', testRunIds: [77] });
    expect(d.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessSlug: 'papercusp',
        workspaceId: 'papercusp-workspace',
        runGroupId: `operational:${'a'.repeat(40)}`,
        commit: 'b'.repeat(40),
        worktreeDirty: false,
        rows: [expect.objectContaining({ framework: 'playwright', status: 'pass', durationMs: 240_000 })],
      }),
    );
  });

  it('is idempotent when the artifact hash already has a scoped row', async () => {
    const persist = vi.fn(async () => ({ written: 1, ids: [99] }));
    const d = deps({ findIds: vi.fn(async () => [41]), persist });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toMatchObject({ ok: true, alreadyRecorded: true, testRunIds: [41] });
    expect(persist).not.toHaveBeenCalled();
  });

  it('derives a failure from either a non-zero exit or a failed assertion', async () => {
    const failedEvidence: CommittedOperationalEvidence = {
      ...EVIDENCE,
      artifact: { ...ARTIFACT, assertions: [{ id: 'portal', passed: false, evidence: 'missing card' }] },
    };
    const d = deps({ inspectEvidence: vi.fn(() => failedEvidence) });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toMatchObject({ ok: true, status: 'fail' });
    expect(d.persist).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [expect.objectContaining({ status: 'fail' })] }),
    );
  });

  it('rejects malformed or temporally inverted evidence artifacts', () => {
    expect(() => parseOperationalEvidenceArtifact(Buffer.from('{}'))).toThrow('evidence_schema_invalid');
    expect(() =>
      parseOperationalEvidenceArtifact(
        Buffer.from(JSON.stringify({ ...ARTIFACT, finishedAt: '2026-09-08T01:00:00.000Z' })),
      ),
    ).toThrow('evidence_time_order_invalid');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_OPERATIONAL_EVIDENCE_BYTES,
  inspectCommittedOperationalEvidence,
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

const MUTATION_PROBE = {
  schemaVersion: 1 as const,
  runnerPath: 'scripts/mutation-probe.sh',
  runnerSha256: 'c'.repeat(64),
  runnerCommit: 'd'.repeat(40),
  cwd: '.',
  argv: [
    '--file',
    'packages/operator-core/lib/agent-tools/testing/record-run.ts',
    '--mutate',
    's/return result.data/return null/',
    '--test',
    'npm run test:file -- packages/operator-core/lib/agent-tools/testing/record-run.test.ts',
  ],
  result: {
    verdict: 'caught' as const,
    expected: 'caught' as const,
    target: 'copy-out',
    baselineExit: 0,
    guardExit: 1,
    mutantParse: 'ok',
    assertionEvidence: 'assertion-failure',
    relocation: 'overlay',
  },
};

function mutationEvidence(command = ['scripts/mutation-probe.sh']) {
  return {
    ...ARTIFACT,
    command,
    summary: 'Mutation-probe runner rejected the mutation as expected.',
    assertions: [{ id: 'mutation-caught', passed: true, evidence: 'MUTATION_PROBE_RESULT verdict=caught' }],
    mutationProbes: [{ ...MUTATION_PROBE, argv: [...MUTATION_PROBE.argv] }],
  };
}

function deps(overrides: Partial<RecordOperationalRunDeps> = {}): RecordOperationalRunDeps {
  return {
    inspectEvidence: vi.fn(() => EVIDENCE),
    findIds: vi.fn(async () => []),
    persist: vi.fn(async () => ({ written: 1, ids: [77] })),
    ...overrides,
  };
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  return (result.stdout ?? '').trim();
}

describe('testing:record-run', () => {
  it('derives a pass, persists through the shared writer, and returns numeric IDs', async () => {
    const inspectEvidence = vi.fn(async () => EVIDENCE);
    const d = deps({ inspectEvidence });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toMatchObject({ ok: true, alreadyRecorded: false, status: 'pass', testRunIds: [77] });
    expect(inspectEvidence).toHaveBeenCalledTimes(1);
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

  it('requires exact per-probe replay metadata for mutation-probe evidence', () => {
    const { mutationProbes: _mutationProbes, ...withoutReplay } = mutationEvidence();
    expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(withoutReplay))))
      .toThrow('evidence_mutation_probe_replay_required');
    expect(parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(mutationEvidence()))))
      .toMatchObject({ mutationProbes: [MUTATION_PROBE] });
  });

  it('rejects mutable shared scratch command references even when replay argv is present', () => {
    const artifact = mutationEvidence(['bash .papercusp/scratch/p009-probes.sh']);
    expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(artifact))))
      .toThrow('evidence_mutation_probe_scratch_command_invalid');
  });

  it('rejects replay metadata without the exact file, mutation, and guard inputs', () => {
    const artifact = mutationEvidence();
    artifact.mutationProbes[0].argv = ['--file', 'src/file.ts', '--test', 'vitest run'];
    expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(artifact))))
      .toThrow('evidence_mutation_probe_replay_incomplete');
  });

  it('verifies replay records against the pinned runner commit or the artifact commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'record-run-replay-'));
    const runnerPath = 'scripts/mutation-probe.sh';
    const evidencePath = 'docs/evidence/mutation-run.json';
    const runnerBytes = Buffer.from('#!/usr/bin/env bash\nprintf runner\\n\n');
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'docs/evidence'), { recursive: true });
      writeFileSync(join(root, runnerPath), runnerBytes);
      git(root, ['init', '-q']);
      git(root, ['config', 'user.email', 'record-run-test@example.invalid']);
      git(root, ['config', 'user.name', 'record-run-test']);
      git(root, ['add', runnerPath]);
      git(root, ['commit', '-qm', 'runner source']);
      const runnerCommit = git(root, ['rev-parse', 'HEAD']);
      const artifactRunnerBytes = Buffer.from('runner source v2');
      writeFileSync(join(root, runnerPath), artifactRunnerBytes);
      git(root, ['add', runnerPath]);
      git(root, ['commit', '-qm', 'updated runner source']);
      const runnerSha256 = createHash('sha256').update(artifactRunnerBytes).digest('hex');
      const artifact = {
        ...mutationEvidence(),
        mutationProbes: [{ ...MUTATION_PROBE, runnerCommit, runnerSha256 }],
      };

      const commitArtifact = async (value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value));
        writeFileSync(join(root, evidencePath), bytes);
        git(root, ['add', evidencePath]);
        git(root, ['commit', '-qm', 'mutation evidence']);
        return createHash('sha256').update(bytes).digest('hex');
      };

      const validSha = await commitArtifact(artifact);
      await expect(inspectCommittedOperationalEvidence(root, evidencePath, validSha)).resolves.toMatchObject({
        artifact: { mutationProbes: [{ runnerCommit, runnerSha256 }] },
      });

      const invalidSha = await commitArtifact({
        ...artifact,
        mutationProbes: [{ ...MUTATION_PROBE, runnerCommit, runnerSha256: 'e'.repeat(64) }],
      });
      await expect(inspectCommittedOperationalEvidence(root, evidencePath, invalidSha))
        .rejects.toThrow('evidence_mutation_probe_runner_sha256_mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the size, byte cap, and raw-artifact remedy for oversized evidence without persisting it', async () => {
    const actualBytes = MAX_OPERATIONAL_EVIDENCE_BYTES + 17;
    const expectedError =
      `evidence_too_large: ${actualBytes} bytes exceeds the ${MAX_OPERATIONAL_EVIDENCE_BYTES}-byte limit. ` +
      'Store bulky payloads as a raw artifact pinned by SHA-256 and keep the docs/evidence JSON small.';
    const d = deps({
      inspectEvidence: vi.fn(async () => {
        parseOperationalEvidenceArtifact(Buffer.alloc(actualBytes));
        return EVIDENCE;
      }),
    });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toEqual({ ok: false, error: expectedError });
    expect(d.findIds).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('names every failing field path in evidence_schema_invalid (WI-10003460)', () => {
    const { startedAt: _startedAt, finishedAt: _finishedAt, ...withoutTimestamps } = ARTIFACT;
    let message = '';
    try {
      parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(withoutTimestamps)));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^evidence_schema_invalid: /);
    expect(message).toContain('startedAt: ');
    expect(message).toContain('finishedAt: ');
    const nested = { ...ARTIFACT, assertions: [{ id: 'a', passed: 'yes', evidence: 'e' }] };
    expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(nested))))
      .toThrow('assertions.0.passed: ');
  });
});

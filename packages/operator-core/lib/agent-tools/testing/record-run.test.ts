import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBoxIdentityPaths, redactIdentityLeaks } from '../../../../../scripts/lib/identity-leak-patterns.mjs';
import {
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  parseTestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';
import {
  MAX_OPERATIONAL_EVIDENCE_BYTES,
  inspectCommittedOperationalEvidence,
  operationalExecution,
  parseOperationalEvidenceArtifact,
  recordOperationalRun,
  recoverArchivedMutationFailures,
  type ArchivedMutationRun,
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
  runnerPath: 'scripts/mutation-probe.sh' as const,
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

function archivedMutationFixture() {
  const filePath = 'packages/operator-core/example.integration.test.ts';
  const scope = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' };
  const titles = ['suite > long DOM failure', 'suite > literal "quoted": failure'];
  const probe = { ...MUTATION_PROBE, result: { ...MUTATION_PROBE.result,
    assertionEvidence: 'test-file-assertion-failure' } };
  const original: ArchivedMutationRun = {
    id: 42, file_path: filePath, source: 'mutation-probe', status: 'fail', framework: 'vitest',
    workspace_id: scope.workspaceId, harness_slug: scope.harnessSlug,
    commit_sha: probe.runnerCommit, worktree_dirty: false,
    started_at: ARTIFACT.startedAt, finished_at: ARTIFACT.finishedAt,
    execution_details: { schemaVersion: 1, root: '/immutable', filePath, runGroupId: null,
      ...scope, testNamePattern: null, testLayer: 'integration', mutationPhase: 'mutant',
      commitSha: probe.runnerCommit, worktreeDirty: false,
      passed: 1, failed: 2, skipped: 0, collectionFailed: false },
  };
  const archiveLog = [
    'TEST_FILE_PROVENANCE head=dddddddddd testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-09-08T02:00:00.000Z',
    ...titles.map(title => `TEST_FILE_ASSERTION_FAILURE file=${JSON.stringify(`/immutable/${filePath}`)} name=${JSON.stringify(title)} message=${JSON.stringify('<aside>'.repeat(1500))}`),
    '      Tests  2 failed | 1 passed (3)',
    'TEST_FILE_PROVENANCE head=dddddddddd testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-09-08T02:06:00.000Z',
    'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=dddddddddd uncommittedPaths=0/1 provenance=stamped startedAt=2026-09-08T02:00:00.000Z skippedTests=0',
    `MUTATION_PROBE_EVIDENCE_JSON=${JSON.stringify(probe)}`,
  ].join('\n');
  const evidence: CommittedOperationalEvidence = { ...EVIDENCE, archiveLog,
    artifact: { ...ARTIFACT, framework: 'shell', mutationProbes: [probe], archivedMutation: {
      originalTestRunId: 42, rawLogFile: 'docs/evidence/mutation.log',
      rawLogSha256: createHash('sha256').update(archiveLog).digest('hex'),
    } } };
  return { evidence, original, scope, titles };
}

describe('archived mutation identity recovery (EI-25248905256718690)', () => {
  it('reads hash-pinned historical bytes after publishing a portable log, without changing receipt identity', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'record-archived-publication-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.email', 'test@example.invalid']);
      git(repo, ['config', 'user.name', 'Test']);
      mkdirSync(join(repo, 'docs/evidence'), { recursive: true });
      mkdirSync(join(repo, 'scripts'));
      const runner = '#!/bin/sh\nexit 0\n';
      writeFileSync(join(repo, 'scripts/mutation-probe.sh'), runner);
      const { evidence, original, scope, titles } = archivedMutationFixture();
      const privatePath = ['file:', '', 'home', 'archive-writer', 'runner.js'].join('/');
      const runnerSha256 = createHash('sha256').update(runner).digest('hex');
      const raw = `${evidence.archiveLog!.replace(MUTATION_PROBE.runnerSha256, runnerSha256)}\n    at ${privatePath}:1:2\n`;
      writeFileSync(join(repo, 'docs/evidence/mutation.log'), raw);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'original raw proof']);
      const rawLogCommit = git(repo, ['rev-parse', 'HEAD']);
      const publicView = redactIdentityLeaks(raw, []);
      expect(findBoxIdentityPaths(raw)).not.toHaveLength(0);
      expect(findBoxIdentityPaths(publicView)).toHaveLength(0);
      expect(publicView).not.toBe(raw);
      writeFileSync(join(repo, 'docs/evidence/mutation.log'), publicView);
      const artifact = { ...evidence.artifact,
        mutationProbes: evidence.artifact.mutationProbes!.map(probe => ({ ...probe,
          runnerSha256 })),
        archivedMutation: { ...evidence.artifact.archivedMutation!, rawLogCommit,
          rawLogSha256: createHash('sha256').update(raw).digest('hex') },
      };
      const publish = (value: typeof artifact) => {
        const bytes = JSON.stringify(value);
        writeFileSync(join(repo, 'docs/evidence/archive.json'), bytes);
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'portable publication']);
        return createHash('sha256').update(bytes).digest('hex');
      };
      const hash = publish(artifact);
      const loaded = await inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', hash);
      expect(loaded.archiveLog).toBe(raw);
      const saved = structuredClone(original);
      expect(recoverArchivedMutationFailures(loaded, original, scope).titles)
        .toEqual(titles);
      expect(original).toEqual(saved);
      expect(git(repo, ['show', `${rawLogCommit}:docs/evidence/mutation.log`])).toBe(raw.trim());
      const badHash = publish({ ...artifact, archivedMutation: { ...artifact.archivedMutation,
        rawLogSha256: createHash('sha256').update(publicView).digest('hex') } });
      await expect(inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', badHash))
        .rejects.toThrow('evidence_archive_sha256_mismatch');
      const unavailable = publish({ ...artifact, archivedMutation: { ...artifact.archivedMutation,
        rawLogCommit: 'e'.repeat(40) } });
      await expect(inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', unavailable))
        .rejects.toThrow('evidence_archive_commit_unavailable');
      const unsafe = { ...artifact, archivedMutation: { ...artifact.archivedMutation, rawLogCommit: 'HEAD' } };
      expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(unsafe))))
        .toThrow('archivedMutation.rawLogCommit');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('requires the archive hash and exact committed log bytes before reading a receipt', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'record-archived-mutation-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.email', 'test@example.invalid']);
      git(repo, ['config', 'user.name', 'Test']);
      mkdirSync(join(repo, 'docs/evidence'), { recursive: true });
      mkdirSync(join(repo, 'scripts'));
      const runner = '#!/bin/sh\nexit 0\n';
      writeFileSync(join(repo, 'scripts/mutation-probe.sh'), runner);
      const { evidence } = archivedMutationFixture();
      const artifact = { ...evidence.artifact, mutationProbes: evidence.artifact.mutationProbes!.map(probe => ({
        ...probe, runnerSha256: createHash('sha256').update(runner).digest('hex'),
      })) };
      const artifactBytes = JSON.stringify(artifact);
      const hash = createHash('sha256').update(artifactBytes).digest('hex');
      writeFileSync(join(repo, 'docs/evidence/archive.json'), artifactBytes);
      writeFileSync(join(repo, 'docs/evidence/mutation.log'), evidence.archiveLog!);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'archive fixture']);
      expect(await inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', hash))
        .toMatchObject({ archiveLog: evidence.archiveLog });
      writeFileSync(join(repo, 'docs/evidence/mutation.log'), 'tampered');
      await expect(inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', hash))
        .rejects.toThrow('evidence_archive_sha256_mismatch');
      const changedArtifact = { ...artifact, archivedMutation: { ...artifact.archivedMutation!,
        rawLogSha256: createHash('sha256').update('tampered').digest('hex') } };
      const changedBytes = JSON.stringify(changedArtifact);
      writeFileSync(join(repo, 'docs/evidence/archive.json'), changedBytes);
      // Only commit the JSON: a matching hash must not certify an uncommitted raw log.
      git(repo, ['add', 'docs/evidence/archive.json']);
      git(repo, ['commit', '-qm', 'changed artifact fixture']);
      await expect(inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json',
        createHash('sha256').update(changedBytes).digest('hex'))).rejects.toThrow('evidence_archive_not_committed');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('recovers exact machine identities despite long DOM messages and preserves the original receipt', async () => {
    const { evidence, original, scope, titles } = archivedMutationFixture();
    const saved = structuredClone(original);
    const d = deps({ inspectEvidence: vi.fn(() => evidence), readArchivedRun: vi.fn(async () => original) });
    const result = await recordOperationalRun({ evidenceFile: evidence.filePath, expectedSha256: evidence.sha256,
      harness: scope.harnessSlug }, { ...scope, projectDir: process.cwd() }, d);
    expect(result).toMatchObject({ ok: true, status: 'fail', recoveredFromTestRunId: 42, testRunIds: [77] });
    expect(d.readArchivedRun).toHaveBeenCalledWith(42, scope);
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ source: 'mutation-probe',
      root: '/immutable', commit: original.commit_sha, worktreeDirty: false,
      rows: [expect.objectContaining({ filePath: original.file_path, status: 'fail',
        outputTail: expect.stringContaining('No new test execution.'),
        execution: { passed: 1, failed: 2, skipped: 0, collectionFailed: false,
          testLayer: 'integration', failedCaseTitles: titles } })] }));
    expect(original).toEqual(saved);
  });

  it('returns the existing recovery record without inserting a second one', async () => {
    const { evidence, original, scope } = archivedMutationFixture();
    const d = deps({ inspectEvidence: vi.fn(() => evidence), readArchivedRun: vi.fn(async () => original),
      findIds: vi.fn(async () => [88]) });
    expect(await recordOperationalRun({ evidenceFile: evidence.filePath, expectedSha256: evidence.sha256,
      harness: scope.harnessSlug }, scope, d)).toMatchObject({ ok: true, alreadyRecorded: true, testRunIds: [88] });
    expect(d.persist).not.toHaveBeenCalled();
  });

  it.each([
    ['missing receipt', (r: ArchivedMutationRun) => null],
    ['wrong id', (r: ArchivedMutationRun) => ({ ...r, id: 43 })],
    ['wrong workspace', (r: ArchivedMutationRun) => ({ ...r, workspace_id: 'elsewhere' })],
    ['wrong harness', (r: ArchivedMutationRun) => ({ ...r, harness_slug: 'elsewhere' })],
    ['ordinary failed run', (r: ArchivedMutationRun) => ({ ...r, source: 'local' })],
    ['successful run', (r: ArchivedMutationRun) => ({ ...r, status: 'pass' })],
    ['dirty execution', (r: ArchivedMutationRun) => ({ ...r, worktree_dirty: true })],
    ['different commit', (r: ArchivedMutationRun) => ({ ...r, commit_sha: 'e'.repeat(40) })],
    ['malformed measurement', (r: ArchivedMutationRun) => ({ ...r, execution_details: {} })],
    ['different time window', (r: ArchivedMutationRun) => ({ ...r, finished_at: '2026-09-09T02:00:00.000Z' })],
  ])('refuses %s before inserting evidence', async (_name, change) => {
    const { evidence, original, scope } = archivedMutationFixture();
    const d = deps({ inspectEvidence: vi.fn(() => evidence), readArchivedRun: vi.fn(async () => change(original)) });
    expect(await recordOperationalRun({ evidenceFile: evidence.filePath, expectedSha256: evidence.sha256,
      harness: scope.harnessSlug }, scope, d)).toMatchObject({ ok: false });
    expect(d.persist).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign file', (s: string) => s.replace('/immutable/packages/', '/foreign/packages/')],
    ['missing failure', (s: string) => s.split('\n').filter(line => !line.includes('literal')).join('\n')],
    ['misleading DOM identity', (s: string) => s.replace('name="suite > long DOM failure"', 'name="<aside>"')],
    ['wrong counts', (s: string) => s.replace('2 failed | 1 passed', '2 failed | 2 passed')],
    ['unproven verdict', (s: string) => s.replace('provenance=stamped', 'provenance=unknown')],
    ['different probe', (s: string) => s.replace('"guardExit":1', '"guardExit":0')],
  ])('rejects %s from a saved log', (_name, change) => {
    const { evidence, original, scope } = archivedMutationFixture();
    // A changed, syntactically valid title must not disagree with prior structured identities.
    const receipt = { ...original, execution_details: { ...(original.execution_details as object),
      failedCaseTitles: archivedMutationFixture().titles } };
    expect(() => recoverArchivedMutationFailures({ ...evidence, archiveLog: change(evidence.archiveLog!) }, receipt, scope)).toThrow();
  });
});

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

  it('persists an execution contract the shared ledger parser accepts (WI-10007016)', async () => {
    const d = deps({ inspectEvidence: vi.fn(async () => EVIDENCE) });
    await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );
    const params = vi.mocked(d.persist).mock.calls[0]![0];
    // Without BOTH root and row.execution the shared writer stores NULL execution_details.
    expect(typeof params.root).toBe('string');
    expect(params.root!.length).toBeGreaterThan(0);
    const row = params.rows[0]!;
    expect(row.execution).toMatchObject({
      passed: ARTIFACT.assertions.length, failed: 0, skipped: 0, collectionFailed: false,
    });
    const parsed = parseTestRunExecutionDetails({
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: params.root, filePath: row.filePath, runGroupId: params.runGroupId,
      workspaceId: params.workspaceId, harnessSlug: params.harnessSlug, testNamePattern: null,
      ...row.execution, mutationPhase: null, commitSha: params.commit, worktreeDirty: params.worktreeDirty,
    });
    expect(parsed).toBeDefined();
  });

  it('counts failing assertions and an unexplained nonzero exit as failed cases', () => {
    const ok = { id: 'ok', passed: true, evidence: 'held' };
    expect(operationalExecution({ ...ARTIFACT, exitCode: 1, assertions: [ok, { id: 'bad', passed: false, evidence: 'no' }] }))
      .toMatchObject({ passed: 1, failed: 1, failedCaseTitles: ['bad'] });
    expect(operationalExecution({ ...ARTIFACT, exitCode: 2, assertions: [ok] }))
      .toMatchObject({ passed: 1, failed: 1, failedCaseTitles: ['nonzero-exit-2'] });
    expect(operationalExecution({ ...ARTIFACT, exitCode: 0, assertions: [ok] })).not.toHaveProperty('failedCaseTitles');
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

  // EI-25254538716868224: classify by the runner's signatures, never by the phrase "mutation probe".
  it('requires replay metadata whenever the artifact carries scripts/mutation-probe.sh signatures', () => {
    const { mutationProbes: _replay, ...base } = mutationEvidence();
    const quiet = { ...base, summary: 'Guard rejected the mutant.', assertions: [{ id: 'm', passed: true, evidence: 'guard failed' }] };
    const variants = [
      { ...quiet, command: ['bash', 'scripts/mutation-probe.sh', '--file', 'a.ts'] },
      { ...quiet, command: ['./mutation-probe.sh'] },
      { ...quiet, command: ['node', 'x.mjs'], assertions: [{ id: 'm', passed: true, evidence: 'MUTATION_PROBE_RESULT verdict=caught' }] },
      { ...quiet, command: ['node', 'x.mjs'], summary: 'MUTATION_PROBE_EVIDENCE_JSON={"verdict":"caught"}' },
      { ...quiet, command: ['node', 'x.mjs'], summary: 'Ran scripts/mutation-probe.sh in copy-out mode.' },
    ];
    for (const variant of variants) {
      expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(variant))))
        .toThrow('evidence_mutation_probe_replay_required');
    }
  });

  it('does not demand a mutation-probe.sh replay for evidence that merely names a branch or CI label', () => {
    const ciMutant = {
      ...ARTIFACT,
      framework: 'operational' as const,
      command: ['gh', 'workflow', 'run', 'ci.yml', '--ref', 'mutation-probe/p015-offline-message'],
      summary: 'macOS CI mutation probe: the Swift mutant on branch mutation-probe/p015-offline-message was caught.',
      assertions: [{ id: 'caught', passed: true, evidence: "job concluded failure with 'MUTATION_PROBE unit=failure ui=failure'" }],
    };
    const parsed = parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(ciMutant)));
    expect(parsed.mutationProbes).toBeUndefined();
    expect(parsed.command).toContain('mutation-probe/p015-offline-message');
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

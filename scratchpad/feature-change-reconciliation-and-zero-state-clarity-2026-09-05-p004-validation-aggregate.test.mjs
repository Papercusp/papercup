import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  'feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p004-validation-aggregate.mjs',
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlobSha(value) {
  const bytes = Buffer.from(value);
  return createHash('sha1')
    .update(Buffer.from('blob ' + bytes.length + '\0'))
    .update(bytes)
    .digest('hex');
}

function runAggregate(
  directory,
  assignments,
  ledger,
  expectedShards,
  expectedCandidates,
  { assignmentDocument, maxAssignmentAgeMs } = {},
) {
  const assignmentsPath = join(directory, 'assignments.json');
  const ledgerPath = join(directory, 'ledger.json');
  writeFileSync(
    assignmentsPath,
    JSON.stringify(
      assignmentDocument ?? {
        capturedAt: new Date().toISOString(),
        sourceIdentity: {
          kind: 'test-work-items-export',
          scope: 'p004-aggregate-test',
          revision: 'fixture-v1',
        },
        rows: assignments,
      },
    ),
  );
  writeFileSync(ledgerPath, JSON.stringify({ entries: ledger }));
  const args = [
    script,
    '--assignments',
    assignmentsPath,
    '--ledger',
    ledgerPath,
    '--artifacts',
    directory,
    '--expected-shards',
    String(expectedShards),
    '--expected-candidates',
    String(expectedCandidates),
  ];
  if (maxAssignmentAgeMs != null) {
    args.push('--max-assignment-age-ms', String(maxAssignmentAgeMs));
  }
  const result = spawnSync(
    process.execPath,
    args,
    { encoding: 'utf8' },
  );
  return { ...result, output: JSON.parse(result.stdout) };
}

test('missing assignment freshness proof is unknown and cannot expose row states', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p004-aggregate-unknown-'));
  try {
    const result = runAggregate(directory, [], [], 0, 0, {
      assignmentDocument: { rows: [] },
    });

    assert.equal(result.status, 1);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.verdict, 'unknown');
    assert.equal(result.output.readiness.verdict, 'unknown');
    assert.deepEqual(result.output.assignmentFreshness.reasons, [
      'assignment-capture-timestamp-missing',
      'assignment-source-identity-missing',
    ]);
    assert.equal(result.output.statusCounts, null);
    assert.deepEqual(result.output.shards, []);
    assert.deepEqual(result.output.errors, [
      {
        code: 'assignment-freshness-unknown',
        reasons: [
          'assignment-capture-timestamp-missing',
          'assignment-source-identity-missing',
        ],
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stale assignment freshness proof is unknown even with a complete source identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p004-aggregate-stale-'));
  try {
    const result = runAggregate(directory, [], [], 0, 0, {
      assignmentDocument: {
        capturedAt: new Date(Date.now() - 60_000).toISOString(),
        sourceIdentity: {
          kind: 'test-work-items-export',
          scope: 'p004-aggregate-test',
          revision: 'fixture-v1',
        },
        rows: [],
      },
      maxAssignmentAgeMs: 1_000,
    });

    assert.equal(result.status, 1);
    assert.equal(result.output.verdict, 'unknown');
    assert.deepEqual(result.output.assignmentFreshness.reasons, ['assignment-source-stale']);
    assert.deepEqual(result.output.readiness.unknownReason, 'Assignment freshness proof is missing or stale; row states are not authoritative.');
    assert.deepEqual(result.output.shards, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an internally consistent partial cohort is not reported ready or ok', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p004-aggregate-incomplete-'));
  try {
    const assignments = [1, 2].map((shard) => ({
      feature_id: 'WI-' + shard,
      status: 'open',
      payload: {
        shard,
        candidateIds: ['EI-' + shard],
        resultPath: join(
          directory,
          'feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p004-validation-shard-' +
            String(shard).padStart(2, '0') +
            '.json',
        ),
      },
    }));
    const ledger = [1, 2].map((shard) => ({
      id: 'EI-' + shard,
      sourceSha256: 'source-' + shard,
      outcome: 'candidate-no-longer-relevant',
    }));

    const result = runAggregate(directory, assignments, ledger, 2, 2);

    assert.equal(result.status, 1);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.readiness.ready, false);
    assert.deepEqual(result.output.readiness.missingArtifactShards, [1, 2]);
    assert.deepEqual(result.output.readiness.nonTerminalShards, [1, 2]);
    assert.deepEqual(
      result.output.errors.map(({ code }) => code),
      [
        'artifact-shard-coverage-incomplete',
        'terminal-shard-coverage-incomplete',
        'validated-artifact-coverage-incomplete',
      ],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a complete terminal cohort with a validated artifact remains green', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p004-aggregate-complete-'));
  try {
    const candidateId = 'EI-1';
    const artifactPath = join(
      directory,
      'feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p004-validation-shard-01.json',
    );
    const artifact = {
      schemaVersion: 'feature-change-p004-validation-shard-v1',
      shard: 1,
      readOnlyValidation: true,
      assignedIds: [candidateId],
      assignedIdListSha256: sha256(JSON.stringify([candidateId])),
      entries: [
        {
          id: candidateId,
          frozenSourceSha256: 'source-1',
          frozenOutcome: 'candidate-no-longer-relevant',
          currentState: 'open',
          currentOrigin: 'local',
          currentFingerprint: 'current-1',
          inboundReferences: [],
          outboundReferences: [],
          canonicalId: null,
          recommendation: 'preserve',
          rationale: 'Current evidence requires preservation.',
        },
      ],
    };
    const artifactText = JSON.stringify(artifact, null, 2) + '\n';
    writeFileSync(artifactPath, artifactText);
    const assignments = [
      {
        feature_id: 'WI-1',
        status: 'done',
        payload: {
          shard: 1,
          candidateIds: [candidateId],
          resultPath: artifactPath,
          _completionEvidence: {
            testsRun: 'node --test aggregate.test.mjs',
            testResult: 'passed',
            verifiedHow: 'Re-read artifact and aggregate output.',
            settlementManifest: {
              contentIdentity: [
                {
                  path: artifactPath,
                  workingTreeBlobSha: gitBlobSha(artifactText),
                },
              ],
            },
          },
        },
      },
    ];
    const ledger = [
      {
        id: candidateId,
        sourceSha256: 'source-1',
        outcome: 'candidate-no-longer-relevant',
      },
    ];

    const result = runAggregate(directory, assignments, ledger, 1, 1);

    assert.equal(result.status, 0);
    assert.equal(result.output.ok, true);
    assert.equal(result.output.readiness.ready, true);
    assert.equal(result.output.assignmentFreshness.verdict, 'fresh');
    assert.deepEqual(result.output.errors, []);
    assert.equal(result.output.population.validatedArtifactCount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a terminal artifact with a hardcoded developer home path is invalid and not ready', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p004-aggregate-identity-path-'));
  try {
    const candidateId = 'EI-1';
    const artifactPath = join(
      directory,
      'feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p004-validation-shard-01.json',
    );
    const artifact = {
      schemaVersion: 'feature-change-p004-validation-shard-v1',
      shard: 1,
      readOnlyValidation: true,
      assignedIds: [candidateId],
      assignedIdListSha256: sha256(JSON.stringify([candidateId])),
      validationEvidence: {
        workingTree: { root: ['', 'home', 'fixtureperson', 'private-checkout'].join('/') },
      },
      entries: [
        {
          id: candidateId,
          frozenSourceSha256: 'source-1',
          frozenOutcome: 'candidate-no-longer-relevant',
          currentState: 'open',
          currentOrigin: 'local',
          currentFingerprint: 'current-1',
          inboundReferences: [],
          outboundReferences: [],
          canonicalId: null,
          recommendation: 'preserve',
          rationale: 'Current evidence requires preservation.',
        },
      ],
    };
    const artifactText = JSON.stringify(artifact, null, 2) + '\n';
    writeFileSync(artifactPath, artifactText);
    const assignments = [
      {
        feature_id: 'WI-1',
        status: 'done',
        payload: {
          shard: 1,
          candidateIds: [candidateId],
          resultPath: artifactPath,
          _completionEvidence: {
            testsRun: 'node --test aggregate.test.mjs',
            testResult: 'passed',
            verifiedHow: 'Re-read artifact and aggregate output.',
            settlementManifest: {
              contentIdentity: [
                {
                  path: artifactPath,
                  workingTreeBlobSha: gitBlobSha(artifactText),
                },
              ],
            },
          },
        },
      },
    ];
    const ledger = [
      {
        id: candidateId,
        sourceSha256: 'source-1',
        outcome: 'candidate-no-longer-relevant',
      },
    ];

    const result = runAggregate(directory, assignments, ledger, 1, 1);

    assert.equal(result.status, 1);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.readiness.ready, false);
    assert.deepEqual(result.output.readiness.invalidArtifactShards, [1]);
    assert.equal(result.output.shards[0].checks.portableArtifact, false);
    assert.equal(result.output.shards[0].identityPathFindings[0].user, 'fixtureperson');
    assert.deepEqual(
      result.output.errors.filter(({ code }) => code === 'shard-check-failed'),
      [{ code: 'shard-check-failed', shard: 1, check: 'portableArtifact' }],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

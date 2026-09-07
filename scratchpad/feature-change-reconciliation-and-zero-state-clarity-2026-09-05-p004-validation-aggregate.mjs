#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { findBoxIdentityPaths } from '../scripts/lib/identity-leak-patterns.mjs';

const TERMINAL_STATES = new Set(['done', 'closed', 'resolved', 'dropped']);
const ARTIFACT_RE =
  /^feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p004-validation-shard-(\d+)\.json$/;

function parseArgs(argv) {
  const out = {
    artifacts: 'scratchpad',
    expectedShards: 50,
    expectedCandidates: 236,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--assignments') out.assignments = value;
    else if (key === '--ledger') out.ledger = value;
    else if (key === '--artifacts') out.artifacts = value;
    else if (key === '--expected-shards') out.expectedShards = Number(value);
    else if (key === '--expected-candidates') out.expectedCandidates = Number(value);
    else throw new Error('Unknown argument: ' + key);
    i += 1;
  }
  if (!out.assignments) throw new Error('--assignments is required');
  if (!out.ledger) throw new Error('--ledger is required');
  return out;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlobSha(buffer) {
  const header = Buffer.from('blob ' + buffer.length + '\0');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = value == null ? '<null>' : String(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function getEntries(artifact) {
  if (Array.isArray(artifact.entries)) return artifact.entries;
  if (Array.isArray(artifact.results)) return artifact.results;
  return [];
}

function getStoredAssignedHash(artifact) {
  if (isNonEmptyString(artifact.assignedIdListSha256)) return artifact.assignedIdListSha256;
  if (isNonEmptyString(artifact.assignedIdsSha256)) return artifact.assignedIdsSha256;
  if (isNonEmptyString(artifact.assignedIdHash)) return artifact.assignedIdHash;
  if (isNonEmptyString(artifact.assignedIdHash?.value)) return artifact.assignedIdHash.value;
  if (isNonEmptyString(artifact.assignedIdCoverage?.sha256)) return artifact.assignedIdCoverage.sha256;
  return null;
}

function matchAssignedHash(ids, stored) {
  if (!stored) return { exact: false, encoding: null };
  const encodings = [
    ['json', JSON.stringify(ids)],
    ['newline', ids.join('\n') + '\n'],
    ['newline-no-final', ids.join('\n')],
  ];
  for (const [encoding, serialized] of encodings) {
    if (sha256(serialized) === stored) return { exact: true, encoding };
  }
  return { exact: false, encoding: null };
}

function noLiveMutationClaim(artifact) {
  const claims = [
    artifact.readOnlyValidation === true,
    artifact.readOnlyBoundary?.liveFeatureChangeRowsMutated === 0,
    artifact.readOnlyBoundary?.liveFeatureChangeRowsMutated === false,
    artifact.checks?.noLiveFeatureChangeMutation === true,
    artifact.validationChecks?.noLiveFeatureChangeMutation === true,
    artifact.validation?.artifactChecks?.noLiveFeatureChangeMutation === true,
    artifact.summary?.noLiveFeatureChangeMutation === true,
    artifact.summary?.liveFeatureOrChangeRowsMutated === 0,
  ];
  return claims.some(Boolean);
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const args = parseArgs(process.argv.slice(2));
const assignmentPath = resolve(args.assignments);
const ledgerPath = resolve(args.ledger);
const artifactDirectory = resolve(args.artifacts);
const assignmentDocument = JSON.parse(readFileSync(assignmentPath, 'utf8'));
const rows = Array.isArray(assignmentDocument) ? assignmentDocument : assignmentDocument.rows;
if (!Array.isArray(rows)) throw new Error('Assignment input must be an array or { rows: [...] }');
const ledgerDocument = JSON.parse(readFileSync(ledgerPath, 'utf8'));
if (!Array.isArray(ledgerDocument.entries)) throw new Error('Ledger must contain entries[]');

const errors = [];
const warnings = [];
const ledgerById = new Map();
for (const entry of ledgerDocument.entries) {
  if (ledgerById.has(entry.id)) {
    errors.push({ code: 'duplicate-ledger-id', id: entry.id });
  } else {
    ledgerById.set(entry.id, entry);
  }
}

const assignmentByShard = new Map();
const assignedIdOwner = new Map();
for (const row of rows) {
  const shard = Number(row.payload?.shard);
  if (!Number.isInteger(shard)) {
    errors.push({ code: 'assignment-shard-missing', workItem: row.feature_id });
    continue;
  }
  if (assignmentByShard.has(shard)) {
    errors.push({ code: 'duplicate-assignment-shard', shard });
    continue;
  }
  assignmentByShard.set(shard, row);
  const candidateIds = row.payload?.candidateIds;
  if (!Array.isArray(candidateIds)) {
    errors.push({ code: 'assignment-candidate-ids-missing', shard, workItem: row.feature_id });
    continue;
  }
  for (const id of candidateIds) {
    if (assignedIdOwner.has(id)) {
      errors.push({
        code: 'duplicate-assigned-id',
        id,
        shards: [assignedIdOwner.get(id), shard],
      });
    } else {
      assignedIdOwner.set(id, shard);
    }
  }
}

const artifactFiles = readdirSync(artifactDirectory)
  .map((name) => ({ name, match: name.match(ARTIFACT_RE) }))
  .filter(({ match }) => match)
  .map(({ name, match }) => ({ name, shard: Number(match[1]) }))
  .sort((a, b) => a.shard - b.shard);
const artifactShards = new Set(artifactFiles.map(({ shard }) => shard));
for (const { shard, name } of artifactFiles) {
  if (!assignmentByShard.has(shard)) errors.push({ code: 'orphan-artifact', shard, file: name });
}

const shardResults = [];
for (const shard of [...assignmentByShard.keys()].sort((a, b) => a - b)) {
  const row = assignmentByShard.get(shard);
  const expectedIds = row.payload.candidateIds;
  const expectedRelativePath =
    row.payload.resultPath ??
    'scratchpad/feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p004-validation-shard-' +
      String(shard).padStart(2, '0') +
      '.json';
  const artifactPath = resolve(expectedRelativePath);
  const terminal = TERMINAL_STATES.has(row.status);
  const result = {
    shard,
    workItem: row.feature_id,
    state: row.status,
    terminal,
    candidateCount: expectedIds.length,
    artifactPath: expectedRelativePath,
    artifactPresent: existsSync(artifactPath),
    checks: {},
  };
  if (!result.artifactPresent) {
    if (terminal) errors.push({ code: 'terminal-artifact-missing', shard, workItem: row.feature_id });
    shardResults.push(result);
    continue;
  }

  let artifact;
  let artifactBuffer;
  let artifactText;
  try {
    artifactBuffer = readFileSync(artifactPath);
    artifactText = artifactBuffer.toString('utf8');
    artifact = JSON.parse(artifactText);
  } catch (error) {
    errors.push({ code: 'artifact-unreadable', shard, message: String(error) });
    shardResults.push(result);
    continue;
  }

  const artifactShard = Number(artifact.shard ?? artifact.claim?.shard);
  const assignedIds = artifact.assignedIds;
  const entries = getEntries(artifact);
  const entryIds = entries.map((entry) => entry.id);
  const storedHash = getStoredAssignedHash(artifact);
  const hash = matchAssignedHash(assignedIds ?? [], storedHash);
  const artifactBlobSha = gitBlobSha(artifactBuffer);
  const completion = row.payload?._completionEvidence;
  const contentIdentity = completion?.settlementManifest?.contentIdentity?.find(
    (item) => item.path === expectedRelativePath || basename(item.path ?? '') === basename(expectedRelativePath),
  );
  const ledgerChecks = entries.map((entry) => {
    const frozen = ledgerById.get(entry.id);
    return {
      id: entry.id,
      present: frozen != null,
      sourceShaExact: frozen != null && entry.frozenSourceSha256 === frozen.sourceSha256,
      outcomeExact: frozen != null && entry.frozenOutcome === frozen.outcome,
    };
  });
  const requiredFields = entries.map((entry) => {
    const frozen = ledgerById.get(entry.id);
    const expectedCanonical = frozen?.proposedCanonical ?? null;
    const canonicalValid =
      expectedCanonical != null
        ? entry.canonicalId === expectedCanonical
        : entry.frozenOutcome === 'candidate-already-implemented'
          ? entry.canonicalId == null || entry.canonicalId === entry.id
          : entry.canonicalId == null;
    return {
      id: entry.id,
      valid:
        isNonEmptyString(entry.id) &&
        isNonEmptyString(entry.frozenSourceSha256) &&
        isNonEmptyString(entry.frozenOutcome) &&
        /^(apply|preserve)(-|$)/.test(entry.recommendation ?? '') &&
        isNonEmptyString(entry.rationale) &&
        canonicalValid &&
        entry.currentState != null &&
        entry.currentOrigin != null &&
        (entry.currentFingerprint != null ||
          entry.currentFingerprintEvidence != null ||
          entry['currentFingerprint/evidence'] != null) &&
        entry.inboundReferences != null &&
        entry.outboundReferences != null,
    };
  });
  const identityPathFindings = findBoxIdentityPaths(artifactText);
  result.artifactBlobSha = artifactBlobSha;
  result.completionBlobSha = contentIdentity?.workingTreeBlobSha ?? null;
  result.hashEncoding = hash.encoding;
  result.recommendations = countBy(entries.map((entry) => entry.recommendation));
  result.confidence = countBy(entries.map((entry) => entry.confidence));
  result.frozenOutcomes = countBy(entries.map((entry) => entry.frozenOutcome));
  result.tests = terminal
    ? {
        testsRun: completion?.testsRun ?? null,
        testResult: completion?.testResult ?? null,
        verifiedHow: completion?.verifiedHow ?? null,
      }
    : null;
  result.checks = {
    schemaVersion: artifact.schemaVersion === 'feature-change-p004-validation-shard-v1',
    shardIdentity: artifactShard === shard,
    assignmentOrder: Array.isArray(assignedIds) && sameArray(assignedIds, expectedIds),
    assignedHash: hash.exact,
    entryCount: entries.length === expectedIds.length,
    entryOrder: sameArray(entryIds, expectedIds),
    entrySet:
      [...entryIds].sort().join('\n') === [...expectedIds].sort().join('\n') &&
      new Set(entryIds).size === entries.length,
    frozenLedger: ledgerChecks.every((check) => check.present && check.sourceShaExact && check.outcomeExact),
    requiredFields: requiredFields.every(({ valid }) => valid),
    portableArtifact: identityPathFindings.length === 0,
    noLiveMutation: noLiveMutationClaim(artifact),
    completionEvidence:
      !terminal ||
      (completion != null &&
        isNonEmptyString(completion.testsRun) &&
        isNonEmptyString(completion.testResult) &&
        isNonEmptyString(completion.verifiedHow)),
    contentIdentity: !terminal || (contentIdentity != null && contentIdentity.workingTreeBlobSha === artifactBlobSha),
  };
  for (const [name, passed] of Object.entries(result.checks)) {
    if (!passed) errors.push({ code: 'shard-check-failed', shard, check: name });
  }
  const failedLedgerRows = ledgerChecks.filter(
    (check) => !check.present || !check.sourceShaExact || !check.outcomeExact,
  );
  if (failedLedgerRows.length > 0) {
    result.failedLedgerRows = failedLedgerRows;
  }
  const failedRequiredRows = requiredFields.filter(({ valid }) => !valid).map(({ id }) => id);
  if (failedRequiredRows.length > 0) {
    result.failedRequiredRows = failedRequiredRows;
  }
  if (identityPathFindings.length > 0) {
    result.identityPathFindings = identityPathFindings;
  }
  shardResults.push(result);
}

const expectedShardNumbers = Array.from({ length: args.expectedShards }, (_, index) => index + 1);
const observedShardNumbers = [...assignmentByShard.keys()].sort((a, b) => a - b);
if (!sameArray(observedShardNumbers, expectedShardNumbers)) {
  errors.push({
    code: 'assignment-shard-partition-mismatch',
    expected: expectedShardNumbers,
    observed: observedShardNumbers,
  });
}
if (assignedIdOwner.size !== args.expectedCandidates) {
  errors.push({
    code: 'assignment-candidate-count-mismatch',
    expected: args.expectedCandidates,
    observed: assignedIdOwner.size,
  });
}

const artifactResults = shardResults.filter((result) => result.artifactPresent);
const terminalResults = shardResults.filter((result) => result.terminal);
const validatedArtifactResults = artifactResults.filter(
  (result) =>
    Object.keys(result.checks).length > 0 && Object.values(result.checks).every(Boolean),
);
const missingArtifactShards = shardResults
  .filter((result) => !result.artifactPresent)
  .map(({ shard }) => shard);
const nonTerminalShards = shardResults
  .filter((result) => !result.terminal)
  .map(({ shard }) => shard);
const invalidArtifactShards = artifactResults
  .filter((result) => !validatedArtifactResults.includes(result))
  .map(({ shard }) => shard);

if (missingArtifactShards.length > 0) {
  errors.push({
    code: 'artifact-shard-coverage-incomplete',
    expected: args.expectedShards,
    observed: artifactResults.length,
    missingShards: missingArtifactShards,
  });
}
if (nonTerminalShards.length > 0) {
  errors.push({
    code: 'terminal-shard-coverage-incomplete',
    expected: args.expectedShards,
    observed: terminalResults.length,
    nonTerminalShards,
  });
}
if (validatedArtifactResults.length !== args.expectedShards) {
  errors.push({
    code: 'validated-artifact-coverage-incomplete',
    expected: args.expectedShards,
    observed: validatedArtifactResults.length,
    invalidShards: invalidArtifactShards,
    missingShards: missingArtifactShards,
  });
}

const readinessChecks = {
  assignmentRows: rows.length === args.expectedShards,
  distinctShards: assignmentByShard.size === args.expectedShards,
  distinctAssignedCandidates: assignedIdOwner.size === args.expectedCandidates,
  artifactsPresent: artifactResults.length === args.expectedShards,
  artifactsValidated: validatedArtifactResults.length === args.expectedShards,
  shardsTerminal: terminalResults.length === args.expectedShards,
};
const readiness = {
  ready: Object.values(readinessChecks).every(Boolean) && errors.length === 0,
  checks: readinessChecks,
  missingArtifactShards,
  invalidArtifactShards,
  nonTerminalShards,
};
const output = {
  schemaVersion: 'feature-change-p004-validation-aggregate-v1',
  generatedAt: new Date().toISOString(),
  ok: readiness.ready,
  readiness,
  sources: {
    assignments: args.assignments,
    ledger: args.ledger,
    artifacts: args.artifacts,
  },
  population: {
    assignmentRows: rows.length,
    distinctShards: assignmentByShard.size,
    distinctAssignedCandidates: assignedIdOwner.size,
    terminalShards: terminalResults.map(({ shard }) => shard),
    terminalCount: terminalResults.length,
    artifactShards: [...artifactShards].sort((a, b) => a - b),
    artifactCount: artifactResults.length,
    validatedArtifactCount: validatedArtifactResults.length,
  },
  statusCounts: countBy(rows.map((row) => row.status)),
  recommendationCounts: countBy(
    artifactResults.flatMap((result) =>
      Object.entries(result.recommendations ?? {}).flatMap(([key, count]) =>
        Array.from({ length: count }, () => key),
      ),
    ),
  ),
  frozenOutcomeCounts: countBy(
    artifactResults.flatMap((result) =>
      Object.entries(result.frozenOutcomes ?? {}).flatMap(([key, count]) =>
        Array.from({ length: count }, () => key),
      ),
    ),
  ),
  warnings,
  errors,
  shards: shardResults,
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');
if (errors.length > 0) process.exitCode = 1;

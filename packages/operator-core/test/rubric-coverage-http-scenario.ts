/** Read-only HTTP journey over private rubric fixtures. No acceptance is granted. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { proposeRubric, getRubric } from '../lib/rubrics';
import { createIssue, issuesScopeWorkspace } from '../lib/issues-engineer';
import { OBSERVATION_TOPIC } from '../lib/harness/improvements/read-items';
import type { StructuredObservation } from '../lib/harness/improvements/observation-types';
import { recordRubricCheckResults, readLatestRubricCheckResults } from '../lib/check-results-ledger';
import { retainMeasurementProvenance } from '../lib/measurement-provenance';
import { continuityProbeRevision, SQL_PROBE_TOOL } from '../lib/continuity-probes';
import scorecardsList from '../lib/agent-tools/scorecards/list';
import { scorecardGetArgs } from '../lib/agent-tools/scorecards/get';
import '../lib/agent-tools/dev/pg_query';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string; expectedSha: string };

function listReaderArgs(rubricRef: string, subjectRef: string, comparisonTime: string, detail: 'scores' | 'full') {
  return scorecardsList.args.parse({ rubricRef, subjectRef, comparisonTime, limit: 1, includeUnfinalized: true, detail });
}

function criterionReaderArgs(issueId: string, criterionKey: string, comparisonTime: string) {
  return scorecardGetArgs.parse({ issueId, criterionKey, comparisonTime });
}

/** Validate the actual request builders before spending time on an API build. */
export function assertRubricCoverageReaderContracts() {
  const clock = '2026-11-02T00:00:00Z';
  for (const detail of ['scores', 'full'] as const)
    listReaderArgs('luna-max-coverage-fixture', 'fleet:luna-max-coverage-fixture', clock, detail);
  criterionReaderArgs('EI-private-coverage', 'retained', clock);
}

export function rubricCoverageCriterionCard(detail: any) {
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.evidenceRead?.complete, true, 'The selected criterion evidence must be complete');
  assert.ok(detail.scorecard, 'The public getter must return the selected scorecard');
  return detail.scorecard;
}

export async function measureRubricCoverageScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  assert.equal(issuesScopeWorkspace(), o.workspace);
  const { sql } = getOrgPg();
  const [database] = await sql`SELECT current_database() AS name, inet_server_port() AS port`;
  assert.equal(Number(database.port), Number(process.env.PAPERCUSP_PG_PORT));
  assert.notEqual(Number(database.port), 5432);
  const clock = '2026-11-02T00:00:00Z';
  const start = '2026-11-01T00:00:00Z';
  const measuredAt = '2026-11-01T12:00:00Z';
  const schemaRevision = continuityProbeRevision(SQL_PROBE_TOOL);
  assert.ok(schemaRevision, 'The canonical SQL probe must be registered');
  const unknownKeys = Array.from({ length: 25 }, (_, index) => `unassessed-${index + 1}`);
  const requests: Array<{ name: string; status: number }> = [];
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', { method: 'POST', headers: o.headers,
      body: JSON.stringify({ name, args, harness: o.harness, callerSid: 'private-rubric-coverage-' + o.workspace }),
      signal: AbortSignal.timeout(30_000) });
    const envelope = await response.json() as any;
    await writeFile(`${o.evidenceDir}/rubric-request-${requests.length}.json`,
      JSON.stringify({ name, args, status: response.status, envelope }), { flag: 'wx' });
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const block = envelope.result?.content?.find((part: any) => part.type === 'text'
      && typeof part.text === 'string' && part.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (block ? JSON.parse(block.text) : envelope.result?.data);
    assert.ok(result, 'The canonical reader must return an inspectable response');
    requests.push({ name, status: response.status });
    return result;
  };
  const identity = await invoke('coord:whoami', {});
  assert.equal(typeof identity.ownerId, 'string');
  const summaries = [];
  for (const manual of [false, true]) {
    const rubricRef = manual ? 'manual-coverage-fixture' : 'luna-max-coverage-fixture';
    const subject = { kind: 'pot' as const, ref: manual ? 'audit:manual-coverage-fixture' : 'fleet:luna-max-coverage-fixture',
      windowStart: start, windowEnd: clock };
    const probe = { kind: 'probe' as const, probe: { kind: 'sql' as const, sql: 'SELECT 3 AS n', schemaRevision,
      expect: { path: '$.rowCount', op: 'gte' as const, value: 10 } } };
    const keys = manual ? ['manual-review', 'executable-review'] : ['retained', ...unknownKeys];
    await proposeRubric({ rubricId: rubricRef, title: rubricRef, characteristic: 'private-coverage-journey',
      status: 'active', by: identity.ownerId, criteria: keys.map((key, index) => ({ key, title: key,
        model: 'Historical evidence stays distinct from rating completeness.',
        method: manual && index === 0 ? 'Read the archived review and retain its exact sources.' : 'Inspect the pinned assessment check.',
        replication: 'Use the original November assessment window.', driftMarkers: 'An unsupported rating is counted as evidence.',
        ...(manual && index === 0 ? { instrumentKey: 'none' } : !manual && index === 0 ? { check: probe }
          : { check: { kind: 'tests' as const, files: ['packages/operator-core/lib/scorecards.test.ts'] } }),
      })) });
    const rubric = await getRubric(rubricRef);
    assert.ok(rubric);
    const ratings: NonNullable<StructuredObservation['ratings']> = Object.fromEntries(keys.map(key => [key,
      { rating: 'unknown', evidence: 'Not assessed in the pinned window.', unknownReason: 'not-assessed' as const,
        nextEvidenceAction: `Inspect ${key} in the original window.` }]));
    if (manual) ratings['manual-review'] = { rating: 'healthy',
      evidence: 'Historical reviewer judgment; canonical manual support remains unavailable.' };
    else {
      const provenance = retainMeasurementProvenance({ startedAt: measuredAt, finishedAt: measuredAt,
        procedure: { kind: 'command', argv: ['retained-fixture-check'] }, result: { value: 3 } });
      const check = { id: 'retained:0', rubricRef, criterionKey: 'retained', kind: 'probe' as const,
        value: 3, unit: null, subject: { kind: subject.kind, ref: subject.ref }, provenance };
      const [id] = await recordRubricCheckResults([{ check, verdict: 'fail', measuredAt, durationMs: 1 }],
        { workspaceId: o.workspace, harnessSlug: o.harness }, sql);
      assert.ok(id);
      const retained = (await readLatestRubricCheckResults({ rubricRef, workspaceId: o.workspace,
        subject: check.subject, asOf: clock, testRunIds: [id] }, sql)).get(check.id);
      assert.ok(retained);
      ratings.retained = { rating: 'degraded', evidence: 'The exact retained adverse result.', ratedFrom: 'ledger',
        ledgerResult: { testRunId: id, value: 3, unit: null, provenance: retained.check.provenance,
          provenanceStatus: retained.provenanceStatus } };
    }
    const issue = await createIssue({ kind: 'change', title: rubricRef, topics: [OBSERVATION_TOPIC],
      createdBy: identity.ownerId, payload: { observation: { rubricRef, rubricRevision: rubric.revision,
        criteriaHash: rubric.criteriaHash, subject, ratings } } });
    await sql`UPDATE harness_shared.engineer_issues SET created_at=${clock}
      WHERE workspace_id=${o.workspace} AND issue_id=${issue.id}`;
    const before = await sql`SELECT payload::text AS payload FROM harness_shared.engineer_issues
      WHERE workspace_id=${o.workspace} AND issue_id=${issue.id}`;
    const compact = (await invoke('scorecards:list', listReaderArgs(rubricRef, subject.ref, clock, 'scores'))).scorecards?.[0];
    const full = (await invoke('scorecards:list', listReaderArgs(rubricRef, subject.ref, clock, 'full'))).scorecards?.[0];
    assert.equal(full?.issueId, issue.id);
    assert.equal(compact?.issueId, issue.id);
    assert.deepEqual(full.ratings, ratings);
    assert.deepEqual(compact.coverage, full.coverage);
    assert.deepEqual(compact.evidenceActions, full.evidenceActions);
    assert.equal(full.coverage.record.present, keys.length);
    assert.equal(full.coverage.denominator, keys.length);
    assert.equal(full.coverage.evidence.current.length, manual ? 0 : 1);
    assert.equal(full.coverage.unresolvedKeys.length, manual ? 2 : 25);
    assert.equal(full.coverage.requestedScope.state, 'unknown');
    assert.equal(full.coverage.fulfillment, 'unknown');
    for (const [index, key] of keys.entries()) {
      const detail = await invoke('scorecards:get', criterionReaderArgs(issue.id, key, clock));
      const criterionCard = rubricCoverageCriterionCard(detail);
      assert.equal(criterionCard.issueId, issue.id);
      assert.deepEqual(criterionCard.coverage, full.coverage);
      const { key: returnedKey, evidenceAction, ...rating } = criterionCard.criteria[0];
      assert.equal(returnedKey, key);
      assert.deepEqual(rating, ratings[key]);
      assert.equal(evidenceAction.context.subjectRef, subject.ref);
      assert.equal(evidenceAction.context.windowStart, start);
      assert.equal(evidenceAction.context.windowEnd, clock);
      assert.equal(evidenceAction.context.rubricRevision, rubric.revision);
      assert.equal(evidenceAction.context.criteriaHash, rubric.criteriaHash);
      if (index < 3) assert.deepEqual(evidenceAction, full.evidenceActions[index]);
    }
    assert.deepEqual(await sql`SELECT payload::text AS payload FROM harness_shared.engineer_issues
      WHERE workspace_id=${o.workspace} AND issue_id=${issue.id}`, before);
    summaries.push({ issueId: issue.id, subject: subject.ref, rubricRevision: rubric.revision,
      criteriaHash: rubric.criteriaHash, coverage: full.coverage, historicalJsonUnchanged: true });
  }
  const response = await fetch(o.base + '/api/health', { headers: o.headers, signal: AbortSignal.timeout(5_000) });
  const health = await response.json() as { sha: string };
  assert.equal(response.status, 200);
  assert.equal(health.sha, o.expectedSha);
  const receipt = { workspace: o.workspace, database, identity: identity.ownerId, requests, summaries,
    scope: 'Current reader behavior only; positive manual support, certified absence and full SPEC acceptance remain unresolved.' };
  await writeFile(`${o.evidenceDir}/rubric-coverage-receipt.json`, JSON.stringify(receipt), { flag: 'wx' });
  return receipt;
}

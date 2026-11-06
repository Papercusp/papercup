import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { observeSqlDemand, aggregateSqlDemand } from './bash-substitution/sql-intent-corpus';
import type { SqlCandidateReadOptions, SqlCandidateSnapshot } from './bash-substitution/sql-tool-candidates';
import { readSqlToolCandidateWorklist } from './sql-tool-candidate-worklist';
import { fingerprintSqlIntent } from './bash-substitution/sql-intent-fingerprint';
import type { SqlRecommendationInput } from './bash-substitution/sql-tool-recommendations';
const scope = { workspaceId: 'w', sourceBoundary: 'ledger', epoch: 'one', key: new Uint8Array(32).fill(71) };
const opts: SqlCandidateReadOptions = { workspaceId: 'w', harnessSlug: 'h', scope,
  authorize: async () => true, authorizeSource: async () => true };
function snapshot(sql = 'SELECT id FROM jobs', ranOn = '2026-10-25'): SqlCandidateSnapshot {
  const observations = Array.from({ length: 12 }, (_, i) => observeSqlDemand({ workspaceId: 'w', harnessSlug: 'h',
    namespace: 'ledger', callId: String(i), resultCallId: String(i), identityAuthority: 'ledger', provider: 'ledger',
    actor: `su-${i % 3}`, verifiedAgent: true, at: `2026-10-${23 + i % 2}T00:00:00Z`, origin: 'agent',
    status: 'ok', durationMs: 10, sql, sourceComplete: true, copyRef: String(i) }, scope));
  return { ranOn, sourceIds: ['1', '2'], examples: [], summary: aggregateSqlDemand(observations,
    { status: 'complete', scannedRows: 12, cap: 20, retention: 'complete', providers: ['ledger'] }) };
}
it('R8 worklist bounds rows, retains coverage and deduplicates overlapping snapshot demand', async () => {
  const rows = [snapshot(), snapshot('SELECT id FROM jobs', '2026-10-24'), snapshot('SELECT name FROM users')];
  const result = await readSqlToolCandidateWorklist({ ...opts, limit: 1 }, {
    read: async () => rows, history: async () => [] });
  expect(result.population).toEqual({ candidates: 2, returned: 1, omitted: 1, snapshotCap: 120 });
  expect(result.candidates[0]!.candidate.counts.ok).toBe(12);
  expect(result.candidates[0]!.candidate.eligible).toBe(true);
  expect(result.snapshots).toHaveLength(3);
  expect(result.candidates[0]!.evidenceRefs).toEqual([{ kind: 'tool-invocation', id: '1' }, { kind: 'tool-invocation', id: '2' }]);
});
it('R23 derived worklist fails closed when authority changes during history lookup', async () => {
  const read = vi.fn().mockResolvedValueOnce([snapshot()]).mockResolvedValueOnce([]);
  const result = await readSqlToolCandidateWorklist(opts, { read, history: async () => [] });
  expect(result).toMatchObject({ status: 'UNKNOWN', candidates: [], snapshots: [],
    population: { candidates: 0, returned: 0, omitted: 0 } });
});
it('R8 unsupported populations remain visible without becoming eligible demand', async () => {
  const row = snapshot(); row.summary.unknownParseOperations = 4;
  const result = await readSqlToolCandidateWorklist(opts, { read: async () => [row], history: async () => [] });
  expect(result.snapshots[0]!.residue.unknownParseOperations).toBe(4);
  expect(result.candidates[0]!.candidate.reasons).toContain('incomplete-evidence');
});
it('R8 history is bounded and dependency errors disclose no private error or population', async () => {
  const result = await readSqlToolCandidateWorklist(opts, { read: async () => [snapshot()],
    history: async () => Array.from({ length: 21 }, (_, i) => ({ editionId: String(i), workItemId: `WI-${i}`,
      suppressed: false, createdAt: '2026-10-25T00:00:00Z' })) });
  expect(result.candidates[0]!.decisionHistory).toHaveLength(20);
  expect(result.candidates[0]!.decisionHistoryTruncated).toBe(true);
  const failed = await readSqlToolCandidateWorklist(opts, { read: async () => { throw new Error('private sql'); } });
  expect(JSON.stringify(failed)).not.toContain('private');
  expect(failed.status).toBe('UNKNOWN');
});
it('R8 evidence reference cap reports omitted refs on the returned entry', async () => {
  const row = snapshot(); row.sourceIds = Array.from({ length: 101 }, (_, i) => String(i));
  const result = await readSqlToolCandidateWorklist(opts, { read: async () => [row], history: async () => [] });
  expect(result.candidates[0]!.evidenceRefs).toHaveLength(100);
  expect(result.candidates[0]!.evidenceRefsOmitted).toBe(1);
});

const now = Date.parse('2026-10-25T00:00:00Z');
function recommendationFixture(sql = 'SELECT id FROM jobs') {
  const shape = fingerprintSqlIntent(sql, scope);
  if (shape.status !== 'supported') throw new Error('fixture SQL must parse');
  const row = snapshot(sql);
  row.examples = [{ canonical: shape.canonical, features: shape.features }];
  const input: SqlRecommendationInput = { sql, scope, sourceAuthorized: true, sourceCoverage: 'complete',
    now, exampleExpiresAt: now + 1000, candidateCoverage: 'complete',
    current: { ref: 'fixture-current-catalog', buildRef: 'fixture-current-build', coverage: 'complete',
      tools: [{ name: 'fixture:read-jobs', contractRef: 'fixture-contract', args: z.object({}) }] },
    served: { ref: 'fixture-served-catalog', buildRef: 'fixture-served-build', coverage: 'complete',
      tools: [{ name: 'fixture:read-jobs', contractRef: 'fixture-contract', args: z.object({}) }] },
    audits: [{ toolName: 'fixture:read-jobs', contractRef: 'fixture-contract', fingerprint: shape.fingerprint,
      parserVersion: shape.version, requiredFeatures: shape.features, verdict: 'exact', args: {},
      fixtureRef: 'fixture-worklist-equivalence', resultRef: 'fixture-worklist-result', missingFeatures: [] }],
  };
  return { row, input };
}
it('P006 links all six audited recommendations to exact scoped demand without copying SQL or typed arguments', async () => {
  const { row, input } = recommendationFixture();
  const cases: Array<[SqlRecommendationInput, string]> = [
    [input, 'route-existing'],
    [{ ...input, served: { ...input.served, tools: [] } }, 'availability-gap'],
    [{ ...input, audits: [{ ...input.audits[0]!, verdict: 'partial', missingFeatures: ['output:id'] }] }, 'extend-existing'],
    [{ ...input, audits: [{ ...input.audits[0]!, verdict: 'none', missingFeatures: ['predicate'] }] }, 'new-tool'],
    [{ ...input, audits: [], keepSql: { fingerprint: input.audits[0]!.fingerprint, decisionRef: 'fixture-keep-decision' } }, 'keep-sql'],
    [{ ...input, audits: [] }, 'insufficient-evidence'],
  ];
  for (const [value, kind] of cases) {
    const result = await readSqlToolCandidateWorklist({ ...opts, now, recommendationInput: async () => value },
      { read: async () => [row], history: async () => [{ editionId: 'past-edition', workItemId: 'WI-1',
        suppressed: true, createdAt: '2026-10-24' }] });
    expect(result.candidates[0]!.recommendation?.kind).toBe(kind);
    expect(result.candidates[0]!.candidate.counts.ok).toBe(12);
    expect(result.candidates[0]!.decisionHistory[0]!.editionId).toBe('past-edition');
    expect(JSON.stringify(result)).not.toContain(input.sql);
    expect(JSON.stringify(result)).not.toContain('"args"');
    expect(result.candidates[0]!.recommendation?.immediatelyCallable).toBe(kind === 'route-existing');
  }
});
it('P006 refuses neighbor shapes, foreign scope/key/epoch and absent or expired private examples', async () => {
  const { row, input } = recommendationFixture();
  for (const changed of [
    { ...input, sql: 'SELECT name FROM jobs' },
    { ...input, scope: { ...scope, epoch: 'other' } },
    { ...input, scope: { ...scope, workspaceId: 'foreign' } },
    { ...input, scope: { ...scope, key: new Uint8Array(32).fill(7) } },
    { ...input, exampleExpiresAt: now },
    { ...input, sourceAuthorized: false },
  ]) {
    const result = await readSqlToolCandidateWorklist({ ...opts, now, recommendationInput: async () => changed },
      { read: async () => [row], history: async () => [] });
    expect(result.candidates[0]!.recommendation).toMatchObject({ kind: 'insufficient-evidence',
      fingerprint: null, evidenceRefs: [], immediatelyCallable: false });
  }
  for (const examples of [[], [{ canonical: row.examples[0], features: {} }]]) {
    const result = await readSqlToolCandidateWorklist({ ...opts, now, recommendationInput: async () => input },
      { read: async () => [{ ...row, examples }], history: async () => [] });
    expect(result.candidates[0]!.recommendation?.kind).toBe('insufficient-evidence');
  }
});
it('P006 renews source authority and example retention after asynchronous contract lookup', async () => {
  const { row, input } = recommendationFixture();
  for (const revoked of [true, false]) {
    let lookedUp = false;
    const result = await readSqlToolCandidateWorklist({ ...opts, now,
      recommendationInput: async () => { lookedUp = true; return input; } }, {
      read: async () => lookedUp ? revoked ? [] : [{ ...row, examples: [] }] : [row], history: async () => [],
    });
    expect(lookedUp).toBe(true);
    if (revoked) expect(result).toMatchObject({ status: 'UNKNOWN', candidates: [], snapshots: [] });
    else expect(result.candidates[0]!.recommendation).toMatchObject({ kind: 'insufficient-evidence', evidenceRefs: [] });
  }
});

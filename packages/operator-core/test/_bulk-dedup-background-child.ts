/** Current-source acceptance child for work-items-admission-bulk-dedup-background.integration.test.ts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import postgres from 'postgres';
import { runWorkItemAdmissionBulkDedup } from '../lib/work-items-admission-bulk-dedup';
import { runWorkItemAdmissionDailyDigest } from '../lib/work-items-admission-daily-digest';
import { readAdmissionMergeSnapshots } from '../lib/work-items-admission-promoter';
import { lexicalHardEdges } from '../lib/work-items-admission-census';
import { ADMISSION_MERGE_QUALITY_GOLD_CORPUS, admissionMergeQualityGoldJudgements } from '../lib/work-items-admission-merge-quality';

const home = process.env.HOME!;
const ws = process.env.PAPERCUSP_WORKSPACE_ID!;
const dsn = process.env.HARNESS_ADMIN_DATABASE_URL!;
assert.ok(home.includes('papercusp-test-runtime-'));
assert.ok(ws.startsWith('test-runtime-'));
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
assert.equal(process.env.PAPERCUSP_CLUSTER, '0');
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
assert.ok(dsn);
assert.equal(new URL(dsn).port, process.env.PAPERCUSP_PG_PORT);
assert.notEqual(new URL(dsn).port, '5432');
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN']) {
  assert.equal(process.env[key], undefined, `${key} must not enter the private runtime`);
}
const sourceUrl = new URL('../lib/work-items-admission-bulk-dedup.ts', import.meta.url);
const sourceHash = createHash('sha256').update(await readFile(sourceUrl)).digest('hex');
assert.equal(sourceHash, process.env.BULK_BG_EXPECTED_SOURCE_SHA);
const sql = postgres(dsn, { max: 4, prepare: false, onnotice: () => {} });
const harness = 'bulk-background-acceptance';
const root = 'bulk-background-acceptance';
try {
  const [server] = await sql`SELECT inet_server_port() AS port, current_database() AS db`;
  assert.equal(String(server!.port), process.env.PAPERCUSP_PG_PORT);
  const [column] = await sql`
    SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 'harness_shared.work_items'::regclass AND attname = 'embedding'`;
  const dims = Number(column?.atttypmod) > 0 ? Number(column!.atttypmod) : 3;
  const vector = (axis: number) => JSON.stringify(Array.from({ length: dims }, (_, i) => i === axis ? 1 : 0));
  const insertColumns = ['workspace_id', 'harness_slug', 'feature_id', 'title', 'summary', 'status', 'payload',
    'item_kind', 'nature', 'created_ts', 'updated_ts', 'embedding', 'embedding_mode', 'admission', 'admitted_at', 'admitted_by'];
  const generatedInputs = await sql`
    SELECT attname FROM pg_attribute WHERE attrelid = 'harness_shared.work_items'::regclass
     AND attname = ANY(${insertColumns}::text[]) AND attgenerated <> ''`;
  assert.deepEqual(generatedInputs.map((row) => row.attname), [], 'fixture insert contract must omit generated columns');
  const fixtures = [
    { id: 'a', title: 'Cache invalidation repeats stale entries' },
    { id: 'b', title: 'Cache invalidation repeats stale entries' },
    { id: 'c', title: 'Parser rejects valid quoted identifiers' },
    { id: 'd', title: 'Parser rejects valid quoted identifiers' },
  ];
  const expectedPairs = ['a::b', 'c::d'];
  assert.deepEqual(lexicalHardEdges(fixtures).map(({ a, b }) => `${a}::${b}`).sort(), expectedPairs,
    'fixture title normalization must produce exactly the two intended pairs');
  for (const [i, { id, title }] of fixtures.entries()) {
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, payload,
         item_kind, nature, created_ts, updated_ts, embedding, embedding_mode, admission, admitted_at, admitted_by)
      VALUES (${ws}, ${harness}, ${id}, ${title}, ${`Evidence ${id}`}, 'open',
              '{}'::jsonb, 'change', 'work', ${i + 1}, ${i + 1}, ${vector(i < 2 ? 0 : 1)}::vector,
              'gemma', 'admitted', now(), 'test')`;
  }
  let changed = false;
  let interrupted = false;
  let calls = 0;
  const candidatePairs = new Set<string>();
  const opts: Parameters<typeof runWorkItemAdmissionBulkDedup>[0] = {
    workspaceId: ws, harnessSlug: harness, runId: root, sql,
    maxStages: 1,
    census: { chunkCount: 2, targetTokens: 1_000, fullCorpusPairThreshold: 0 },
    llmCall: async (input) => {
      if (input.messages[0]?.content.includes(ADMISSION_MERGE_QUALITY_GOLD_CORPUS[0]!.pair.pairKey)) {
        return { text: '', json: { judgements: admissionMergeQualityGoldJudgements() }, inputTokens: 100, outputTokens: 20 };
      }
      calls += 1;
      const keys = [...input.messages[0]!.content.matchAll(/^([^\s]+::[^\s]+) \|/gm)].map((match) => match[1]!);
      assert.ok(keys.length > 0, 'real judge batch must contain candidate pairs');
      for (const key of keys) {
        assert.ok(expectedPairs.includes(key), `unexpected fixture candidate ${key}`);
        candidatePairs.add(key);
      }
      if (!changed) {
        changed = true;
        const target = { workspaceId: ws, harnessSlug: harness, ids: ['b'] };
        const before = (await readAdmissionMergeSnapshots(sql, target)).get('b');
        assert.ok(before, 'drift target must exist in the actual endpoint reader');
        const changedRows = await sql`
          UPDATE harness_shared.work_items
             SET payload = payload || '{"backgroundAcceptanceDrift":true}'::jsonb
           WHERE workspace_id = ${ws} AND harness_slug = ${harness} AND feature_id = 'b'
          RETURNING feature_id, payload`;
        assert.equal(changedRows.length, 1);
        assert.equal(changedRows[0]!.payload.backgroundAcceptanceDrift, true);
        const after = (await readAdmissionMergeSnapshots(sql, target)).get('b');
        assert.ok(after);
        assert.notEqual(after.fingerprint, before.fingerprint, 'fixture drift must change canonical endpoint identity');
        process.stdout.write('BULK_BACKGROUND_DRIFT ' + JSON.stringify({ before: before.fingerprint, after: after.fingerprint }) + '\n');
      }
      return { text: '', json: { judgements: keys.map((pairKey) => ({ pairKey, verdict: 'r-finding-merge', reason: 'same failure and remedy' })) }, inputTokens: 100, outputTokens: 20 };
    },
    beforePostStageCensus: async () => {
      if (!interrupted) { interrupted = true; throw new Error('background acceptance post-commit interruption'); }
    },
  };
  await assert.rejects(runWorkItemAdmissionBulkDedup(opts), /background acceptance post-commit interruption/);
  assert.ok(calls > 0);
  assert.deepEqual([...candidatePairs].sort(), expectedPairs, 'actual judge population must match the fixture contract');
  const recovered = await runWorkItemAdmissionBulkDedup({
    ...opts, llmCall: async () => { throw new Error('receipt recovery must not call the model'); },
  });
  const rows = await sql`SELECT feature_id, status FROM harness_shared.work_items
                         WHERE workspace_id = ${ws} AND harness_slug = ${harness} ORDER BY feature_id`;
  const stage = recovered.stages[0]!;
  process.stdout.write('BULK_BACKGROUND_STAGE ' + JSON.stringify({
    candidatePairs: [...candidatePairs].sort(), pairs: stage.pairs, merged: stage.merged,
    guardRefusals: stage.guardRefusals, censusBefore: stage.censusBefore, censusAfter: stage.censusAfter,
    rows: rows.map((row) => [row.feature_id, row.status]), convergenceReason: recovered.convergenceReason,
  }) + '\n');
  assert.equal(recovered.converged, false);
  assert.equal(recovered.convergenceReason, 'stage-budget');
  assert.equal(stage.pairs, 2);
  assert.equal(recovered.stages[0]!.merged, 1);
  assert.deepEqual(recovered.stages[0]!.guardRefusals?.map((row) => [row.itemId, row.reason]), [['b', 'snapshot-drift']]);
  assert.deepEqual(rows.map((row) => [row.feature_id, row.status]), [['a', 'open'], ['b', 'open'], ['c', 'open'], ['d', 'dropped']]);
  const digest = await runWorkItemAdmissionDailyDigest({
    workspaceId: ws, harnessSlug: harness, sql, runId: 'bulk-background-digest',
    llmCall: async () => ({ text: '', json: { umbrellas: [] }, inputTokens: 100, outputTokens: 20 }),
    fileUmbrella: async () => { throw new Error('empty digest should not file an umbrella'); },
    linkUmbrella: async () => { throw new Error('empty digest should not write umbrella links'); },
  });
  assert.equal(digest.status, 'complete');
  assert.equal(digest.sourceBulkStageRunId, `${root}-stage-1`);
  assert.equal(digest.sourceCensusRunId, recovered.stages[0]!.resultCensusRunId);
  assert.equal(digest.coverage?.live, 3);
  assert.equal(digest.coverage?.covered, 3);
  assert.equal(digest.coverage?.uncovered, 0);
  const [ledger] = await sql`SELECT detail->>'status' AS status, detail->'outcome' AS outcome,
                                   detail->'guardRefusals' AS refusals, detail#>'{mergeReceipt,guardRefusals}' AS receipt_refusals
                            FROM harness_shared.admission_runs WHERE id = ${`${root}-stage-1`}`;
  assert.equal(ledger!.status, 'complete');
  assert.equal(ledger!.outcome.successful, 1);
  assert.equal(ledger!.outcome.unchanged, 1);
  assert.deepEqual(ledger!.refusals, ledger!.receipt_refusals);
  process.stdout.write('BULK_BACKGROUND_RECEIPT ' + JSON.stringify({
    sourceHash, workspace: ws, home, runtimeRoot: dirname(home), pgPort: server!.port,
    runId: root, candidatePairs: [...candidatePairs].sort(), merged: recovered.stages[0]!.merged, driftRefusals: ledger!.refusals,
    convergenceReason: recovered.convergenceReason, digest: { status: digest.status, sourceCensusRunId: digest.sourceCensusRunId, coverage: digest.coverage },
  }) + '\n');
} finally {
  await sql.end({ timeout: 5 });
}
if (process.env.BULK_BG_INJECT_FAILURE === '1') {
  process.stderr.write('BULK_BACKGROUND_INJECT_FAILURE: verifying wrapper teardown on exit 23\n');
  process.exit(23);
}
process.exit(0);

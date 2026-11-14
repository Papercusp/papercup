import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { reclaimCompletionSql, RECLAIM_SOURCE_PATHS, type ReclaimCompletionBinding } from './reclaim-provenance';

describe('R6 governed native completion SQL', () => {
  let db: FreshPgDb;
  let beginning: number;
  let binding: ReclaimCompletionBinding;
  const at = (minutes: number) => new Date(beginning + minutes * 60_000).toISOString();
  beforeAll(async () => {
    db = await createFreshPgDb('reclaim-completion');
    await db.sql.unsafe(`CREATE TABLE harness_shared.audit_log
      (id text PRIMARY KEY,ts bigint,actor text,action text,details jsonb,workspace_id text);
      CREATE TABLE harness_shared.test_runs (id bigint PRIMARY KEY,workspace_id text,harness_slug text,
      file_path text,status text,worktree_dirty boolean,commit_sha text,started_at timestamptz,
      finished_at timestamptz,execution_details jsonb)`);
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.sql.unsafe('TRUNCATE harness_shared.audit_log,harness_shared.test_runs');
    const [clock] = await db.sql`SELECT extract(epoch FROM date_trunc('hour',now()-interval '15 minutes')-interval '24 hours')*1000 AS b`;
    beginning = Number(clock!.b);
    binding = { workspaceId: 'workspace', harnessSlug: 'harness', host: 'fixture-host', acceptedAt: at(-60),
      integrationTestRunId: 42, isolatedRunId: '20261114T010000Z-123', runtime: { service: 'port-3271',
        processId: 'linux:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:456', artifact: {
          sourceSha: 'a'.repeat(40), sourceBlobs: Object.fromEntries(RECLAIM_SOURCE_PATHS.map(p => [p, 'b'.repeat(40)])),
          bundleSha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64), evidenceRef: '/fixture/bg.artifact.json' } } };
    await db.sql`INSERT INTO harness_shared.test_runs VALUES (42,'workspace','harness',
      'packages/operator-core/lib/storage/disk-reclaim-background-runtime.integration.test.ts','pass',false,
      ${binding.runtime.artifact.sourceSha},${at(-80)},${at(-70)},${db.sql.json({ testLayer: 'integration', failed: 0,
        collectionFailed: false, isolatedRuntimeReceipts: [{ runId: binding.isolatedRunId,
          resultSha256: 'e'.repeat(64), sourceSha256: 'f'.repeat(64), lifecycleSha256: '0'.repeat(64) }] })})`;
    for (let h = 0; h < 24; h++) await pair(`run-${h}`, h * 60 + 5, h * 60 + 10);
  });
  async function row(id: string, phase: 'started' | 'receipt', minute: number, details: Record<string, unknown>) {
    await db.sql`INSERT INTO harness_shared.audit_log VALUES (${`${id}-${phase}`},${beginning + minute * 60_000},
      'system:disk-retention',${`disk-retention:${phase}`},${db.sql.json(details)},'workspace')`;
  }
  async function pair(id: string, start: number, end: number) {
    const receipt = { id, host: binding.host, runtime: binding.runtime, startedAt: at(start), finishedAt: at(end),
      dryRun: false, complete: true, policyExhausted: true, errors: [], entries: [], delegates: [] };
    await row(id, 'started', start, { ...receipt, finishedAt: '', complete: false });
    await row(id, 'receipt', end, receipt);
  }
  const measure = async (input = binding) => (await db.sql.unsafe(reclaimCompletionSql(input)))[0]!;

  it('requires the clean original integration proof and returns the fixed population', async () => {
    const result = await measure();
    expect(result).toMatchObject({ verdict: 'pass', proof_qualified: true, integration_test_run_id: 42 });
    expect(result.start_audit_ids).toHaveLength(24);
    expect(result.receipt_audit_ids).toHaveLength(24);
  });
  it.each(['', ' ', 'bad host', '-bad', 7, null, undefined])('retains an unfinished start with malformed host %j', async host => {
    await row('extra', 'started', 20, { id: 'extra', host, startedAt: at(20), dryRun: false, runtime: binding.runtime });
    expect((await measure()).verdict).not.toBe('pass');
  });
  it.each(['foreign-host', true])('excludes only positively foreign or literal dry-run evidence (%j)', async exclusion => {
    await row('extra', 'started', 20, { id: 'extra', host: exclusion === true ? '' : exclusion,
      startedAt: at(20), dryRun: exclusion === true, runtime: binding.runtime });
    expect((await measure()).verdict).toBe('pass');
  });
  it('accepts a matched pre-window completion and the exact normal deadline at the window edge', async () => {
    await pair('pre-window', -10, 1);
    await pair('window-edge', 24 * 60 - 1, 24 * 60 + 14);
    expect((await measure()).verdict).toBe('pass');
  });
  it('retains an overdue orphan terminal despite a healthy hourly cohort', async () => {
    await row('orphan', 'receipt', 1, { id: 'orphan', host: binding.host, runtime: binding.runtime,
      startedAt: at(-16), finishedAt: at(1), dryRun: false, complete: true, policyExhausted: true,
      errors: [], entries: [], delegates: [] });
    expect((await measure()).verdict).not.toBe('pass');
  });
  it.each(['missing-terminal', 'duplicate-terminal', 'late', 'bad-clock', 'bad-flag', 'failed-effect', 'failed-delegate', 'missing-hour'])(
    'refuses %s in an otherwise healthy cohort', async fault => {
      if (fault === 'missing-terminal') await db.sql`DELETE FROM harness_shared.audit_log WHERE id='run-5-receipt'`;
      if (fault === 'duplicate-terminal') await db.sql`INSERT INTO harness_shared.audit_log SELECT 'duplicate',ts,actor,action,details,workspace_id FROM harness_shared.audit_log WHERE id='run-5-receipt'`;
      if (fault === 'late') await db.sql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{finishedAt}',${db.sql.json(at(5 * 60 + 21))}) WHERE id='run-5-receipt'`;
      if (fault === 'bad-clock') await db.sql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{startedAt}','"invalid"') WHERE id='run-5-started'`;
      if (fault === 'bad-flag') await db.sql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{dryRun}','"true"') WHERE id='run-5-started'`;
      if (fault === 'failed-effect') await db.sql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{entries}','[{"status":"failed"}]') WHERE id='run-5-receipt'`;
      if (fault === 'failed-delegate') await db.sql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{delegates}','[{"ok":false}]') WHERE id='run-5-receipt'`;
      if (fault === 'missing-hour') await db.sql`DELETE FROM harness_shared.audit_log WHERE id LIKE 'run-5-%'`;
      expect((await measure()).verdict).not.toBe('pass');
    });
  it.each(['service', 'processId', 'sourceSha', 'bundleSha256', 'manifestSha256', 'sourceBlobs', 'missing'])(
    'requires the actual accepted runtime dimension %s on both phases', async dimension => {
      const runtime: any = structuredClone(binding.runtime);
      if (dimension === 'service') runtime.service = 'port-3170';
      else if (dimension === 'processId') runtime.processId += '1';
      else if (dimension === 'sourceBlobs') runtime.artifact.sourceBlobs[RECLAIM_SOURCE_PATHS[0]] = '9'.repeat(40);
      else if (dimension !== 'missing') runtime.artifact[dimension] = '9'.repeat(dimension === 'sourceSha' ? 40 : 64);
      await db.sql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{runtime}',${db.sql.json(dimension === 'missing' ? null : runtime)}) WHERE id='run-5-started'`;
      expect((await measure()).verdict).not.toBe('pass');
    });
  it.each(['dirty', 'failed', 'wrong-source', 'wrong-file', 'missing-runtime-proof', 'retroactive-proof'])(
    'refuses %s integration evidence', async fault => {
      if (fault === 'dirty') await db.sql`UPDATE harness_shared.test_runs SET worktree_dirty=true`;
      if (fault === 'failed') await db.sql`UPDATE harness_shared.test_runs SET status='fail'`;
      if (fault === 'wrong-source') await db.sql`UPDATE harness_shared.test_runs SET commit_sha=${'9'.repeat(40)}`;
      if (fault === 'wrong-file') await db.sql`UPDATE harness_shared.test_runs SET file_path='unrelated.integration.test.ts'`;
      if (fault === 'missing-runtime-proof') await db.sql`UPDATE harness_shared.test_runs SET execution_details=execution_details-'isolatedRuntimeReceipts'`;
      if (fault === 'retroactive-proof') await db.sql`UPDATE harness_shared.test_runs SET finished_at=${at(1)}`;
      expect(await measure()).toMatchObject({ verdict: 'unknown-or-failed', proof_qualified: false });
    });
  it('cannot retroactively accept the observed runtime or generate a check with missing identity', async () => {
    expect((await measure({ ...binding, acceptedAt: at(1) })).verdict).not.toBe('pass');
    expect(() => reclaimCompletionSql({ ...binding, runtime: null } as any)).toThrow();
    expect(() => reclaimCompletionSql({ ...binding, runtime: { ...binding.runtime, service: 'port-3170' } } as any)).toThrow();
  });
});

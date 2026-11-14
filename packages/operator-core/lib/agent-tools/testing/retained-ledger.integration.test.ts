import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _resetForTests, getOrgPg } from '@papercusp/db-org';
import { captureConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { _resetHarnessAdminUrlCacheForTests } from '../../embedded-pg-discovery';
import { TestRunArtifactPacket, testRunDeadline } from './run-artifacts';
import { recoverRetainedVitestLedger } from './retained-ledger';

let org: OrgTestDb;
let root: string;
beforeAll(async () => {
  org = await createOrgTestDb();
  for (const [key, value] of Object.entries({ HARNESS_DATABASE_URL: org.appDsn,
    HARNESS_ADMIN_DATABASE_URL: org.adminDsn, DATABASE_URL: org.adminDsn,
    PAPERCUSP_TEST_RUNS_DB_URL: org.adminDsn, PAPERCUSP_PGBOUNCER: '0', PAPERCUSP_SKIP_PG_DISCOVERY: '1' }))
    vi.stubEnv(key, value);
  _resetHarnessAdminUrlCacheForTests();
  await _resetForTests();
  root = mkdtempSync(join(tmpdir(), 'retained-ledger-real-pg-'));
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', join(root, 'retained'));
}, 120_000);
afterAll(async () => {
  await _resetForTests();
  await org?.cleanup();
  vi.unstubAllEnvs();
  _resetHarnessAdminUrlCacheForTests();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('recovers a sealed Vitest packet to one numeric ledger row and reuses that row on retry with real Postgres', async () => {
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'subject.test.ts'), 'export {};');
  const runId = randomUUID();
  const input = { runId, workItemId: 'WI-retained-fixture', workspaceId: 'retained-workspace', harnessSlug: 'papercusp' };
  const packet = new TestRunArtifactPacket(runId, source, testRunDeadline(60_000));
  packet.bindNativeIdentity(input.workspaceId, input.harnessSlug);
  packet.captureSelectedSources(['subject.test.ts'], { commit: 'b'.repeat(40), porcelain: ' M subject.test.ts' });
  packet.write('ledger.json', { runGroup: runId, workspace: input.workspaceId, harness: input.harnessSlug,
    workItem: input.workItemId, testNamePattern: null });
  packet.write('router.json', { code: 0, childState: 'closed', signal: null, timedOut: false, aborted: false });
  packet.write('configuration.json', captureConfigurationSnapshot({ NODE_ENV: 'test' }));
  const now = Date.now();
  writeFileSync(join(packet.paths.reports, 'report.json'), JSON.stringify({ success: true, startTime: now - 100,
    numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1,
    testResults: [{ name: join(source, 'subject.test.ts'), status: 'passed', startTime: now - 50, endTime: now,
      assertionResults: [{ status: 'passed', fullName: 'retained fixture assertion' }] }] }));
  packet.childState = 'closed';
  await packet.finish({ result: { ok: true, runId, root: source, passed: 1, failed: 0, skipped: 0,
    byFile: { 'subject.test.ts': { passed: 1, failed: 0, skipped: 0 } } } });

  const request = { ...input, directory: packet.paths.directory };
  const first = await recoverRetainedVitestLedger(request);
  const second = await recoverRetainedVitestLedger(request);
  expect(first.testRunIds).toHaveLength(1);
  expect(Number.isSafeInteger(first.testRunIds[0])).toBe(true);
  expect(first.testRunIds[0]).toBeGreaterThan(0);
  expect(second.testRunIds).toEqual(first.testRunIds);
  const rows = await getOrgPg().sql`SELECT id, framework, run_group_id, workspace_id, harness_slug,
    worktree_dirty, execution_details FROM harness_shared.test_runs WHERE run_group_id = ${runId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ framework: 'vitest', run_group_id: runId,
    workspace_id: input.workspaceId, harness_slug: input.harnessSlug, worktree_dirty: true,
    execution_details: { passed: 1, failed: 0, skipped: 0, root: source } });
}, 60_000);

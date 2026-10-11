import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { readTaskFailureSignals } from './task-brief';

describe('native P018 real scoped incident ledger', () => {
  let fixture: PlanPgFixture;
  const harness = `native-incident-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = '/private/native-incident-fixture';
  const path = 'target.test.ts';
  beforeAll(async () => { fixture = await setupPlanPgFixture(); });
  afterAll(async () => {
    if (!fixture) return;
    try { await fixture.admin`DELETE FROM harness_shared.test_runs WHERE harness_slug = ${harness}`; }
    finally { await fixture.dispose(); }
  });
  it('uses the latest normal run, hashes its error log, and excludes mutation and foreign-scope failures', async () => {
    const insert = async (status: string, source = 'local', workspace = fixture.workspaceId, checkout = root, file = path) => {
      const [row] = await fixture.admin<{ id: string }[]>`
        INSERT INTO harness_shared.test_runs
          (workspace_id, harness_slug, file_path, status, source, framework, commit_sha, output_tail, execution_details)
        VALUES (${workspace}, ${harness}, ${file}, ${status}, ${source}, 'vitest', ${'a'.repeat(40)}, 'observed assertion failure',
          ${JSON.stringify({ root: checkout })}::text::jsonb) RETURNING id`;
      return Number(row.id);
    };
    const scope = { workspaceId: fixture.workspaceId, harness, root, paths: [path] };
    const failed = await insert('fail');
    expect(await readTaskFailureSignals(scope)).toEqual([{ testRunId: failed, path, status: 'fail', commit: 'a'.repeat(40),
      logSha256: createHash('sha256').update('observed assertion failure').digest('hex') }]);
    await insert('fail', 'mutation-probe');
    await insert('error', 'local', 'foreign-workspace');
    await insert('error', 'local', fixture.workspaceId, root, 'outside.test.ts');
    await insert('error', 'local', fixture.workspaceId, '/another/checkout');
    expect((await readTaskFailureSignals(scope)).map(row => row.testRunId)).toEqual([failed]);
    await insert('pass');
    expect(await readTaskFailureSignals(scope)).toEqual([]);
    await insert('error', 'local', fixture.workspaceId, '/another/checkout');
    expect(await readTaskFailureSignals(scope)).toEqual([]);
  });
});

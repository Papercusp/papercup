import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { readDreamDetail, readDreamHistory } from './dream-read';
import { readDreamMetrics } from './dream-metrics';

const scope = { workspaceId: 'dream-history-test', potSlug: 'pot-a', since: '2026-09-07T00:00:00Z', until: '2026-09-08T00:00:00Z' };
describe('Analyze Dream history (real PostgreSQL)', () => {
  let db: OrgTestDb;
  let fixture: Awaited<ReturnType<typeof createDreamCapabilityFixture>>;
  beforeAll(async () => {
    db = await createOrgTestDb();
    fixture = await createDreamCapabilityFixture(scope.workspaceId, scope.potSlug);
    await db.adminSql`
      INSERT INTO harness_shared.dream_runs (workspace_id, run_id, cycle_id, pot_slug, mode, status, started_at)
      SELECT ${scope.workspaceId}, 'r-' || lpad(n::text, 2, '0'), 'cycle', ${scope.potSlug}, 'manual',
        (ARRAY['no-pair','abstained','malformed','duplicate','rejected','accepted','error','running'])[1 + n % 8],
        '2026-09-07T12:00:00Z'::timestamptz FROM generate_series(1, 25) n`;
    await db.adminSql`
      INSERT INTO harness_shared.dream_runs (workspace_id, run_id, cycle_id, pot_slug, mode, status, started_at)
      VALUES (${scope.workspaceId}, 'other-pot', 'other', 'pot-b', 'manual', 'error', '2026-09-07T12:00:00Z'),
        ('other-workspace', 'other-workspace', 'other', ${scope.potSlug}, 'manual', 'error', '2026-09-07T12:00:00Z'),
        (${scope.workspaceId}, 'too-old', 'old', ${scope.potSlug}, 'manual', 'error', '2026-09-05T12:00:00Z')`;
  }, 180_000);
  afterAll(async () => {
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
    await db?.cleanup();
    if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  });
  it('pages every status through timestamp ties without leaking another scope or window', async () => {
    const first = await readDreamHistory(db.adminSql, scope);
    expect(first.runs).toHaveLength(20);
    const second = await readDreamHistory(db.adminSql, scope, first.nextCursor!);
    expect(second.runs).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.runs, ...second.runs];
    expect(new Set(all.map(r => r.runId)).size).toBe(25);
    expect(new Set(all.map(r => r.status)).size).toBe(8);
    expect(all.every(r => r.runId.startsWith('r-'))).toBe(true);
    expect(all.every(r => !('outcome' in r))).toBe(true);
    expect((await readDreamMetrics(db.adminSql, scope)).population.attempts).toBe(25);
    await expect(readDreamHistory(db.adminSql, scope, 'not-json')).rejects.toThrow();
    await expect(readDreamHistory(db.adminSql, { ...scope, since: '2026-07-01T00:00:00Z' })).rejects.toThrow(/31 days/);
  });
  it('reads legacy rows honestly and refuses cross-pot or cross-workspace detail', async () => {
    expect((await readDreamDetail(db.adminSql, { ...scope, runId: 'r-01' }))?.provenance).toBeNull();
    expect(await readDreamDetail(db.adminSql, { ...scope, runId: 'other-pot' })).toBeNull();
    expect(await readDreamDetail(db.adminSql, { ...scope, runId: 'other-workspace' })).toBeNull();
  });
  it('preserves frozen packets, rejection, unknown usage and title without executing or charging anything', async () => {
    const outcome = structuredClone(fixture.run.outcome!);
    const provenance = structuredClone(fixture.provenance);
    provenance.calls[0] = { ...provenance.calls[0]!, status: 'unknown', usage: null } as typeof provenance.calls[number];
    outcome.capabilityRun = provenance;
    await db.adminSql`UPDATE harness_shared.dream_runs SET outcome = ${JSON.stringify(outcome)}::jsonb,
      review = ${JSON.stringify({ ...fixture.review, verdict: 'reject', note: 'Rejected fixture' })}::jsonb,
      cost_usd = 0.16, status = 'rejected' WHERE workspace_id = ${scope.workspaceId} AND run_id = 'r-25'`;
    const detail = await readDreamDetail(db.adminSql, { ...scope, runId: 'r-25' });
    expect(detail?.proposal?.experiment.falsifier).toBe('The seeded mismatch is missed.');
    expect(detail?.capabilityReview?.note).toBe('Rejected fixture');
    expect(detail?.provenance?.calls[0]?.usage).toBeNull();
    expect(detail?.currentSourceFreshness).toBe('not-rechecked');
    expect((await readDreamHistory(db.adminSql, scope)).runs[0]?.title).toBe(fixture.candidate.behavior);
    const [row] = await db.adminSql`SELECT cost_usd, status FROM harness_shared.dream_runs WHERE workspace_id = ${scope.workspaceId} AND run_id = 'r-25'`;
    expect(Number(row!.cost_usd)).toBe(0.16);
    expect(row!.status).toBe('rejected');
  });
});

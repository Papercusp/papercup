/** Shared amend receipts must survive module/worker boundaries in real Postgres. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { trackAmendRun, getAmendReceipt } = await import('./amend-receipts');
let db: Awaited<ReturnType<typeof createOrgTestDb>>;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

describe('rubric amend receipts in shared Postgres', () => {
  it('persists running and committed results across fresh modules, and reserves a key once', async () => {
    const key = 'shared-receipt-integration';
    const rubric = 'acceptance-receipt-integration';
    let release!: (value: Record<string, unknown>) => void;
    const work = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedWork = new Promise<void>((resolve) => { started = resolve; });
    let executions = 0;
    const first = trackAmendRun(key, rubric, () => {
      executions++;
      started();
      return work;
    });
    await startedWork;

    vi.resetModules();
    const otherWorker = await import('./amend-receipts');
    expect(await otherWorker.getAmendReceipt(rubric, key)).toMatchObject({ state: 'running' });
    const retry = await otherWorker.trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true };
    });
    expect(retry).toMatchObject({ pending: true, idempotencyKey: key });
    expect(executions).toBe(1);

    release({ ok: true, rubric: { id: rubric } });
    await first;
    expect(await getAmendReceipt(rubric, key)).toMatchObject({
      state: 'committed', result: { ok: true, rubric: { id: rubric } },
    });
    const rows = await db.adminSql<{ workspace_id: string; state: string }[]>`
      SELECT workspace_id, state FROM harness_shared.rubric_amend_receipts
       WHERE idempotency_key = ${key}
    `;
    expect(rows).toEqual([{ workspace_id: activeWorkspaceId(), state: 'committed' }]);
  });
});

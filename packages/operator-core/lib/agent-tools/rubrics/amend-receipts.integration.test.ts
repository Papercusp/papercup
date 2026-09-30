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

  // EI-24680663429090445: the key is deterministic per request, so a retry of the same
  // payload after the underlying defect is fixed lands on the same row. Replaying the stored
  // failure returned the ORIGINAL error for an hour, on the fixed build too.
  it('re-runs a same-key retry after a failure instead of replaying the stored error', async () => {
    const key = 'failed-receipt-rerun';
    const rubric = 'acceptance-receipt-rerun';
    let executions = 0;
    await expect(trackAmendRun(key, rubric, async () => {
      executions++;
      throw new Error('acceptance_bar_revision_projection_unmapped:AUTO-BAR-R-10-P-004');
    })).rejects.toThrow('projection_unmapped');
    expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'failed' });

    const retried = await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true, rubric: { id: rubric } };
    });
    expect(retried).toEqual({ ok: true, rubric: { id: rubric } });
    expect(executions).toBe(2);
    const receipt = await getAmendReceipt(rubric, key);
    expect(receipt).toMatchObject({ state: 'committed', result: { ok: true } });
    expect(receipt?.error).toBeUndefined();

    // A COMMITTED receipt still replays: only failures are re-run.
    const replayed = await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true, rerun: true };
    });
    expect(replayed).toEqual({ ok: true, rubric: { id: rubric } });
    expect(executions).toBe(2);
  });

  it('re-runs a stored ok:false result and lets exactly one of two concurrent retries run it', async () => {
    const key = 'failed-result-concurrent-rerun';
    const rubric = 'acceptance-receipt-concurrent';
    let executions = 0;
    expect(await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: false, error: 'stale build refusal' };
    })).toEqual({ ok: false, error: 'stale build refusal' });
    expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'failed', error: 'stale build refusal' });

    let release!: (value: Record<string, unknown>) => void;
    const work = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedWork = new Promise<void>((resolve) => { started = resolve; });
    const first = trackAmendRun(key, rubric, () => {
      executions++;
      started();
      return work;
    });
    await startedWork;
    const second = await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true, duplicate: true };
    });
    expect(second).toMatchObject({ pending: true, idempotencyKey: key });
    release({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(executions).toBe(2);
    expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'committed' });
  });
});

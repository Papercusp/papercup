/**
 * consult-expiry-core.integration.test.ts — the P-005 expiry sweep against a
 * real Postgres (plan get-feedback-relevance-consults-2026-08-16, D-005).
 *
 * Bootstrap mirrors consult-verbs-core.integration.test.ts: the consult tables
 * come from applying the REAL migration file (834-consult-threads.sql,
 * readFileSync) — never a hand-mirrored CREATE that silently falls behind.
 *
 * What only a real-PG test can prove here:
 *  - the sweep's UPDATE flips ONLY past-due open rows (expires_at < now AND
 *    closed_at IS NULL) to state='expired' under the migration's state CHECK;
 *  - already-closed and not-yet-due rows are untouched;
 *  - the bounded LIMIT actually bounds one tick (saturated reporting);
 *  - the latched park-key emit fires ONLY for hard-blocked rows, addressed to
 *    the requester, in the row's own workspace.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
import { sweepExpiredConsults, type ExpirySweepDeps } from './consult-expiry-core';

const WS = 'ws-consult-expiry';
const NOW = new Date('2026-08-16T12:00:00Z');
const PAST = new Date(NOW.getTime() - 60_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 3_600_000).toISOString();
const MIGRATION_834 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);

let rootSql: Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `consulte_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  // Minimal landing pad for the migration's coord_conversations kind-CHECK
  // widening (the real table is migration-132-owned; only `kind` matters here).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      id text PRIMARY KEY,
      kind text NOT NULL DEFAULT 'question'
    )`);
  // The REAL migration — consult_state + consult_post_meta cannot drift.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

// ── Fixture builders ─────────────────────────────────────────────────────
let seq = 0;
async function seedConsult(opts: {
  latency?: 'proceed' | 'hard-blocked';
  expiresAt?: string | null;
  closedAt?: string | null;
  state?: string;
  workspaceId?: string;
  requesterId?: string;
}): Promise<string> {
  seq += 1;
  const id = `conv-e-${seq}`;
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, expires_at, closed_at)
    VALUES
      (${opts.workspaceId ?? WS}, ${id}, ${opts.requesterId ?? 'req-1'}, 'resp-1',
       ${opts.state ?? 'awaiting_responder'}, 'q', ${opts.latency ?? 'proceed'},
       ${opts.expiresAt === undefined ? PAST : opts.expiresAt}, ${opts.closedAt ?? null})`;
  return id;
}

function makeDeps(opts: { limit?: number; emitError?: boolean } = {}) {
  const emits: Array<Parameters<ExpirySweepDeps['emitReplyEvent']>[0]> = [];
  const deps: ExpirySweepDeps = {
    getSql: () => rootSql,
    emitReplyEvent: async (e) => {
      if (opts.emitError) throw new Error('emit down');
      emits.push(e);
    },
    now: () => NOW,
    ...(opts.limit != null ? { limit: opts.limit } : {}),
  };
  return { deps, emits };
}

async function stateOf(id: string, ws = WS): Promise<{ state: string; closed_at: string | null }> {
  const rows = (await rootSql`
    SELECT state, closed_at FROM harness_shared.consult_state
     WHERE workspace_id = ${ws} AND conversation_id = ${id}
  `) as unknown as Array<{ state: string; closed_at: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('sweepExpiredConsults', () => {
  it('flips ONLY past-due open rows to expired; hard-blocked rows get the latched park-key emit', async () => {
    const hardDue = await seedConsult({ latency: 'hard-blocked' });
    const proceedDue = await seedConsult({ latency: 'proceed' });
    const notDue = await seedConsult({ expiresAt: FUTURE });
    const noExpiry = await seedConsult({ expiresAt: null });
    const alreadyClosed = await seedConsult({
      latency: 'hard-blocked',
      state: 'closed_answered',
      closedAt: PAST,
    });

    const { deps, emits } = makeDeps();
    const r = await sweepExpiredConsults(deps);

    expect(r.expired).toBe(2);
    expect(r.saturated).toBe(false);
    expect(r.woke).toEqual([hardDue]);

    expect(await stateOf(hardDue)).toMatchObject({ state: 'expired' });
    expect((await stateOf(hardDue)).closed_at).not.toBeNull();
    expect(await stateOf(proceedDue)).toMatchObject({ state: 'expired' });
    expect(await stateOf(notDue)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    expect(await stateOf(noExpiry)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    expect(await stateOf(alreadyClosed)).toMatchObject({ state: 'closed_answered' });

    // ONE emit — the hard-blocked row's park key, addressed to its requester,
    // in the row's own workspace, with the expired payload.
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({
      key: `consult:reply:${hardDue}`,
      to: ['req-1'],
      workspaceId: WS,
    });
    expect(emits[0].payload).toMatchObject({ conversation_id: hardDue, kind: 'expired' });
  });

  it('is idempotent: a second tick finds nothing (expired rows are closed rows)', async () => {
    const { deps, emits } = makeDeps();
    const r = await sweepExpiredConsults(deps);
    expect(r.expired).toBe(0);
    expect(emits).toHaveLength(0);
  });

  it('bounds one tick at the limit and reports saturation; the rest drains next tick', async () => {
    const ids = await Promise.all([
      seedConsult({ latency: 'proceed' }),
      seedConsult({ latency: 'proceed' }),
      seedConsult({ latency: 'proceed' }),
    ]);
    const { deps } = makeDeps({ limit: 2 });
    const first = await sweepExpiredConsults(deps);
    expect(first.expired).toBe(2);
    expect(first.saturated).toBe(true);

    const second = await sweepExpiredConsults(deps);
    expect(second.expired).toBe(1);
    expect(second.saturated).toBe(false);

    for (const id of ids) expect((await stateOf(id)).state).toBe('expired');
  });

  it('a failed emit does not strand the flip (the await timeout is the backstop) nor the batch', async () => {
    const hardDue = await seedConsult({ latency: 'hard-blocked' });
    const { deps } = makeDeps({ emitError: true });
    const r = await sweepExpiredConsults(deps);
    expect(r.expired).toBe(1);
    expect(r.woke).toEqual([]); // emit failed — honestly not reported as woken
    expect((await stateOf(hardDue)).state).toBe('expired'); // the flip survived
  });

  it('sweeps across workspaces, stamping each emit with the ROW workspace', async () => {
    const otherWs = 'ws-consult-expiry-2';
    const foreign = await seedConsult({
      latency: 'hard-blocked',
      workspaceId: otherWs,
      requesterId: 'req-other',
    });
    const { deps, emits } = makeDeps();
    const r = await sweepExpiredConsults(deps);
    expect(r.expired).toBe(1);
    expect(await stateOf(foreign, otherWs)).toMatchObject({ state: 'expired' });
    expect(emits[0]).toMatchObject({ workspaceId: otherWs, to: ['req-other'] });
  });
});

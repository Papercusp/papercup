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
import { existsSync, readFileSync } from 'node:fs';
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
// Migration 844 (cascade_cursor + cascade_digest) — .sql once armed, .DRAFT
// while iterating, so the suite is valid on both sides of the arming mv.
const MIGRATION_844_ARMED = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/844-consult-cascade-cursor.sql', import.meta.url),
);
const MIGRATION_844 = existsSync(MIGRATION_844_ARMED) ? MIGRATION_844_ARMED : `${MIGRATION_844_ARMED}.DRAFT`;

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
  // The REAL migrations — consult_state + consult_post_meta cannot drift.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_844, 'utf8'));
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
  routing?: unknown;
  cascadeCursor?: number;
}): Promise<string> {
  seq += 1;
  const id = `conv-e-${seq}`;
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, expires_at, closed_at, routing, cascade_cursor)
    VALUES
      (${opts.workspaceId ?? WS}, ${id}, ${opts.requesterId ?? 'req-1'}, 'resp-1',
       ${opts.state ?? 'awaiting_responder'}, 'q', ${opts.latency ?? 'proceed'},
       ${opts.expiresAt === undefined ? PAST : opts.expiresAt}, ${opts.closedAt ?? null},
       ${JSON.stringify(opts.routing ?? {})}::jsonb, ${opts.cascadeCursor ?? 0})`;
  return id;
}

/** A routing snapshot with a real selection menu (selection.selected is what
 * the 844 cascade drives off). */
function menuSnapshot(owners: string[]) {
  return {
    selection: {
      selected: owners.map((o, i) => ({
        ownerId: o,
        via: 'floor' as const,
        score: 0.9 - i * 0.1,
        similarity: 0.8 - i * 0.1,
        liveness: 'live',
      })),
    },
  };
}

function makeDeps(opts: { limit?: number; emitError?: boolean; withReach?: boolean } = {}) {
  const emits: Array<Parameters<ExpirySweepDeps['emitReplyEvent']>[0]> = [];
  const reachCalls: Array<Parameters<NonNullable<ExpirySweepDeps['reach']>>[0]> = [];
  const deps: ExpirySweepDeps = {
    getSql: () => rootSql,
    emitReplyEvent: async (e) => {
      if (opts.emitError) throw new Error('emit down');
      emits.push(e);
    },
    now: () => NOW,
    ...(opts.limit != null ? { limit: opts.limit } : {}),
    ...(opts.withReach
      ? {
          reach: async (o) => {
            reachCalls.push(o);
            return { woke: 1 };
          },
        }
      : {}),
  };
  return { deps, emits, reachCalls };
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

// ── D-005/P-013 always-advance: expiry is a chain event, not a terminal ──

async function cascadeRow(id: string, ws = WS) {
  const rows = (await rootSql`
    SELECT state, closed_at, responder_id, cascade_cursor, cascade_digest, expires_at
      FROM harness_shared.consult_state
     WHERE workspace_id = ${ws} AND conversation_id = ${id}
  `) as unknown as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (typeof row.cascade_digest === 'string') row.cascade_digest = JSON.parse(row.cascade_digest);
  return row;
}

describe('sweepExpiredConsults — cascade advance (D-005/P-013)', () => {
  it('a due row with menu remaining ADVANCES instead of expiring: cursor+responder move under a fresh window, digest records the expiry, next selectee woken — NO park emit', async () => {
    const id = await seedConsult({
      latency: 'hard-blocked',
      routing: menuSnapshot(['resp-1', 'resp-2']),
    });
    const { deps, emits, reachCalls } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 1, expired: 0, woke: [], saturated: false });
    expect(emits).toHaveLength(0); // mid-chain: the parked requester sleeps on (more feedback coming)

    const row = await cascadeRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.closed_at).toBeNull();
    expect(row.responder_id).toBe('resp-2');
    expect(row.cascade_cursor).toBe(1);
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(NOW.getTime()); // fresh window
    expect(row.cascade_digest).toMatchObject([{ ownerId: 'resp-1', kind: 'expired' }]);

    // The wake rides the ROW's workspace (one sweep serves them all) and
    // carries the digest into the next selectee's body.
    expect(reachCalls).toHaveLength(1);
    expect(reachCalls[0]).toMatchObject({ responder: 'resp-2', conversationId: id, workspaceId: WS });
    expect(reachCalls[0].body).toContain('reviewer 2/2');
    expect(reachCalls[0].body).toContain('- resp-1 (expired):');
  });

  it('menu exhausted → terminal expire with the hard-blocked park emit; the digest still records the final expiry', async () => {
    const id = await seedConsult({
      latency: 'hard-blocked',
      routing: menuSnapshot(['resp-1']), // cursor 0 IS the last selectee
    });
    const { deps, emits } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 0, expired: 1, woke: [id] });
    expect(emits[0]).toMatchObject({ payload: { conversation_id: id, kind: 'expired' }, to: ['req-1'] });

    const row = await cascadeRow(id);
    expect(row.state).toBe('expired');
    expect(row.closed_at).not.toBeNull();
    expect(row.cascade_digest).toMatchObject([{ ownerId: 'resp-1', kind: 'expired' }]);
  });

  it('advances even without a bound reach seam (cursor/responder/digest move; nobody woken) — tests-only shape, prod MUST bind reach', async () => {
    const id = await seedConsult({ routing: menuSnapshot(['resp-1', 'resp-2']) });
    const { deps } = makeDeps(); // no reach
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 1, expired: 0 });
    const row = await cascadeRow(id);
    expect(row.responder_id).toBe('resp-2');
    expect(row.cascade_cursor).toBe(1);
  });
});

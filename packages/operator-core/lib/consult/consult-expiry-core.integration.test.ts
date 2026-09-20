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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
import { sweepExpiredConsults, type ExpirySweepDeps } from './consult-expiry-core';
import { consultExpiryFindSilentResponders, consultExpiryNotifyRequester } from './consult-expiry-adapters';
import { PgCoordLog, ensureCoordEventLogTable } from '@papercusp/coordination/event-log';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { currentRequestWorkspaceId } from '../workspace-als';
import { sendMessage } from '../agent-tools/coordination/messages';

// Execute the REAL message writer + REAL PG replay backend, but never resolve
// synthetic requester ids against the live agent roster or use the live DB.
const coordFixture = vi.hoisted(() => ({ log: null as PgCoordLog | null }));
vi.mock('../agent-tools/coordination/recipient-resolve', () => ({
  resolveBestEffortAgainstRoster: async (to: string[]) => to,
}));
vi.mock('../agent-tools/coordination/log', async (original) => ({
  ...await original<typeof import('../agent-tools/coordination/log')>(),
  coordLog: {
    appendLineIfAbsent: (...args: Parameters<PgCoordLog['appendLineIfAbsent']>) =>
      coordFixture.log!.appendLineIfAbsent(...args),
    appendLine: (...args: Parameters<PgCoordLog['appendLine']>) =>
      coordFixture.log!.appendLine(...args),
  },
}));

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
const MIGRATION_856 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/856-backfill-answered-expired-consult-outcomes.sql', import.meta.url),
);
const MIGRATION_963_ARMED = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/963-backfill-blank-owner-answered-consult-outcomes.sql', import.meta.url),
);
const MIGRATION_963 = existsSync(MIGRATION_963_ARMED) ? MIGRATION_963_ARMED : `${MIGRATION_963_ARMED}.DRAFT`;

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
  // The expiry sweep projects the fine-grained terminal state onto this coarse
  // parent in the same transaction, so the fixture includes the columns that
  // projection predicates and updates (the real table is migration-132-owned).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL DEFAULT 'default',
      id text PRIMARY KEY,
      kind text NOT NULL DEFAULT 'question',
      state text NOT NULL DEFAULT 'open',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  // The REAL migrations — consult_state + consult_post_meta cannot drift.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_844, 'utf8'));
  await ensureCoordEventLogTable(rootSql);
  coordFixture.log = new PgCoordLog({
    getSql: () => rootSql,
    ensureSchema: async () => {},
    getWorkspaceId: () => {
      const workspace = currentRequestWorkspaceId();
      if (!workspace) throw new Error('requester alert lost its row workspace');
      return workspace;
    },
  });
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
  updatedAt?: string;
  conversationUpdatedAt?: string;
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
       ${rootSql.json((opts.routing ?? {}) as never)}, ${opts.cascadeCursor ?? 0})`;
  if (opts.updatedAt !== undefined) {
    await rootSql`
      UPDATE harness_shared.consult_state
         SET updated_at = ${opts.updatedAt}::timestamptz
      WHERE workspace_id = ${opts.workspaceId ?? WS} AND conversation_id = ${id}`;
  }
  await rootSql`
    INSERT INTO harness_shared.coord_conversations
      (workspace_id, id, kind, state, updated_at)
    VALUES
      (${opts.workspaceId ?? WS}, ${id}, 'consult', 'open',
       ${(opts.conversationUpdatedAt ?? PAST)}::timestamptz)`;
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
  const alerts: Array<Parameters<ExpirySweepDeps['notifyRequester']>[0]> = [];
  const reachCalls: Array<Parameters<NonNullable<ExpirySweepDeps['reach']>>[0]> = [];
  const deps: ExpirySweepDeps = {
    getSql: () => rootSql,
    notifyRequester: async (alert) => { alerts.push(alert); },
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
  return { deps, emits, reachCalls, alerts };
}

async function stateOf(id: string, ws = WS): Promise<{ state: string; closed_at: string | null }> {
  const rows = (await rootSql`
    SELECT state, closed_at FROM harness_shared.consult_state
     WHERE workspace_id = ${ws} AND conversation_id = ${id}
  `) as unknown as Array<{ state: string; closed_at: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function conversationStateOf(id: string, ws = WS): Promise<{ state: string; updated_at: string }> {
  const rows = (await rootSql`
    SELECT state,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM harness_shared.coord_conversations
     WHERE workspace_id = ${ws} AND id = ${id}
  `) as unknown as Array<{ state: string; updated_at: string }>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function setDigest(id: string, digest: unknown[]) {
  await rootSql`
    UPDATE harness_shared.consult_state
       SET cascade_digest = ${rootSql.json(digest as never)}
     WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('sweepExpiredConsults', () => {
  it('flips ONLY past-due open rows to expired; hard-blocked rows get the latched park-key emit', async () => {
    const hardDue = await seedConsult({ latency: 'hard-blocked', conversationUpdatedAt: FUTURE });
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
    expect(await conversationStateOf(hardDue)).toEqual({ state: 'expired', updated_at: FUTURE });
    expect(await conversationStateOf(proceedDue)).toMatchObject({ state: 'expired' });
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

  it('keeps a lifecycle row retryable when the durable requester alert fails, then replays the same key once the writer recovers', async () => {
    const id = await seedConsult({ latency: 'proceed' });
    const { deps, alerts } = makeDeps();
    let attempts = 0;
    const seenKeys: string[] = [];
    deps.notifyRequester = async (alert) => {
      attempts += 1;
      seenKeys.push(alert.msgId);
      if (attempts === 1) throw new Error('coord writer unavailable');
      alerts.push(alert);
    };

    const first = await sweepExpiredConsults(deps);
    expect(first).toMatchObject({
      expired: 0,
      advanced: 0,
      requesterAlerts: [],
      requesterAlertFailures: [id],
    });
    expect(await stateOf(id)).toMatchObject({ state: 'awaiting_responder', closed_at: null });

    const second = await sweepExpiredConsults(deps);
    expect(second).toMatchObject({
      expired: 1,
      requesterAlerts: [id],
      requesterAlertFailures: [],
    });
    expect(await stateOf(id)).toMatchObject({ state: 'expired' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      conversationId: id,
      requesterId: 'req-1',
      workspaceId: WS,
    });
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);
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

describe('migrations 856 + 963 historical answered-expired outcome repair', () => {
  it('repairs null-outcome expired rows with answers, including blank responder ids, and is idempotent', async () => {
    const legacyAnswered = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });
    const blankOwnerAnswered = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });
    const trulyUnanswered = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });
    const explicitOutcome = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });
    const stillOpen = await seedConsult({ state: 'awaiting_responder', expiresAt: FUTURE });
    const scalarDigest = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });

    await setDigest(legacyAnswered, [
      { ownerId: 'reviewer-b', kind: 'answer', at: PAST, excerpt: 'first' },
      { ownerId: 'reviewer-a', kind: 'answer', at: PAST, excerpt: 'second' },
      { ownerId: 'reviewer-b', kind: 'answer', at: PAST, excerpt: 'follow-up' },
      { ownerId: 'reviewer-c', kind: 'expired', at: PAST, excerpt: 'old unanswered label' },
    ]);
    await setDigest(blankOwnerAnswered, [
      { ownerId: '', kind: 'answer', at: PAST, excerpt: 'anonymous first' },
      { ownerId: '', kind: 'answer', at: PAST, excerpt: 'anonymous follow-up' },
    ]);
    await setDigest(trulyUnanswered, [
      { ownerId: 'reviewer-z', kind: 'expired', at: PAST, excerpt: 'no answer' },
    ]);
    await setDigest(explicitOutcome, [
      { ownerId: 'reviewer-x', kind: 'answer', at: PAST, excerpt: 'answered' },
    ]);
    await setDigest(stillOpen, [
      { ownerId: 'reviewer-y', kind: 'answer', at: PAST, excerpt: 'not terminal' },
    ]);
    await rootSql`
      UPDATE harness_shared.consult_state
         SET cascade_digest = ${rootSql.json('legacy-scalar' as never)}
       WHERE workspace_id = ${WS} AND conversation_id = ${scalarDigest}
    `;
    await rootSql`
      UPDATE harness_shared.consult_state
         SET outcome = ${rootSql.json({ disposition: 'requester_recorded', answer: 'keep me' })}
       WHERE workspace_id = ${WS} AND conversation_id = ${explicitOutcome}
    `;

    const migrationSql = readFileSync(MIGRATION_856, 'utf8');
    const [candidate] = (await rootSql`
      SELECT count(*) FILTER (WHERE entry.value ->> 'kind' = 'answer')::integer AS answers
        FROM harness_shared.consult_state cs
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(cs.cascade_digest) = 'array' THEN cs.cascade_digest
            ELSE '[]'::jsonb
          END
        )
          WITH ORDINALITY AS entry(value, ordinality)
       WHERE cs.workspace_id = ${WS}
         AND cs.conversation_id = ${legacyAnswered}
         AND cs.state = 'expired'
         AND cs.outcome IS NULL
    `) as unknown as Array<{ answers: number }>;
    expect(candidate.answers).toBe(3);
    const updated = await rootSql.unsafe(migrationSql);
    expect(updated.count).toBe(1);

    // Migration 856 intentionally filtered blank responder ids, but that also
    // dropped the whole conversation when every substantive answer was
    // anonymous. Migration 963 retains the answer count and records that no
    // responder identity was available.
    const blankOwnerMigrationSql = readFileSync(MIGRATION_963, 'utf8');
    const blankOwnerUpdated = await rootSql.unsafe(blankOwnerMigrationSql);
    expect(blankOwnerUpdated.count).toBe(1);

    const outcomes = (await rootSql`
      SELECT conversation_id, outcome
        FROM harness_shared.consult_state
       WHERE workspace_id = ${WS}
         AND conversation_id IN (
           ${legacyAnswered}, ${blankOwnerAnswered}, ${trulyUnanswered}, ${explicitOutcome}, ${stillOpen}, ${scalarDigest}
         )
    `) as unknown as Array<{ conversation_id: string; outcome: unknown }>;
    const byId = new Map(outcomes.map((row) => [row.conversation_id, row.outcome]));
    expect(byId.get(legacyAnswered)).toMatchObject({
      disposition: 'cascade_exhausted_with_answers',
      answers: 3,
      answered_by: ['reviewer-b', 'reviewer-a'],
    });
    expect(byId.get(blankOwnerAnswered)).toEqual({
      disposition: 'cascade_exhausted_with_answers',
      answers: 2,
      answered_by: [],
    });
    expect(byId.get(trulyUnanswered)).toBeNull();
    expect(byId.get(explicitOutcome)).toMatchObject({ disposition: 'requester_recorded', answer: 'keep me' });
    expect(byId.get(stillOpen)).toBeNull();
    expect(byId.get(scalarDigest)).toBeNull();

    const second856 = await rootSql.unsafe(migrationSql);
    const second962 = await rootSql.unsafe(blankOwnerMigrationSql);
    expect(second856.count).toBe(0);
    expect(second962.count).toBe(0);
    const afterSecondRun = (await rootSql`
      SELECT conversation_id, outcome
        FROM harness_shared.consult_state
       WHERE workspace_id = ${WS}
         AND conversation_id IN (${legacyAnswered}, ${blankOwnerAnswered})
       ORDER BY conversation_id
    `) as unknown as Array<{ conversation_id: string; outcome: unknown }>;
    expect(new Map(afterSecondRun.map((row) => [row.conversation_id, row.outcome]))).toEqual(
      new Map([
        [legacyAnswered, byId.get(legacyAnswered)],
        [blankOwnerAnswered, byId.get(blankOwnerAnswered)],
      ]),
    );
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
  it('advances a non-due silent responder as an implicit decline without terminal expiry', async () => {
    const routedAt = new Date(NOW.getTime() - 60_000).toISOString();
    const id = await seedConsult({
      latency: 'hard-blocked',
      expiresAt: FUTURE,
      updatedAt: routedAt,
      routing: menuSnapshot(['resp-1', 'resp-2']),
    });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    const detectorCalls: Array<ReadonlyArray<{ conversationId: string; responderId: string; routedAt: string }>> = [];
    deps.findSilentResponders = async (rows) => {
      detectorCalls.push(rows);
      return new Set([id]);
    };

    const r = await sweepExpiredConsults(deps);

    expect(r).toMatchObject({ advanced: 1, expired: 0, woke: [], saturated: false });
    expect(detectorCalls).toHaveLength(1);
    expect(detectorCalls[0]).toContainEqual({
      workspaceId: WS,
      conversationId: id,
      responderId: 'resp-1',
      routedAt,
    });
    const row = await cascadeRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.closed_at).toBeNull();
    expect(row.responder_id).toBe('resp-2');
    expect(row.cascade_cursor).toBe(1);
    expect(row.cascade_digest).toMatchObject([
      {
        ownerId: 'resp-1',
        kind: 'wake_failed',
        excerpt: 'queued responder did not produce a consult post before bounded pickup recovery (implicit decline)',
      },
    ]);
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(NOW.getTime());
    expect(reachCalls).toHaveLength(1);
  });

  it('wires the production detector into the real-PG cascade for a parked no-pickup responder', async () => {
    const routedAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    const id = await seedConsult({
      latency: 'hard-blocked',
      expiresAt: FUTURE,
      updatedAt: routedAt,
      routing: menuSnapshot(['resp-1', 'resp-2']),
    });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    deps.findSilentResponders = consultExpiryFindSilentResponders({
      getPresence: async () => ({ lastActiveAt: null }),
      resolveSessionStates: async () =>
        new Map([
          ['resp-1', { sessionState: 'parked' }],
          ['resp-2', { sessionState: 'parked' }],
        ]),
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async () => ({ total: 0 }),
      }),
      now: () => NOW,
    });

    const r = await sweepExpiredConsults(deps);

    expect(r).toMatchObject({ advanced: 1, expired: 0, woke: [], saturated: false });
    expect(await cascadeRow(id)).toMatchObject({
      state: 'awaiting_responder',
      closed_at: null,
      responder_id: 'resp-2',
      cascade_cursor: 1,
    });
    expect(reachCalls).toHaveLength(1);
    expect(reachCalls[0]).toMatchObject({ responder: 'resp-2', conversationId: id, workspaceId: WS });
  });

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

// ── WI-39862 honest expiry + WI-39861 min-ANSWERS refill ─────────────────────
describe('sweepExpiredConsults — honest expiry (WI-39862) + min-ANSWERS refill (WI-39861)', () => {
  const liveCand = (ownerId: string, score: number, similarity: number, liveness = 'live') => ({
    ownerId,
    score,
    signals: { similarity },
    liveness,
  });
  const selEntry = (ownerId: string, via: 'floor' | 'minimum' = 'floor') => ({
    ownerId,
    via,
    score: 0.8,
    similarity: 0.7,
    liveness: 'live',
  });
  /** cascadeRow (above) deliberately selects only the cascade columns — these
   * WI-39862/WI-39861 assertions also need routing + outcome. */
  async function fullRow(id: string) {
    const rows = (await rootSql`
      SELECT state, closed_at, responder_id, cascade_cursor, cascade_digest, expires_at, routing, outcome
        FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = ${id}
    `) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (typeof row.cascade_digest === 'string') row.cascade_digest = JSON.parse(row.cascade_digest);
    return row;
  }
  function routingOf(row: Record<string, unknown>): { selection?: { selected?: Array<Record<string, unknown>>; refill?: Record<string, unknown>; min?: number } } {
    return (typeof row.routing === 'string' ? JSON.parse(row.routing) : row.routing) as ReturnType<typeof routingOf>;
  }

  it('terminal expiry WITH collected answers: answered-flavored outcome + NOT-unanswered emit; answers ≥ min suppresses refill', async () => {
    const routing = {
      floor: 0.5,
      simFloor: 0.4,
      // 'c' is live, untried, above-floor — refillable if the guard were wrong.
      candidates: [liveCand('ans-a', 0.9, 0.8), liveCand('exp-b', 0.8, 0.7), liveCand('c', 0.7, 0.6)],
      selection: { min: 1, max: 2, selected: [selEntry('ans-a'), selEntry('exp-b')] },
    };
    const id = await seedConsult({ latency: 'hard-blocked', routing, cascadeCursor: 1 });
    await setDigest(id, [{ ownerId: 'ans-a', kind: 'answer', at: PAST, excerpt: 'a real answer' }]);
    const { deps, emits } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 0, expired: 1, woke: [id] });

    const row = await fullRow(id);
    expect(row.state).toBe('expired');
    const outcome = typeof row.outcome === 'string' ? JSON.parse(row.outcome as string) : row.outcome;
    expect(outcome).toMatchObject({
      disposition: 'cascade_exhausted_with_answers',
      answers: 1,
      answered_by: ['ans-a'],
    });
    // No refill ran: answers (1) ≥ min (1) — menu length unchanged, no stamp.
    const routingRow = routingOf(row);
    expect(routingRow.selection?.selected).toHaveLength(2);
    expect(routingRow.selection?.refill).toBeUndefined();
    // The emit says NOT unanswered and points at the late-close disposition.
    expect(emits).toHaveLength(1);
    expect(emits[0].summary).toContain('NOT unanswered');
    expect(emits[0].summary).toContain('consult:close');
    expect(emits[0].payload).toMatchObject({ conversation_id: id, kind: 'expired', answers: 1 });
  });

  it('zero answers keeps the honest EXPIRED-unanswered emit and a bare outcome', async () => {
    const id = await seedConsult({ latency: 'hard-blocked', routing: menuSnapshot(['only-r']) });
    const { deps, emits } = makeDeps({ withReach: true });
    await sweepExpiredConsults(deps);
    const row = await fullRow(id);
    expect(row.state).toBe('expired');
    expect(row.outcome).toBeNull();
    expect(emits[0].summary).toContain('EXPIRED unanswered');
    expect(emits[0].payload.answers).toBeUndefined();
  });

  it('exhaustion below min with an untried live pool: ONE refill round — menu extended (honest via), refill selectee woken', async () => {
    const routing = {
      floor: 0.5,
      simFloor: 0.4,
      candidates: [
        liveCand('r-a', 0.9, 0.8), // the original (expiring) selectee
        liveCand('r-b', 0.6, 0.5), // above-floor live → refill via 'floor'
        liveCand('r-dead', 0.55, 0.5, 'ended'), // route-time-dead → excluded
        liveCand('r-d', 0.3, 0.2), // below-floor live → refill via 'minimum'
      ],
      selection: { min: 2, max: 2, selected: [selEntry('r-a')] },
    };
    const id = await seedConsult({ routing, cascadeCursor: 0 });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 1, expired: 0 });

    const row = await fullRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.responder_id).toBe('r-b');
    expect(row.cascade_cursor).toBe(1); // first refill entry (old menu length)
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(NOW.getTime()); // fresh window
    const routingRow = routingOf(row);
    expect(routingRow.selection?.selected).toHaveLength(3);
    expect(routingRow.selection?.selected?.[1]).toMatchObject({ ownerId: 'r-b', via: 'floor', refill: true });
    expect(routingRow.selection?.selected?.[2]).toMatchObject({ ownerId: 'r-d', via: 'minimum', refill: true });
    expect(routingRow.selection?.refill).toMatchObject({ added: ['r-b', 'r-d'] });
    expect(reachCalls).toHaveLength(1);
    expect(reachCalls[0]).toMatchObject({ responder: 'r-b', conversationId: id });
    expect(reachCalls[0].summary).toContain('min-answers refill');
    expect(reachCalls[0].body).toContain('reviewer 2/3');
  });

  it('the refill stamp is the ONE-round guard: a second exhaustion is terminal even with pool remaining', async () => {
    const routing = {
      floor: 0.5,
      simFloor: 0.4,
      candidates: [liveCand('s-a', 0.9, 0.8), liveCand('s-b', 0.6, 0.5), liveCand('s-c', 0.55, 0.5)],
      selection: {
        min: 2,
        max: 2,
        selected: [selEntry('s-a'), { ...selEntry('s-b'), refill: true }],
        refill: { at: PAST, added: ['s-b'], reason: 'cascade exhausted with 0 answer(s) < min 2' },
      },
    };
    const id = await seedConsult({ routing, cascadeCursor: 1 });
    const { deps } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 0, expired: 1 });
    const row = await fullRow(id);
    expect(row.state).toBe('expired');
    // s-c stayed untried: the stamp, not pool exhaustion, ended the chain.
    expect(routingOf(row).selection?.selected).toHaveLength(2);
  });
});

describe('P-005 requester alert — real message writer and PG replay boundary', () => {
  async function durableAlerts(id: string) {
    return rootSql<{ workspace_id: string; body: CoordEnvelope }[]>`
      SELECT workspace_id, body FROM harness_shared.coord_event_log
      WHERE surface = 'messages' AND body->>'conversation_id' = ${id}
      ORDER BY id`;
  }

  // A reusable oracle for the actual delivery property, also run against the
  // deliberately broken no-replay-key control below (no shared-tree mutation).
  function assertSingleAlert(rows: Awaited<ReturnType<typeof durableAlerts>>, id: string, ws: string) {
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(ws);
    expect(rows[0].body.to).toEqual(['req-alert']);
    expect(rows[0].body.summary).toContain(id);
    expect(rows[0].body.body).toContain(`conversation_id: "${id}"`);
    expect(rows[0].body.body).toContain('Recovery disposition: pending');
    expect(rows[0].body.body).toContain('never approval');
  }

  async function lostAcknowledgementProbe(latency: 'proceed' | 'hard-blocked', early: boolean, mutate = false) {
    const ws = `ws-alert-${seq + 1}`;
    const id = await seedConsult({
      latency, requesterId: 'req-alert', workspaceId: ws,
      expiresAt: early ? FUTURE : PAST, updatedAt: PAST,
      ...(early ? { routing: menuSnapshot(['resp-1', 'resp-2']) } : {}),
    });
    const first = makeDeps({ withReach: true });
    first.deps.findSilentResponders = async () => new Set([id]);
    first.deps.notifyRequester = consultExpiryNotifyRequester(async (identity, opts) => {
      await sendMessage(identity, mutate ? { ...opts, msgId: undefined } : opts);
      throw new Error('transport acknowledgement lost AFTER commit');
    });
    const attempted = await sweepExpiredConsults(first.deps);
    expect(attempted.requesterAlertFailures).toContain(id);
    expect(await stateOf(id, ws)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    const original = (await durableAlerts(id))[0].body;

    // Fresh binding/deps simulate a restarted producer. No in-memory dedupe
    // state survives; only the durable message id can prevent a second alert.
    const retry = makeDeps({ withReach: true });
    retry.deps.findSilentResponders = async () => new Set([id]);
    retry.deps.now = () => new Date(NOW.getTime() + 1_000);
    retry.deps.notifyRequester = consultExpiryNotifyRequester((identity, opts) =>
      sendMessage(identity, mutate ? { ...opts, msgId: undefined } : opts));
    const recovered = await sweepExpiredConsults(retry.deps);
    expect(recovered.requesterAlerts).toContain(id);
    expect(recovered.requesterAlertFailures).toEqual([]);
    if (early) {
      expect(await cascadeRow(id, ws)).toMatchObject({ cascade_cursor: 1, responder_id: 'resp-2', closed_at: null });
      expect(retry.emits).toHaveLength(0); // do not release the hard-blocked park key mid-chain
    } else {
      expect(await stateOf(id, ws)).toMatchObject({ state: 'expired' });
      expect(recovered.woke.includes(id)).toBe(latency === 'hard-blocked');
    }
    const rows = await durableAlerts(id);
    expect(rows[0].body).toEqual(original); // first durable content survives replay
    // Leave no synthetic live consult for a later test's broad sweep.
    await rootSql`UPDATE harness_shared.consult_state SET closed_at = ${NOW.toISOString()} WHERE conversation_id = ${id}`;
    return { rows, id, ws };
  }

  it.each([
    ['proceed', false], ['hard-blocked', false],
    ['proceed', true], ['hard-blocked', true],
  ] as const)('deduplicates committed alerts after a lost acknowledgement (%s, early=%s)', async (latency, early) => {
    const { rows, id, ws } = await lostAcknowledgementProbe(latency, early);
    assertSingleAlert(rows, id, ws);
  });

  it('mutation control: dropping the replay key is caught by the SAME single-alert oracle', async () => {
    const { rows, id, ws } = await lostAcknowledgementProbe('proceed', true, true);
    expect(rows).toHaveLength(2);
    expect(() => assertSingleAlert(rows, id, ws)).toThrow();
  });

  it.each(['unknown', 'missing', 'throws'])('never invents an early stall from %s liveness', async (mode) => {
    const id = await seedConsult({ expiresAt: FUTURE, updatedAt: PAST });
    const { deps, alerts } = makeDeps();
    deps.findSilentResponders = consultExpiryFindSilentResponders({
      getPresence: async () => null,
      resolveSessionStates: async () => {
        if (mode === 'throws') throw new Error('oracle unavailable');
        return mode === 'missing' ? new Map() : new Map([['resp-1', { sessionState: 'unknown' }]]);
      },
      getThreadStore: () => { throw new Error('unknown is not evidence of an empty consult'); },
      now: () => NOW,
    });
    const result = await sweepExpiredConsults(deps);
    expect(alerts).toEqual([]);
    expect(result).toMatchObject({ expired: 0, advanced: 0, requesterAlerts: [], requesterAlertFailures: [] });
    expect(await stateOf(id)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    await rootSql`UPDATE harness_shared.consult_state SET closed_at = ${NOW.toISOString()} WHERE conversation_id = ${id}`;
  });
});

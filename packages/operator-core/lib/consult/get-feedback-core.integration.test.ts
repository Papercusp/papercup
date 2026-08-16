/**
 * get-feedback-core.integration.test.ts — getFeedbackCore against a real
 * Postgres, P-003 of get-feedback-relevance-consults-2026-08-16.
 *
 * The consult_state table is created by applying the REAL migration file
 * (834-consult-threads.sql, readFileSync) — never a hand-mirrored CREATE that
 * silently falls behind the schema (the known stale-fixture trap). Only the
 * migration's coord_conversations ALTER needs a minimal stub table to land on.
 *
 * What only a real-PG test can prove here:
 *  - the consult_state INSERT satisfies the migration's CHECK constraints
 *    (state enum, latency enum, depth) and the routing snapshot round-trips
 *    VERBATIM through jsonb;
 *  - the D-005 wake-budget aggregation over origin_task_ref against real rows;
 *  - the origin_task_ref default (most recently progressed wip work-item);
 *  - the D-008 §5 liveness gate + the honest no_qualified_responder reasons
 *    (below_floor / no_live_responder / embed_unavailable) all persist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
import type { RouteResult, RoutingCandidate, RoutingSnapshot } from './relevance-router';
import {
  getFeedbackCore,
  HARD_BLOCKED_EXPIRY_MS,
  PROCEED_EXPIRY_MS,
  WAKE_BUDGET_PER_TASK,
  type GetFeedbackDeps,
  type GetFeedbackRequest,
} from './get-feedback-core';

const WS = 'ws-consult-core';
const NOW = new Date('2026-08-16T00:00:00Z');
const MIGRATION_834 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);

let rootSql: Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `consultc_${randomBytes(5).toString('hex')}`;
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
  // Only the columns the core's origin-ref default reads (work_items is
  // migration-owned; the core touches taken_by/status/timestamps/feature_id).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY,
      taken_by text,
      status text,
      taken_at timestamptz,
      last_progress_at timestamptz
    )`);
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

// ── Fixture builders ─────────────────────────────────────────────────────
const cand = (ownerId: string, over: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
  ownerId,
  score: 0.7,
  signals: { similarity: 0.72, recency: 0.5, verification: 0.3, authorship: 0 },
  evidence: [{ session_id: `sess-${ownerId}`, turn_idx: 3, ts: NOW.toISOString(), sim: 0.72 }],
  liveness: 'live',
  ...over,
});

const snapshotOf = (candidates: RoutingCandidate[], degraded?: 'embed-unavailable'): RoutingSnapshot => ({
  query: 'q',
  floor: 0.5,
  simFloor: 0.4,
  weights: { similarity: 0.55, recency: 0.15, verification: 0.15, authorship: 0.15 },
  candidates,
  computedAt: NOW.toISOString(),
  ...(degraded ? { degraded } : {}),
});

const routeOf = (qualified: RoutingCandidate[], opts: { degraded?: 'embed-unavailable'; all?: RoutingCandidate[] } = {}): RouteResult => ({
  verdict: qualified.length > 0 ? 'routed' : 'no_qualified_responder',
  qualified,
  snapshot: snapshotOf(opts.all ?? qualified, opts.degraded),
});

let convSeq = 0;
function makeDeps(route: RouteResult) {
  const opened: Array<Parameters<GetFeedbackDeps['open']>[0]> = [];
  const reached: Array<Parameters<GetFeedbackDeps['reach']>[0]> = [];
  const deps: GetFeedbackDeps = {
    getSql: () => rootSql,
    route: async () => route,
    open: async (input) => {
      opened.push(input);
      convSeq += 1;
      const id = `conv-${convSeq}`;
      return { conversation_id: id, thread_id: `thr-${id}`, delivered: input.direct_to.length };
    },
    reach: async (o) => {
      reached.push(o);
      return { woke: 1 };
    },
    now: () => NOW,
  };
  return { deps, opened, reached };
}

const baseReq: GetFeedbackRequest = {
  workspaceId: WS,
  requesterId: 'req-1',
  question: 'why does the sync resolver drop SSE events under load?',
  originTaskRef: null, // explicit null: no default lookup, no budget aggregation
};

async function stateRow(conversationId: string) {
  const rows = (await rootSql`
    SELECT * FROM harness_shared.consult_state
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
  `) as unknown as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  // This fixture connection returns jsonb unparsed — normalize so assertions
  // compare structure, not driver serialization.
  if (typeof row.routing === 'string') row.routing = JSON.parse(row.routing);
  return row;
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('getFeedbackCore — routed', () => {
  it('routes to the top live candidate, persists the snapshot VERBATIM, wakes with evidence', async () => {
    const top = cand('agent-a');
    const second = cand('agent-b', { score: 0.6 });
    const route = routeOf([top, second]);
    const { deps, opened, reached } = makeDeps(route);

    const r = await getFeedbackCore({ ...baseReq, tried: 'restarted the provider', observed: 'events stop after ~40 queries' }, deps);

    expect(r.verdict).toBe('routed');
    expect(r.state).toBe('awaiting_responder');
    expect(r.responder?.ownerId).toBe('agent-a');
    expect(r.remaining_candidates).toEqual([{ ownerId: 'agent-b', score: 0.6, liveness: 'live' }]);
    expect(r.park_key).toBeNull(); // proceed contract
    expect(r.wake).toMatchObject({ attempted: true, woke: 1, budget_exhausted: false });

    // Conversation: kind consult, addressed to the chosen responder, body carries the sections.
    expect(opened).toHaveLength(1);
    expect(opened[0].kind).toBe('consult');
    expect(opened[0].direct_to).toEqual(['agent-a']);
    expect(opened[0].body).toContain('## Tried');
    expect(opened[0].body).toContain('## Observed');

    // Wake carries the why-you-were-chosen evidence refs (D-008 §5).
    expect(reached).toHaveLength(1);
    expect(reached[0].responder).toBe('agent-a');
    expect(reached[0].body).toContain('sess-agent-a#3');

    // Row: snapshot verbatim, expiry from the proceed contract, wake debited.
    const row = await stateRow(r.conversation_id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.responder_id).toBe('agent-a');
    expect(row.wakes_used).toBe(1);
    expect(row.routing).toEqual(JSON.parse(JSON.stringify(route.snapshot)));
    expect(new Date(row.expires_at as string).getTime()).toBe(NOW.getTime() + PROCEED_EXPIRY_MS);
  });

  it('hard-blocked contract: park_key + the shorter expiry', async () => {
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const r = await getFeedbackCore({ ...baseReq, latencyContract: 'hard-blocked' }, deps);
    expect(r.park_key).toBe(`consult:reply:${r.conversation_id}`);
    expect(r.hint).toContain('events:await');
    const row = await stateRow(r.conversation_id);
    expect(row.latency_contract).toBe('hard-blocked');
    expect(new Date(row.expires_at as string).getTime()).toBe(NOW.getTime() + HARD_BLOCKED_EXPIRY_MS);
  });

  it('liveness gate: a dead top candidate is skipped for the next live one', async () => {
    const deadTop = cand('agent-dead', { score: 0.9, liveness: 'ended' });
    const liveSecond = cand('agent-live', { score: 0.6, liveness: 'parked' });
    const { deps, opened } = makeDeps(routeOf([deadTop, liveSecond]));
    const r = await getFeedbackCore(baseReq, deps);
    expect(r.responder?.ownerId).toBe('agent-live');
    expect(opened[0].direct_to).toEqual(['agent-live']);
    // The skipped dead candidate stays visible for the manual cascade.
    expect(r.remaining_candidates).toEqual([{ ownerId: 'agent-dead', score: 0.9, liveness: 'ended' }]);
  });
});

describe('getFeedbackCore — honest no_qualified_responder', () => {
  it('below_floor: still opens + persists the verdict (D-003 honesty feed), no wake', async () => {
    const { deps, opened, reached } = makeDeps(routeOf([], { all: [cand('agent-sub', { score: 0.3 })] }));
    const r = await getFeedbackCore(baseReq, deps);
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.reason).toBe('below_floor');
    expect(r.hint).toContain('no one knows more than you do');
    expect(opened[0].direct_to).toEqual([]);
    expect(reached).toHaveLength(0);
    const row = await stateRow(r.conversation_id);
    expect(row.state).toBe('no_qualified_responder');
    expect(row.responder_id).toBeNull();
    expect(row.wakes_used).toBe(0);
    expect(row.expires_at).toBeNull();
  });

  it('no_live_responder: qualified experts exist but every one is dead — retrieval fallback', async () => {
    const { deps, reached } = makeDeps(
      routeOf([cand('agent-d1', { liveness: 'ended' }), cand('agent-d2', { liveness: 'recorded' })]),
    );
    const r = await getFeedbackCore(baseReq, deps);
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.reason).toBe('no_live_responder');
    expect(r.hint).toContain('sessions:read');
    expect(r.remaining_candidates.map((c) => c.ownerId)).toEqual(['agent-d1', 'agent-d2']);
    expect(reached).toHaveLength(0);
    const row = await stateRow(r.conversation_id);
    expect(row.state).toBe('no_qualified_responder');
  });

  it('embed_unavailable: cannot-measure ≠ measured-nothing, and the snapshot says so', async () => {
    const { deps } = makeDeps(routeOf([], { degraded: 'embed-unavailable' }));
    const r = await getFeedbackCore(baseReq, deps);
    expect(r.reason).toBe('embed_unavailable');
    expect(r.degraded).toBe('embed-unavailable');
    const row = await stateRow(r.conversation_id);
    expect((row.routing as { degraded?: string }).degraded).toBe('embed-unavailable');
  });
});

describe('getFeedbackCore — wake budget (D-005)', () => {
  it('aggregates wakes_used across consults sharing origin_task_ref; exhausted ⇒ deliver without wake', async () => {
    const ref = 'WI-BUDGET-1';
    // Seed: prior consults for the same originating task have spent the budget.
    for (let i = 0; i < WAKE_BUDGET_PER_TASK; i++) {
      await rootSql`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, requester_id, state, question, origin_task_ref, wakes_used)
        VALUES (${WS}, ${`conv-seed-${ref}-${i}`}, 'req-1', 'awaiting_responder', 'q', ${ref}, 1)`;
    }
    const { deps, reached } = makeDeps(routeOf([cand('agent-a')]));
    const r = await getFeedbackCore({ ...baseReq, originTaskRef: ref }, deps);
    expect(r.verdict).toBe('routed'); // still routed + delivered by subscription
    expect(r.state).toBe('awaiting_responder');
    expect(r.wake).toMatchObject({
      attempted: false,
      woke: 0,
      budget_exhausted: true,
      wakes_used_for_task: WAKE_BUDGET_PER_TASK,
      wake_budget: WAKE_BUDGET_PER_TASK,
    });
    expect(reached).toHaveLength(0);
    const row = await stateRow(r.conversation_id);
    expect(row.wakes_used).toBe(0); // no debit without an attempt
  });

  it('under budget: debits the attempt and reports the running total', async () => {
    const ref = 'WI-BUDGET-2';
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, state, question, origin_task_ref, wakes_used)
      VALUES (${WS}, ${`conv-seed-${ref}`}, 'req-1', 'awaiting_responder', 'q', ${ref}, 2)`;
    const { deps, reached } = makeDeps(routeOf([cand('agent-a')]));
    const r = await getFeedbackCore({ ...baseReq, originTaskRef: ref }, deps);
    expect(r.wake).toMatchObject({ attempted: true, woke: 1, wakes_used_for_task: 3 });
    expect(reached).toHaveLength(1);
  });
});

describe('getFeedbackCore — origin_task_ref default', () => {
  it('defaults to the requester’s most recently progressed wip work-item', async () => {
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, taken_by, status, taken_at, last_progress_at) VALUES
        ('WI-OLD',  'req-1', 'wip',  ${new Date(NOW.getTime() - 3 * 86_400_000).toISOString()}::timestamptz, NULL),
        ('WI-HOT',  'req-1', 'wip',  ${new Date(NOW.getTime() - 2 * 86_400_000).toISOString()}::timestamptz,
                                     ${new Date(NOW.getTime() - 3_600_000).toISOString()}::timestamptz),
        ('WI-DONE', 'req-1', 'done', ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz),
        ('WI-PEER', 'peer',  'wip',  ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`;
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const { originTaskRef: _omit, ...reqNoRef } = baseReq;
    const r = await getFeedbackCore(reqNoRef, deps);
    expect(r.origin_task_ref).toBe('WI-HOT');
    const row = await stateRow(r.conversation_id);
    expect(row.origin_task_ref).toBe('WI-HOT');
  });

  it('explicit null stays null (no lookup, no aggregation)', async () => {
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const r = await getFeedbackCore(baseReq, deps);
    expect(r.origin_task_ref).toBeNull();
  });
});

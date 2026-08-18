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
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
import type { RouteResult, RoutingCandidate, RoutingSnapshot } from './relevance-router';
import {
  getFeedbackCore,
  HARD_BLOCKED_EXPIRY_MS,
  MAX_CONSULT_DEPTH,
  PROCEED_EXPIRY_MS,
  type GetFeedbackDeps,
  type GetFeedbackError,
  type GetFeedbackRequest,
  type GetFeedbackResult,
  readVettingConsultCritique,
} from './get-feedback-core';

/** Narrow the P-005 result union for the tests that expect success. */
function asOk(r: GetFeedbackResult | GetFeedbackError): GetFeedbackResult {
  if ('error' in r) throw new Error(`unexpected getFeedbackCore error: ${r.error}`);
  return r;
}

const WS = 'ws-consult-core';
const NOW = new Date('2026-08-16T00:00:00Z');
const MIGRATION_834 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);
const MIGRATION_837 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/837-consult-query-embedding.sql', import.meta.url),
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
  // P-006 archive-retrieval leg: pgvector (the test image ships it — same
  // idiom as relevance-router.integration.test.ts) + the REAL 837 migration
  // (query_embedding column + hnsw index behind its extension guard).
  await rootSql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await rootSql.unsafe(readFileSync(MIGRATION_837, 'utf8'));
  // Migration 844 (cascade_cursor + cascade_digest) — .sql once armed, .DRAFT
  // while iterating, so the suite is valid on both sides of the arming mv.
  const MIGRATION_844_ARMED = fileURLToPath(
    new URL('../../../../libs/papercusp/libs/db/sql/844-consult-cascade-cursor.sql', import.meta.url),
  );
  await rootSql.unsafe(
    readFileSync(existsSync(MIGRATION_844_ARMED) ? MIGRATION_844_ARMED : `${MIGRATION_844_ARMED}.DRAFT`, 'utf8'),
  );
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

const routeOf = (qualified: RoutingCandidate[], opts: { degraded?: 'embed-unavailable'; all?: RoutingCandidate[]; queryVec?: number[] | null } = {}): RouteResult => ({
  verdict: qualified.length > 0 ? 'routed' : 'no_qualified_responder',
  qualified,
  snapshot: snapshotOf(opts.all ?? qualified, opts.degraded),
  // Default null: existing scenarios exercise the pre-P-006 paths (no archive
  // leg); archive tests pass an explicit vector.
  queryVec: opts.queryVec ?? null,
});

let convSeq = 0;
function makeDeps(route: RouteResult) {
  const opened: Array<Parameters<GetFeedbackDeps['open']>[0]> = [];
  const reached: Array<Parameters<GetFeedbackDeps['reach']>[0]> = [];
  const routeCalls: Array<Parameters<GetFeedbackDeps['route']>[0]> = [];
  const deps: GetFeedbackDeps = {
    getSql: () => rootSql,
    route: async (params) => {
      routeCalls.push(params);
      return route;
    },
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
  return { deps, opened, reached, routeCalls };
}

const baseReq: GetFeedbackRequest = {
  workspaceId: WS,
  requesterId: 'req-1',
  question: 'why does the sync resolver drop SSE events under load?',
  originTaskRef: null, // explicit null: no default lookup, no budget aggregation
};

async function stateRow(conversationId: string, ws: string = WS) {
  const rows = (await rootSql`
    SELECT *, query_embedding IS NOT NULL AS has_query_embedding
      FROM harness_shared.consult_state
     WHERE workspace_id = ${ws} AND conversation_id = ${conversationId}
  `) as unknown as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  // This fixture connection returns jsonb unparsed — normalize so assertions
  // compare structure, not driver serialization.
  if (typeof row.routing === 'string') row.routing = JSON.parse(row.routing);
  if (typeof row.outcome === 'string') row.outcome = JSON.parse(row.outcome);
  return row;
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('getFeedbackCore — routed', () => {
  it('routes to the top live candidate, persists the snapshot VERBATIM, wakes with evidence', async () => {
    const top = cand('agent-a');
    const second = cand('agent-b', { score: 0.6 });
    const route = routeOf([top, second]);
    const { deps, opened, reached } = makeDeps(route);

    const r = asOk(await getFeedbackCore({ ...baseReq, tried: 'restarted the provider', observed: 'events stop after ~40 queries' }, deps));

    expect(r.verdict).toBe('routed');
    expect(r.state).toBe('awaiting_responder');
    expect(r.responder?.ownerId).toBe('agent-a');
    expect(r.remaining_candidates).toEqual([{ ownerId: 'agent-b', score: 0.6, liveness: 'live', via: 'floor' }]);
    expect(r.park_key).toBeNull(); // proceed contract
    expect(r.wake).toEqual({ attempted: true, woke: 1 });

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
    const r = asOk(await getFeedbackCore({ ...baseReq, latencyContract: 'hard-blocked' }, deps));
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
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.responder?.ownerId).toBe('agent-live');
    expect(r.responder_via).toBe('floor');
    expect(opened[0].direct_to).toEqual(['agent-live']);
    // min/max selection: the menu is the SELECTED set only — a dead candidate
    // is never selected, so it no longer pads remaining_candidates (its refs
    // survive in the persisted routing snapshot).
    expect(r.remaining_candidates).toEqual([]);
  });
});

describe('getFeedbackCore — honest no_qualified_responder', () => {
  it('below_floor (pure-floor min:0): still opens + persists the verdict (D-003 honesty feed), no wake', async () => {
    // Under the D-003 global min of 1 a live below-floor pool now ROUTES
    // (minimum-fill) — the honest below_floor verdict survives via min:0.
    const { deps, opened, reached } = makeDeps(routeOf([], { all: [cand('agent-sub', { score: 0.3 })] }));
    const r = asOk(await getFeedbackCore({ ...baseReq, minResponders: 0 }, deps));
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.reason).toBe('below_floor');
    expect(r.hint).toContain('Proceed on your own judgment');
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
    const r = asOk(await getFeedbackCore(baseReq, deps));
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
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.reason).toBe('embed_unavailable');
    expect(r.degraded).toBe('embed-unavailable');
    const row = await stateRow(r.conversation_id);
    expect((row.routing as { degraded?: string }).degraded).toBe('embed-unavailable');
  });
});

describe('getFeedbackCore — wake budget REMOVED (consult-min-max-and-rubric-vetting D-005)', () => {
  it('routes + wakes regardless of how many wakes sibling consults on the same origin ref already spent', async () => {
    const ref = 'WI-BUDGET-1';
    // Seed well past the OLD budget of 4 — under the removed gate this consult
    // would have been delivered by subscription only; now it must still wake.
    for (let i = 0; i < 6; i++) {
      await rootSql`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, requester_id, state, question, origin_task_ref, wakes_used)
        VALUES (${WS}, ${`conv-seed-${ref}-${i}`}, 'req-1', 'awaiting_responder', 'q', ${ref}, 1)`;
    }
    const { deps, reached } = makeDeps(routeOf([cand('agent-a')]));
    const r = asOk(await getFeedbackCore({ ...baseReq, originTaskRef: ref }, deps));
    expect(r.verdict).toBe('routed');
    expect(r.state).toBe('awaiting_responder');
    expect(r.wake).toEqual({ attempted: true, woke: 1 }); // no budget surfaces at all
    expect(r.hint).not.toContain('budget');
    expect(reached).toHaveLength(1);
    const row = await stateRow(r.conversation_id);
    expect(row.wakes_used).toBe(1); // still WRITTEN as a plain stat (D-005)
  });
});

describe('getFeedbackCore — min/max selection (consult-min-max-and-rubric-vetting D-001/D-002/D-003)', () => {
  /** The persisted selection block of a consult_state.routing snapshot. */
  const selectionOf = (routing: unknown) =>
    (routing as { selection?: { min: number; max: number; selected: Array<{ ownerId: string; via: string }> } })
      .selection;

  it('below-floor minimum-fill: routes best-available LIVE, labeled everywhere + honest wake body', async () => {
    const below = cand('agent-min', {
      score: 0.31,
      signals: { similarity: 0.22, recency: 0.5, verification: 0.3, authorship: 0 },
    });
    const { deps, reached } = makeDeps(routeOf([], { all: [below] }));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.verdict).toBe('routed'); // D-003: min 1 fills even below the floor
    expect(r.responder?.ownerId).toBe('agent-min');
    expect(r.responder_via).toBe('minimum');
    expect(r.hint).toContain('minimum-fill'); // the viaNote warning rides the hint
    // D-002 honest wake body: first-principles request, no costumed expertise.
    expect(reached).toHaveLength(1);
    expect(reached[0].body).toContain('BEST-AVAILABLE');
    expect(reached[0].body).toContain('FIRST-PRINCIPLES');
    expect(reached[0].body).toContain('do NOT decline solely for lack of context');
    // Persisted provenance: the snapshot's selection block survives verbatim.
    const sel = selectionOf((await stateRow(r.conversation_id)).routing);
    expect(sel?.min).toBe(1);
    expect(sel?.selected).toEqual([expect.objectContaining({ ownerId: 'agent-min', via: 'minimum' })]);
  });

  it('maxResponders caps the menu; delivery stays single-wake; provenance persisted', async () => {
    const qs = [cand('agent-1', { score: 0.9 }), cand('agent-2', { score: 0.8 }), cand('agent-3', { score: 0.7 })];
    const { deps, reached } = makeDeps(routeOf(qs));
    const r = asOk(await getFeedbackCore({ ...baseReq, maxResponders: 2 }, deps));
    expect(r.responder?.ownerId).toBe('agent-1');
    expect(r.responder_via).toBe('floor');
    expect(r.remaining_candidates).toEqual([{ ownerId: 'agent-2', score: 0.8, liveness: 'live', via: 'floor' }]);
    expect(reached).toHaveLength(1); // cascade, never a parallel-wake set
    const sel = selectionOf((await stateRow(r.conversation_id)).routing);
    expect(sel?.max).toBe(2);
    expect(sel?.selected.map((s) => s.ownerId)).toEqual(['agent-1', 'agent-2']);
  });

  it('minResponders 0 restores pure-floor selection: a live below-floor pool is an honest below_floor', async () => {
    const below = cand('agent-min', { score: 0.31 });
    const { deps, reached } = makeDeps(routeOf([], { all: [below] }));
    const r = asOk(await getFeedbackCore({ ...baseReq, minResponders: 0 }, deps));
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.reason).toBe('below_floor'); // NOT no_live_responder — the pool was live, just below the floor
    expect(reached).toHaveLength(0);
  });

  it('a minimum only fillable by the dead stays unfilled: no_live_responder', async () => {
    const dead = cand('agent-dead', { liveness: 'ended' });
    const { deps, reached } = makeDeps(routeOf([], { all: [dead] }));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.reason).toBe('no_live_responder');
    expect(reached).toHaveLength(0);
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
    const r = asOk(await getFeedbackCore(reqNoRef, deps));
    expect(r.origin_task_ref).toBe('WI-HOT');
    const row = await stateRow(r.conversation_id);
    expect(row.origin_task_ref).toBe('WI-HOT');
  });

  it('explicit null stays null (no lookup, no aggregation)', async () => {
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.origin_task_ref).toBeNull();
  });
});

// ── P-005: recursion lineage — depth + cycle refusal (D-005 / D-007 §7) ──
describe('getFeedbackCore — recursion lineage (P-005)', () => {
  /** Seed a consult_state row that acts as a lineage parent. */
  async function seedParent(opts: {
    id: string;
    requesterId: string;
    responderId: string | null;
    depth?: number;
    parentConsultId?: string | null;
  }): Promise<string> {
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         depth, parent_consult_id)
      VALUES (${WS}, ${opts.id}, ${opts.requesterId}, ${opts.responderId},
              'active', 'parent q', ${opts.depth ?? 0}, ${opts.parentConsultId ?? null})`;
    return opts.id;
  }

  it('a consult opened from within a consult carries parent depth+1 and persists the lineage', async () => {
    const parent = await seedParent({ id: 'lin-d0', requesterId: 'req-1', responderId: 'resp-b' });
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-c')]));
    const r = asOk(
      await getFeedbackCore({ ...baseReq, requesterId: 'resp-b', parentConsultId: parent }, deps),
    );
    expect(r.verdict).toBe('routed');
    const row = await stateRow(r.conversation_id);
    expect(row.depth).toBe(1);
    expect(row.parent_consult_id).toBe(parent);
    // The lineage's participants were excluded from routing (cycle refusal by construction).
    expect(routeCalls[0].excludeOwners).toEqual(expect.arrayContaining(['req-1', 'resp-b']));
  });

  it(`depth past ${MAX_CONSULT_DEPTH} is refused structurally — before any row/conversation is written`, async () => {
    await seedParent({ id: 'lin-deep-0', requesterId: 'a', responderId: 'b' });
    await seedParent({ id: 'lin-deep-1', requesterId: 'b', responderId: 'c', depth: 1, parentConsultId: 'lin-deep-0' });
    await seedParent({ id: 'lin-deep-2', requesterId: 'c', responderId: 'd', depth: 2, parentConsultId: 'lin-deep-1' });
    const { deps, opened } = makeDeps(routeOf([cand('agent-e')]));
    const r = await getFeedbackCore({ ...baseReq, requesterId: 'd', parentConsultId: 'lin-deep-2' }, deps);
    expect(r).toMatchObject({ error: 'consult_depth_exceeded', depth: 3, max_depth: MAX_CONSULT_DEPTH });
    expect(opened).toHaveLength(0); // no conversation, no consult_state row
  });

  it('the whole lineage chain (not just the direct parent) is excluded from routing', async () => {
    await seedParent({ id: 'lin-chain-0', requesterId: 'root-req', responderId: 'mid-resp' });
    await seedParent({ id: 'lin-chain-1', requesterId: 'mid-resp', responderId: 'leaf-resp', depth: 1, parentConsultId: 'lin-chain-0' });
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-fresh')]));
    const r = asOk(
      await getFeedbackCore({ ...baseReq, requesterId: 'leaf-resp', parentConsultId: 'lin-chain-1' }, deps),
    );
    expect(r.verdict).toBe('routed');
    expect(routeCalls[0].excludeOwners).toEqual(
      expect.arrayContaining(['root-req', 'mid-resp', 'leaf-resp']),
    );
    expect((await stateRow(r.conversation_id)).depth).toBe(2);
  });

  it('belt+braces: a route that hands back a lineage owner anyway is refused as consult_cycle', async () => {
    const parent = await seedParent({ id: 'lin-cycle', requesterId: 'cyc-req', responderId: 'cyc-resp' });
    // A (hypothetical, non-excluding) route impl returning the original requester.
    const { deps, opened } = makeDeps(routeOf([cand('cyc-req')]));
    const r = await getFeedbackCore({ ...baseReq, requesterId: 'cyc-resp', parentConsultId: parent }, deps);
    expect(r).toMatchObject({ error: 'consult_cycle' });
    if ('error' in r && r.error === 'consult_cycle') {
      expect(r.lineage).toEqual(expect.arrayContaining(['cyc-req', 'cyc-resp']));
    }
    expect(opened).toHaveLength(0);
  });

  it('an unknown parent_consult_id is refused (parent_consult_not_found)', async () => {
    const { deps, opened } = makeDeps(routeOf([cand('agent-a')]));
    const r = await getFeedbackCore({ ...baseReq, parentConsultId: 'no-such-consult' }, deps);
    expect(r).toMatchObject({ error: 'parent_consult_not_found', parent_consult_id: 'no-such-consult' });
    expect(opened).toHaveLength(0);
  });

  it('a requester-initiated consult (no parent) stays depth 0 with no lineage exclusions', async () => {
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-a')]));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect((await stateRow(r.conversation_id)).depth).toBe(0);
    expect(routeCalls[0].excludeOwners).toBeUndefined();
  });
});

// ── P-006: archive-first retrieval ───────────────────────────────────────
// Each test uses its OWN workspace: the archive lookup matches any
// closed_answered row in the workspace, so shared-workspace seeds would
// couple the tests to execution order.

/** 384-d unit vector at angle θ in the (0,1) plane — cosine sim between two
 * vecAt angles is exactly cos(θ₁−θ₂), so archive similarity is controllable
 * (same idiom as relevance-router.integration.test.ts). */
function vecAt(theta: number): number[] {
  const v: number[] = new Array(384).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

/** Seed a CLOSED consult directly (the archive population). */
async function seedClosedConsult(opts: {
  ws: string;
  conv: string;
  vec: number[];
  responder?: string | null;
  outcome?: Record<string, unknown>;
}): Promise<void> {
  // sql.json, NOT JSON.stringify + ::jsonb: this fixture connection runs
  // prepare:true, under which the hand-stringified idiom double-encodes into a
  // jsonb STRING scalar (->>'key' = NULL) — the exact corruption the core's
  // no-copy-of-copy predicate test would then falsely pass/fail on.
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       routing, outcome, closed_at, query_embedding)
    VALUES
      (${opts.ws}, ${opts.conv}, 'req-past', ${opts.responder ?? 'resp-arch'},
       'closed_answered', 'an earlier, similar question',
       '{}'::jsonb, ${rootSql.json((opts.outcome ?? { answer: 'archived answer', confidence: 'high' }) as never)},
       ${NOW.toISOString()}::timestamptz, ${JSON.stringify(opts.vec)}::vector)
  `;
}

describe('getFeedbackCore — archive-first retrieval (P-006)', () => {
  const qv = vecAt(0);

  it('a closed_answered consult with a highly similar question serves from the archive: instant close, no wake, provenance cited', async () => {
    const ws = 'ws-arch-serve';
    await seedClosedConsult({
      ws,
      conv: 'arch-src-1',
      vec: vecAt(0), // sim 1.0 vs qv
      responder: 'resp-arch',
      outcome: { answer: 'bump hnsw.ef_search', confidence: 'high' },
    });
    const { deps, opened, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));

    expect(r.verdict).toBe('served_from_archive');
    expect(r.state).toBe('served_from_archive');
    expect(r.archive).toMatchObject({
      source_conversation_id: 'arch-src-1',
      responder_id: 'resp-arch',
      answer: { answer: 'bump hnsw.ef_search', confidence: 'high' },
    });
    expect(r.archive!.sim).toBeGreaterThanOrEqual(0.99);
    expect(r.hint).toContain('arch-src-1');
    // No wake, no budget: served, not consulted (D-006).
    expect(reached).toHaveLength(0);
    expect(r.wake).toMatchObject({ attempted: false, woke: 0 });
    // The conversation row still exists (D-008 §1 PK) but is delivered to no one.
    expect(opened).toHaveLength(1);
    expect(opened[0].direct_to).toEqual([]);
    // DB row REUSES closed_answered (no enum widening) + outcome.source='archive'.
    const row = await stateRow(r.conversation_id, ws);
    expect(row.state).toBe('closed_answered');
    expect(row.closed_at).not.toBeNull();
    expect(row.wakes_used).toBe(0);
    expect(row.outcome).toMatchObject({ source: 'archive', source_conversation_id: 'arch-src-1' });
    expect(row.has_query_embedding).toBe(true);
  });

  it('a dissimilar archive row does not serve — normal routing proceeds, and the new consult forward-fills query_embedding', async () => {
    const ws = 'ws-arch-dissimilar';
    await seedClosedConsult({ ws, conv: 'arch-orth', vec: vecAt(Math.PI / 2) }); // sim 0 vs qv
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));

    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1); // woken as usual
    // Forward-fill: the routed consult still stores its embedding, growing the archive.
    const row = await stateRow(r.conversation_id, ws);
    expect(row.state).toBe('awaiting_responder');
    expect(row.has_query_embedding).toBe(true);
  });

  it('archive-served copies are never re-served — only ORGANIC closes are sources (no copy-of-copy chains)', async () => {
    const ws = 'ws-arch-no-chain';
    // The ONLY archive row is itself archive-served (outcome.source='archive'),
    // at sim 1.0 — it must be excluded from candidacy.
    await seedClosedConsult({
      ws,
      conv: 'arch-copy',
      vec: vecAt(0),
      outcome: { source: 'archive', source_conversation_id: 'arch-src-0', answer: { answer: 'copied' } },
    });
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));

    expect(r.verdict).toBe('routed'); // NOT served_from_archive
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it('falsifiability: archiveFloor 0 serves even a maximally-dissimilar archive row (the floor comparison is live)', async () => {
    const ws = 'ws-arch-floor-zero';
    await seedClosedConsult({ ws, conv: 'arch-far', vec: vecAt(Math.PI / 2) }); // sim 0
    const { deps } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws, archiveFloor: 0 }, deps));
    expect(r.verdict).toBe('served_from_archive');
    expect(r.archive?.source_conversation_id).toBe('arch-far');
  });

  it('falsifiability: an unreachable archiveFloor never serves even an identical question', async () => {
    const ws = 'ws-arch-floor-unreachable';
    await seedClosedConsult({ ws, conv: 'arch-same', vec: vecAt(0) }); // sim 1.0
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws, archiveFloor: 2 }, deps));
    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it('no queryVec (embed degrade): the archive leg is skipped and the insert stores no embedding', async () => {
    const ws = 'ws-arch-no-vec';
    await seedClosedConsult({ ws, conv: 'arch-unreachable', vec: vecAt(0) });
    const { deps } = makeDeps(routeOf([cand('cand-live')])); // queryVec: null (default)
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));
    expect(r.verdict).toBe('routed');
    const row = await stateRow(r.conversation_id, ws);
    expect(row.has_query_embedding).toBe(false);
  });
});

// ── readVettingConsultCritique (EI-20821478338037350) ──────────────────────
//
// The rubric-vetting gate's predicate is SQL, and the emit-side unit suite
// mocks this function wholesale — so the authorship and kind exclusions that
// make it mean "critique happened" rather than "a row exists" are only ever
// exercised HERE, against the real migration-834 tables.
describe('readVettingConsultCritique — the vetting gate reads CRITIQUE, not existence', () => {
  const WSV = 'ws-vetting';
  const REQUESTER = 'su-rubric-author'; // opens the consult AND emits the attestation

  /** Seed one consult + its typed posts. Post rows are [author, kind] pairs. */
  async function seedConsult(
    conv: string,
    state: string,
    posts: [author: string | null, kind: string][],
  ) {
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, state, question)
      VALUES (${WSV}, ${conv}, ${REQUESTER}, ${state}, 'critique this rubric')
    `;
    let postId = Math.floor(Math.random() * 1_000_000) * 100;
    for (const [author, kind] of posts) {
      await rootSql`
        INSERT INTO harness_shared.consult_post_meta
          (workspace_id, post_id, conversation_id, author_id, kind)
        VALUES (${WSV}, ${(postId += 1)}, ${conv}, ${author}, ${kind})
      `;
    }
  }

  it('a consult with no row at all is exists:false — a DANGLING link, distinct from an unanswered one', async () => {
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-nonexistent', REQUESTER);
    expect(v).toEqual({ exists: false, state: null, critiquePosts: 0, declinePosts: 0, critics: [] });
  });

  it('an opened-but-unanswered consult is exists:true with ZERO critique — the hole this closes', async () => {
    await seedConsult('conv-silent', 'awaiting_responder', []);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-silent', REQUESTER);
    expect(v).toMatchObject({ exists: true, state: 'awaiting_responder', critiquePosts: 0, critics: [] });
  });

  it('counts a third-party reply as critique and names its author', async () => {
    await seedConsult('conv-answered', 'active', [
      ['su-reviewer', 'answer'],
      ['su-reviewer', 'new_fact'],
    ]);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-answered', REQUESTER);
    expect(v).toMatchObject({ exists: true, critiquePosts: 2, declinePosts: 0, critics: ['su-reviewer'] });
  });

  it('EXCLUDES the requester’s own follow-ups — the ask is not the answer', async () => {
    await seedConsult('conv-self-only', 'awaiting_responder', [
      [REQUESTER, 'question'],
      [REQUESTER, 'new_fact'],
    ]);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-self-only', REQUESTER);
    expect(v.critiquePosts).toBe(0);
    expect(v.critics).toEqual([]);
  });

  it('EXCLUDES the EMITTER even when the emitter is not the requester — self-critique is not vetting', async () => {
    await seedConsult('conv-emitter-posts', 'active', [['su-emitter', 'answer']]);
    // Requester opened it; su-emitter is attesting, so su-emitter's own post cannot count.
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-emitter-posts', 'su-emitter');
    expect(v.critiquePosts).toBe(0);
    // CONTROL: the same row IS critique for a different emitter — proving the
    // exclusion is authorship-driven, not a predicate stuck at zero.
    const other = await readVettingConsultCritique(rootSql, WSV, 'conv-emitter-posts', REQUESTER);
    expect(other.critiquePosts).toBe(1);
    expect(other.critics).toEqual(['su-emitter']);
  });

  it('a DECLINE is not critique — counted separately so the refusal can say "re-route", not "wait"', async () => {
    await seedConsult('conv-declined', 'declined', [
      ['su-a', 'decline'],
      ['su-b', 'decline'],
    ]);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-declined', REQUESTER);
    expect(v).toMatchObject({ critiquePosts: 0, declinePosts: 2, critics: [] });
  });

  it('a NULL author cannot evidence external critique', async () => {
    await seedConsult('conv-null-author', 'active', [[null, 'answer']]);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-null-author', REQUESTER);
    expect(v.critiquePosts).toBe(0);
  });

  it('is workspace-scoped — a same-named consult in another workspace is invisible', async () => {
    await seedConsult('conv-scoped', 'active', [['su-reviewer', 'answer']]);
    const v = await readVettingConsultCritique(rootSql, 'ws-other', 'conv-scoped', REQUESTER);
    expect(v.exists).toBe(false);
  });
});

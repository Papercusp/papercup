/**
 * consult-verbs-core.integration.test.ts — the responder-side consult verbs
 * against a real Postgres, P-004 of get-feedback-relevance-consults-2026-08-16.
 *
 * Bootstrap mirrors get-feedback-core.integration.test.ts: the consult tables
 * are created by applying the REAL migration file (834-consult-threads.sql,
 * readFileSync) — never a hand-mirrored CREATE that silently falls behind the
 * schema. The conversation substrate is stubbed at the deps.post seam (the
 * conversations-core kind gate has its own unit pins).
 *
 * What only a real-PG test can prove here:
 *  - the consult_post_meta INSERT satisfies the migration's kind CHECK and the
 *    evidence jsonb round-trips;
 *  - the state transitions land under the consult_state state CHECK
 *    (awaiting_responder→active, →declined, →closed_answered/closed_cant_help)
 *    with outcome/closed_at written;
 *  - exchange-cap arithmetic against real column defaults (max_exchanges 4);
 *  - the D-005 follow-up wake-budget aggregation over origin_task_ref rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import {
  consultCloseCore,
  consultDeclineCore,
  consultReplyCore,
  type ConsultVerbDeps,
} from './consult-verbs-core';
import { advanceCascade, makeDigestEntry } from './cascade-core';

const WS = 'ws-consult-verbs';
const NOW = new Date('2026-08-16T00:00:00Z');
const REQUESTER = 'req-1';
const RESPONDER = 'resp-1';
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
  const dbName = `consultv_${randomBytes(5).toString('hex')}`;
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
      workspace_id text NOT NULL,
      id text NOT NULL,
      kind text NOT NULL DEFAULT 'question',
      state text NOT NULL DEFAULT 'open',
      accepted_answer text,
      accepted_post_id bigint,
      updated_at timestamptz,
      resolved_at timestamptz,
      PRIMARY KEY (workspace_id, id)
    )`);
  // The REAL migration — consult_state + consult_post_meta cannot drift.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_844, 'utf8'));
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

// ── Fixture builders ─────────────────────────────────────────────────────

let convSeq = 0;
let postSeq = 100;

interface SeedOpts {
  state?: string;
  responderId?: string | null;
  exchangesUsed?: number;
  maxExchanges?: number;
  wakesUsed?: number;
  originTaskRef?: string | null;
  routing?: unknown;
  latency?: string;
}

/** Insert a consult_state row directly (P-003's writer owns the real path;
 * these verbs only ever see an existing row). Returns the conversation id. */
async function seedConsult(opts: SeedOpts = {}): Promise<string> {
  convSeq += 1;
  const id = `conv-v-${convSeq}`;
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, max_exchanges, exchanges_used, wakes_used, origin_task_ref, routing)
    VALUES
      (${WS}, ${id}, ${REQUESTER}, ${opts.responderId === undefined ? RESPONDER : opts.responderId},
       ${opts.state ?? 'awaiting_responder'}, 'q', ${opts.latency ?? 'proceed'},
       ${opts.maxExchanges ?? 4}, ${opts.exchangesUsed ?? 0}, ${opts.wakesUsed ?? 0},
       ${opts.originTaskRef ?? null}, ${rootSql.json((opts.routing ?? {}) as never)})
  `;
  await rootSql`
    INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind, state, updated_at)
    VALUES (${WS}, ${id}, 'consult', 'open', ${NOW.toISOString()}::timestamptz)
  `;
  return id;
}

function makeDeps(
  opts: {
    postError?: string;
    withReach?: boolean;
    withMint?: boolean;
    mintError?: string;
    withSettlement?: boolean;
    settlementError?: string;
  } = {},
) {
  const posts: Array<{ conversation_id: string; body: string; via_consult_verb: true }> = [];
  const emits: Array<{ key: string; summary: string; payload: Record<string, unknown>; to: string[] }> = [];
  const reached: Array<{ responder: string; conversationId: string }> = [];
  const reachCalls: Array<{ responder: string; conversationId: string; summary: string; body: string }> = [];
  const minted: Array<Parameters<NonNullable<ConsultVerbDeps['mintGraduationWorkItem']>>[0]> = [];
  const settlements: Array<Parameters<NonNullable<ConsultVerbDeps['settleConversation']>>[0]> = [];
  const deps: ConsultVerbDeps = {
    getSql: () => rootSql,
    post: async (input) => {
      if (opts.postError) return { error: opts.postError };
      posts.push(input);
      postSeq += 1;
      const post: ThreadPostRow = {
        id: postSeq,
        thread_id: `thr-${input.conversation_id}`,
        author_id: 'author',
        body: input.body,
        created_ts: NOW.toISOString(),
      };
      return { post, delivered: 1 };
    },
    emitReplyEvent: async (e) => {
      emits.push(e);
    },
    ...(opts.withSettlement
      ? {
          settleConversation: async (
            input: Parameters<NonNullable<ConsultVerbDeps['settleConversation']>>[0],
            tx: Parameters<NonNullable<ConsultVerbDeps['settleConversation']>>[1],
          ) => {
            settlements.push(input);
            if (opts.settlementError) throw new Error(opts.settlementError);
            if (!tx) throw new Error('settlement transaction missing');
            await tx`
              UPDATE harness_shared.coord_conversations
                 SET state = ${input.outcome === 'answered' ? 'resolved' : 'closed'},
                     accepted_answer = ${input.answer ?? null},
                     accepted_post_id = ${input.outcome === 'answered' ? input.postId : null},
                     updated_at = ${input.now}::timestamptz,
                     resolved_at = ${input.outcome === 'answered' ? input.now : null}::timestamptz
               WHERE workspace_id = ${WS} AND id = ${input.conversationId}
            `;
          },
        }
      : {}),
    ...(opts.withReach === false
      ? {}
      : {
          reach: async (o) => {
            reached.push({ responder: o.responder, conversationId: o.conversationId });
            reachCalls.push(o);
            return { woke: 1 };
          },
        }),
    ...(opts.withMint || opts.mintError
      ? {
          mintGraduationWorkItem: async (input) => {
            if (opts.mintError) throw new Error(opts.mintError);
            minted.push(input);
            return { id: `WI-GRAD-${minted.length}` };
          },
        }
      : {}),
    now: () => NOW,
  };
  return { deps, posts, emits, reached, reachCalls, minted, settlements };
}

async function stateRow(conversationId: string) {
  const rows = (await rootSql`
    SELECT * FROM harness_shared.consult_state
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
  `) as unknown as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  // This fixture connection returns jsonb unparsed — normalize before asserting.
  for (const k of ['routing', 'outcome', 'cascade_digest'] as const) {
    if (typeof row[k] === 'string') row[k] = JSON.parse(row[k] as string);
  }
  return row;
}

async function metaRows(conversationId: string) {
  const rows = (await rootSql`
    SELECT * FROM harness_shared.consult_post_meta
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
     ORDER BY post_id
  `) as unknown as Array<Record<string, unknown>>;
  for (const row of rows) {
    if (typeof row.evidence === 'string') row.evidence = JSON.parse(row.evidence);
  }
  return rows;
}

async function jsonbShapes(conversationId: string) {
  const rows = (await rootSql`
    SELECT jsonb_typeof(routing) AS routing_type,
           jsonb_typeof(outcome) AS outcome_type,
           jsonb_typeof(cascade_digest) AS cascade_digest_type
      FROM harness_shared.consult_state
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
  `) as unknown as Array<{
    routing_type: string | null;
    outcome_type: string | null;
    cascade_digest_type: string | null;
  }>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function evidenceJsonbType(conversationId: string) {
  const rows = (await rootSql`
    SELECT jsonb_typeof(evidence) AS evidence_type
      FROM harness_shared.consult_post_meta
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
     ORDER BY post_id
     LIMIT 1
  `) as unknown as Array<{ evidence_type: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].evidence_type;
}

const EVIDENCE = [{ session_id: 'sess-r', turn_idx: 7, note: 'the debug session' }];

// ── consult:reply ────────────────────────────────────────────────────────
describe('consultReplyCore — kind rules + transitions', () => {
  it('responder answer: meta row with evidence, awaiting_responder→active, park-key emit to the requester', async () => {
    const id = await seedConsult();
    const { deps, posts, emits } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'the answer', evidence: EVIDENCE },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.role).toBe('responder');
    expect(r.state).toBe('active');
    expect(r.exchanges_used).toBe(0); // a PERSPECTIVE reply is cap-exempt and does not debit (D-005)
    expect(r.wake).toBeUndefined(); // responder replies carry no wake report
    expect(r.cascade).toEqual({ advanced_to: null, exhausted: true, woke: 0 }); // seed has no selection menu

    // Write-through went via the (gated) post seam.
    expect(posts).toEqual([{ conversation_id: id, body: 'the answer', via_consult_verb: true }]);

    // Typed overlay landed under the migration's kind CHECK, evidence verbatim.
    const meta = await metaRows(id);
    expect(meta).toHaveLength(1);
    expect(meta[0].kind).toBe('answer');
    expect(meta[0].author_id).toBe(RESPONDER);
    expect(meta[0].evidence).toEqual(EVIDENCE);
    expect(await evidenceJsonbType(id)).toBe('array');

    // State row transitioned; a perspective reply does NOT debit the cap (D-005).
    const row = await stateRow(id);
    expect(row.state).toBe('active');
    expect(row.exchanges_used).toBe(0);
    expect(await jsonbShapes(id)).toEqual({ routing_type: 'object', outcome_type: null, cascade_digest_type: 'array' });

    // The hard-blocked requester's park key fired, latched, addressed to them.
    expect(emits).toHaveLength(1);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
    expect(emits[0].to).toEqual([REQUESTER]);
    expect(emits[0].payload.post_id).toBe(r.post_id);
  });

  it('an answer WITHOUT evidence is refused (D-004 grounding) — nothing written', async () => {
    const id = await seedConsult();
    const { deps, posts } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'ungrounded' },
      deps,
    );
    expect(r).toMatchObject({ error: 'evidence_required' });
    expect(posts).toHaveLength(0);
    expect(await metaRows(id)).toHaveLength(0);
  });

  it('kind rules per role: responder cannot post question; requester cannot post answer/clarifying_question', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps();
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'question', body: 'b' }, deps),
    ).toMatchObject({ error: 'invalid_kind', role: 'responder' });
    expect(
      await consultReplyCore(
        { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'answer', body: 'b', evidence: EVIDENCE },
        deps,
      ),
    ).toMatchObject({ error: 'invalid_kind', role: 'requester' });
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'clarifying_question', body: 'b' }, deps),
    ).toMatchObject({ error: 'invalid_kind', role: 'requester' });
  });

  it('a non-participant is refused; an unknown conversation is not_a_consult', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps();
    const refused = await consultReplyCore(
      { workspaceId: WS, authorId: 'stranger', conversationId: id, kind: 'new_fact', body: 'b' },
      deps,
    );
    // EI-21385436565682208: the refusal must NAME the remedy — participation is
    // router-assigned, so conversations:join can never fix a not_a_participant.
    expect(refused).toMatchObject({
      error: 'not_a_participant',
      hint: expect.stringContaining('consult:get_feedback'),
    });
    expect(refused).toMatchObject({ hint: expect.stringContaining('conversations:join cannot enroll you') });
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: 'conv-none', kind: 'new_fact', body: 'b' }, deps),
    ).toEqual({ error: 'not_a_consult' });
  });

  it('terminal states refuse posts, with the decline hint pointing at the cascade', async () => {
    const declined = await seedConsult({ state: 'declined' });
    const closed = await seedConsult({ state: 'closed_answered' });
    const { deps } = makeDeps();
    const r1 = await consultReplyCore({ workspaceId: WS, authorId: REQUESTER, conversationId: declined, kind: 'question', body: 'b' }, deps);
    expect(r1).toMatchObject({ error: 'consult_not_open', state: 'declined' });
    if ('error' in r1 && r1.error === 'consult_not_open') expect(r1.hint).toContain('exclude');
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: closed, kind: 'answer', body: 'b', evidence: EVIDENCE }, deps),
    ).toMatchObject({ error: 'consult_not_open', state: 'closed_answered' });
  });

  it('allows only the explicitly assigned manual responder to post a new_fact fallback on no_qualified_responder', async () => {
    const id = await seedConsult({ state: 'no_qualified_responder', responderId: RESPONDER });
    const { deps, posts } = makeDeps();

    const reply = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'new_fact', body: 'manual fallback finding' },
      deps,
    );
    if ('error' in reply) throw new Error(reply.error);
    expect(reply.role).toBe('responder');
    expect(reply.state).toBe('active');
    expect(posts).toEqual([{ conversation_id: id, body: 'manual fallback finding', via_consult_verb: true }]);

    const noAssignment = await seedConsult({ state: 'no_qualified_responder', responderId: null });
    expect(
      await consultReplyCore(
        { workspaceId: WS, authorId: RESPONDER, conversationId: noAssignment, kind: 'new_fact', body: 'unassigned' },
        deps,
      ),
    ).toMatchObject({ error: 'consult_not_open', state: 'no_qualified_responder' });
  });

  it('the exchange cap refuses a reply with the close-instead nudge; close still works AT the cap', async () => {
    const id = await seedConsult({ state: 'active', exchangesUsed: 4, maxExchanges: 4 });
    const { deps, posts } = makeDeps();
    // The cap binds NON-perspective posts (a requester follow-up here) — the
    // current responder's perspective reply is deliberately cap-exempt (D-005).
    const refused = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body: 'one more thing' },
      deps,
    );
    expect(refused).toMatchObject({ error: 'exchange_cap', exchanges_used: 4, max_exchanges: 4 });
    if ('error' in refused && refused.error === 'exchange_cap') expect(refused.hint).toContain('consult:close');
    expect(posts).toHaveLength(0);

    // The terminal move stays available — that is the point of the nudge.
    const closed = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered', answer: 'what we have' },
      deps,
    );
    if ('error' in closed) throw new Error(closed.error);
    expect(closed.state).toBe('closed_answered');
  });

  it('a post-seam failure passes through and writes NO meta/state', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps({ postError: 'not_found' });
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'new_fact', body: 'b' }, deps),
    ).toEqual({ error: 'post_failed', cause: 'not_found' });
    expect(await metaRows(id)).toHaveLength(0);
    expect((await stateRow(id)).exchanges_used).toBe(0);
  });
});

describe('consultReplyCore — requester follow-up wake (budget REMOVED, consult-min-max-and-rubric-vetting D-005)', () => {
  it('wakes the responder and debits the wakes_used stat', async () => {
    const ref = 'WI-V-BUDGET-1';
    const id = await seedConsult({ state: 'active', originTaskRef: ref, wakesUsed: 1 });
    const { deps, reached, emits } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'question', body: 'and what about X?' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.role).toBe('requester');
    expect(r.wake).toEqual({ attempted: true, woke: 1 }); // no budget surfaces at all
    expect(reached).toEqual([{ responder: RESPONDER, conversationId: id }]);
    expect(emits).toHaveLength(0); // requester posts never fire the park key
    expect((await stateRow(id)).wakes_used).toBe(2);
    const meta = await metaRows(id);
    expect(meta[0].kind).toBe('question');
  });

  it('wakes even when sibling consults on the same origin ref spent what was once the budget', async () => {
    const ref = 'WI-V-BUDGET-2';
    // Sibling consults on the same origin ref carry 4 wakes — the OLD budget
    // ceiling. Under the removed gate this follow-up would have been
    // subscription-only; now it must still wake (D-005: max_exchanges is the
    // remaining per-consult bound).
    for (let i = 0; i < 4; i++) await seedConsult({ originTaskRef: ref, wakesUsed: 1 });
    const id = await seedConsult({ state: 'active', originTaskRef: ref, wakesUsed: 0 });
    const { deps, reached } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body: 'found another log line' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.wake).toEqual({ attempted: true, woke: 1 });
    expect(r.hint).not.toContain('exhausted');
    expect(reached).toHaveLength(1);
    expect((await stateRow(id)).wakes_used).toBe(1); // debit on the attempt — a plain stat
    expect((await stateRow(id)).exchanges_used).toBe(1);
  });
});

// ── consult:decline ──────────────────────────────────────────────────────
describe('consultDeclineCore', () => {
  const SNAPSHOT = {
    query: 'q',
    floor: 0.5,
    candidates: [
      { ownerId: RESPONDER, score: 0.8, liveness: 'live' },
      { ownerId: 'agent-next', score: 0.7, liveness: 'parked' },
      { ownerId: 'agent-dead', score: 0.65, liveness: 'ended' },
      { ownerId: 'agent-third', score: 0.6, liveness: 'live' },
    ],
  };

  it('declines: state+outcome+closed_at, decline meta, park-key emit, cascade menu (decliner + route-time-dead excluded)', async () => {
    const id = await seedConsult({ routing: SNAPSHOT });
    const { deps, emits } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'my transcript covers the file, not this subsystem' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('declined');
    expect(r.remaining_candidates).toEqual([
      { ownerId: 'agent-next', score: 0.7, liveness: 'parked' },
      { ownerId: 'agent-third', score: 0.6, liveness: 'live' },
    ]);
    expect(r.hint).toContain('cascade menu is exhausted'); // no selection block in the seed ⇒ terminal decline (D-005)

    const row = await stateRow(id);
    expect(row.state).toBe('declined');
    expect(row.outcome).toEqual({ reason: 'my transcript covers the file, not this subsystem' });
    expect(row.closed_at).not.toBeNull();
    expect(await jsonbShapes(id)).toEqual({ routing_type: 'object', outcome_type: 'object', cascade_digest_type: 'array' });

    const meta = await metaRows(id);
    expect(meta).toHaveLength(1);
    expect(meta[0].kind).toBe('decline');

    // A parked hard-blocked requester wakes on the decline too.
    expect(emits).toHaveLength(1);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
    expect(emits[0].to).toEqual([REQUESTER]);
  });

  it('only the responder may decline; a blank reason is refused', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps();
    expect(
      await consultDeclineCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, reason: 'r' }, deps),
    ).toEqual({ error: 'not_the_responder' });
    expect(
      await consultDeclineCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: '   ' }, deps),
    ).toEqual({ error: 'reason_required' });
  });

  it('an empty/absent snapshot yields an empty cascade menu, honestly', async () => {
    const id = await seedConsult({ routing: {} });
    const { deps } = makeDeps();
    const r = await consultDeclineCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'nope' }, deps);
    if ('error' in r) throw new Error(r.error);
    expect(r.remaining_candidates).toEqual([]);
    expect(r.hint).toContain('own judgment');
  });
});

// ── consult:close ────────────────────────────────────────────────────────
describe('consultCloseCore', () => {
  it('answered: structured outcome {answer, confidence, evidence}, closed_answered, close meta, responder emit', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits, posts, settlements } = makeDeps({ withSettlement: true });
    const r = await consultCloseCore(
      {
        workspaceId: WS,
        authorId: RESPONDER,
        conversationId: id,
        outcome: 'answered',
        answer: 'the pool starves under POLLING',
        confidence: 0.8,
        evidence: EVIDENCE,
      },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('closed_answered');

    const row = await stateRow(id);
    expect(row.state).toBe('closed_answered');
    expect(row.outcome).toEqual({ answer: 'the pool starves under POLLING', confidence: 0.8, evidence: EVIDENCE });
    expect(row.closed_at).not.toBeNull();
    expect(await jsonbShapes(id)).toEqual({ routing_type: 'object', outcome_type: 'object', cascade_digest_type: 'array' });

    const meta = await metaRows(id);
    expect(meta[0].kind).toBe('close');
    expect(meta[0].evidence).toEqual(EVIDENCE);
    expect(await evidenceJsonbType(id)).toBe('array');

    // The terminal post is still written exactly once, and the coarse
    // conversations:get projection receives the same answer/post/time rather
    // than requiring a second terminal post or a caller-side repair.
    expect(posts).toHaveLength(1);
    expect(settlements).toEqual([
      {
        conversationId: id,
        outcome: 'answered',
        answer: 'the pool starves under POLLING',
        postId: r.post_id,
        now: NOW.toISOString(),
      },
    ]);

    const [conversation] = await rootSql`
      SELECT state, accepted_answer, accepted_post_id, resolved_at
        FROM harness_shared.coord_conversations
       WHERE workspace_id = ${WS} AND id = ${id}
    `;
    expect(conversation).toMatchObject({
      state: 'resolved',
      accepted_answer: 'the pool starves under POLLING',
      accepted_post_id: String(r.post_id),
    });

    expect(emits).toHaveLength(1);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
  });

  it("cant_help requires the reason; answered requires the answer — outcome validation refuses incomplete closes", async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, posts } = makeDeps();
    expect(
      await consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered' }, deps),
    ).toEqual({ error: 'answer_required' });
    expect(
      await consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'cant_help' }, deps),
    ).toEqual({ error: 'reason_required' });
    expect(posts).toHaveLength(0);
    expect((await stateRow(id)).state).toBe('active');
  });

  it("the requester may close (cant_help path) — no park-key emit for their own close", async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits } = makeDeps();
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'cant_help', reason: 'answered it myself meanwhile' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('closed_cant_help');
    expect((await stateRow(id)).outcome).toEqual({ reason: 'answered it myself meanwhile' });
    expect(emits).toHaveLength(0);
  });

  it('a closed consult refuses a second close', async () => {
    const id = await seedConsult({ state: 'closed_cant_help' });
    const { deps } = makeDeps();
    expect(
      await consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered', answer: 'a' }, deps),
    ).toMatchObject({ error: 'consult_not_open', state: 'closed_cant_help' });
  });

  it('rolls back consult_state and close metadata when coarse settlement fails', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps } = makeDeps({ withSettlement: true, settlementError: 'coarse projection unavailable' });
    await expect(
      consultCloseCore(
        { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered', answer: 'rollback me' },
        deps,
      ),
    ).rejects.toThrow('coarse projection unavailable');

    expect((await stateRow(id)).state).toBe('active');
    expect(await metaRows(id)).toHaveLength(0);
    expect(
      await rootSql`
        SELECT state, accepted_answer, accepted_post_id, resolved_at
          FROM harness_shared.coord_conversations
         WHERE workspace_id = ${WS} AND id = ${id}
      `,
    ).toMatchObject([{ state: 'open', accepted_answer: null, accepted_post_id: null, resolved_at: null }]);
  });
});

// ── consult:close outcome 'graduate' (P-005, D-004) ──────────────────────
describe('consultCloseCore — graduate', () => {
  it('responder graduate: mints the shared work item, state=graduated, outcome {reason, work_item_id}, park-key emit', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits, minted, posts } = makeDeps({ withMint: true });
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'graduate', reason: 'cap hit while still deliberating' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('graduated');
    expect(r.work_item_id).toBe('WI-GRAD-1');
    expect(r.hint).toContain('WI-GRAD-1');

    // The mint saw the consult's question + both participants + the closer.
    expect(minted).toEqual([
      {
        workspaceId: WS,
        conversationId: id,
        question: 'q',
        requesterId: REQUESTER,
        responderId: RESPONDER,
        closedBy: RESPONDER,
        reason: 'cap hit while still deliberating',
      },
    ]);

    // The closing post names the minted work item; its meta stays kind='close'
    // ('graduate' is a close OUTCOME, not a post kind — the enum is untouched).
    expect(posts[0].body).toContain('WI-GRAD-1');
    const meta = await metaRows(id);
    expect(meta[0].kind).toBe('close');

    // State row: 'graduated' under the migration's state CHECK, outcome carries the id.
    const row = await stateRow(id);
    expect(row.state).toBe('graduated');
    expect(row.outcome).toEqual({ reason: 'cap hit while still deliberating', work_item_id: 'WI-GRAD-1' });
    expect(row.closed_at).not.toBeNull();

    // A responder graduate is the terminal reply — the parked requester is woken.
    expect(emits).toHaveLength(1);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
  });

  it('the requester may graduate too (close symmetry) — no park-key emit for their own close', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits, minted } = makeDeps({ withMint: true });
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'graduate', reason: 'outgrew the consult' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('graduated');
    expect(minted[0].closedBy).toBe(REQUESTER);
    expect(emits).toHaveLength(0);
  });

  it('graduate requires the reason — refused with nothing written', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, posts, minted } = makeDeps({ withMint: true });
    expect(
      await consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'graduate' }, deps),
    ).toEqual({ error: 'reason_required' });
    expect(posts).toHaveLength(0);
    expect(minted).toHaveLength(0);
    expect((await stateRow(id)).state).toBe('active');
  });

  it('graduate without a bound mint seam is refused structurally (graduate_unavailable), nothing written', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, posts } = makeDeps(); // no withMint
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'graduate', reason: 'r' },
      deps,
    );
    expect(r).toMatchObject({ error: 'graduate_unavailable' });
    expect(posts).toHaveLength(0);
    expect((await stateRow(id)).state).toBe('active');
  });

  it('a mint failure is a clean refusal (graduate_failed) — consult stays open, no post', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, posts } = makeDeps({ mintError: 'work-items store down' });
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'graduate', reason: 'r' },
      deps,
    );
    expect(r).toEqual({ error: 'graduate_failed', cause: 'work-items store down' });
    expect(posts).toHaveLength(0);
    expect((await stateRow(id)).state).toBe('active');
  });

  it('the cap-hit reply refusal names the graduate option (D-004 canonical trigger)', async () => {
    const id = await seedConsult({ state: 'active', exchangesUsed: 4, maxExchanges: 4 });
    const { deps } = makeDeps();
    // Cap-bound post = a NON-perspective one (requester follow-up; D-005
    // exempts the current responder's perspective reply).
    const refused = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body: 'one more thing' },
      deps,
    );
    expect(refused).toMatchObject({ error: 'exchange_cap' });
    if ('error' in refused && refused.error === 'exchange_cap') {
      expect(refused.hint).toContain("outcome: 'graduate'");
    }
  });
});

// ── D-005/P-013 always-advance cascade (consult-min-max-and-rubric-vetting) ─

/** A routing snapshot with a real selection menu (the 844 cascade drives off
 * selection.selected) plus route-time candidates for remaining_candidates. */
function menuSnapshot(owners: string[]) {
  return {
    candidates: owners.map((o, i) => ({ ownerId: o, score: 0.9 - i * 0.1, liveness: 'live' })),
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

describe('cascade advance (D-005/P-013)', () => {
  it('a perspective reply ADVANCES the chain: cursor+responder move, digest carries the reply, next selectee woken with the feedback so far', async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2', 'resp-3']) });
    const { deps, reachCalls } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'the answer', evidence: EVIDENCE },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.cascade).toEqual({ advanced_to: 'resp-2', exhausted: false, woke: 1 });
    expect(r.hint).toContain('Cascade advanced');

    const row = await stateRow(id);
    expect(row.state).toBe('active'); // reply-triggered advance keeps the consult engaged
    expect(row.responder_id).toBe('resp-2');
    expect(row.cascade_cursor).toBe(1);
    expect(row.expires_at).not.toBeNull(); // fresh latency window for the next selectee
    const digest = row.cascade_digest as Array<{ ownerId: string; kind: string; excerpt: string }>;
    expect((await jsonbShapes(id)).cascade_digest_type).toBe('array');
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({ ownerId: RESPONDER, kind: 'answer', excerpt: 'the answer' });

    // The next selectee's wake body: position, question, and the digest line.
    expect(reachCalls).toHaveLength(1);
    expect(reachCalls[0].responder).toBe('resp-2');
    expect(reachCalls[0].body).toContain('reviewer 2/3');
    expect(reachCalls[0].body).toContain('QUESTION: q');
    expect(reachCalls[0].body).toContain(`- ${RESPONDER} (answer): the answer`);
  });

  it('a previously woken responder remains a participant and may close after advancing the cascade', async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps } = makeDeps();

    const reply = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'the answer', evidence: EVIDENCE },
      deps,
    );
    if ('error' in reply) throw new Error(reply.error);
    expect((await stateRow(id)).responder_id).toBe('resp-2');

    const close = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered', answer: 'settled' },
      deps,
    );
    if ('error' in close) throw new Error(close.error);
    expect(close.state).toBe('closed_answered');
    expect((await stateRow(id)).state).toBe('closed_answered');
  });

  // WI-1700133: the VOID-consult exit. A responder who judges the QUESTION
  // void (duplicate, inadmissible, already settled) must be able to end the
  // consult WITHOUT spending the next selectee — every other responder verb
  // advances (reply of any kind, decline, expiry), and for an acceptance
  // grading cascade each advance PERMANENTLY disqualifies that grader under
  // D-009 independence. The filed item asserted this exit was unreachable
  // through the tool surface. It is not: close is non-advancing for the
  // CURRENT responder, mid-menu, with no prior reply. This pins the property
  // the guidance now routes to, so a later refactor cannot quietly make
  // close advance and re-open the grader-burn.
  it('the CURRENT responder may close a VOID consult mid-menu: terminal, cursor unmoved, NO next selectee woken, requester signalled (WI-1700133)', async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2', 'resp-3']) });
    const { deps, reachCalls, emits } = makeDeps(); // reach IS bound — a wake would be recorded

    const close = await consultCloseCore(
      {
        workspaceId: WS,
        authorId: RESPONDER,
        conversationId: id,
        outcome: 'cant_help',
        reason: 'the question is void — the subject rubric already carries a complete independent card',
      },
      deps,
    );
    if ('error' in close) throw new Error(close.error);
    expect(close.state).toBe('closed_cant_help');

    // The cascade did NOT advance: no selectee after this one was woken, and
    // the cursor/responder never moved off the closer.
    expect(reachCalls).toEqual([]);
    const row = await stateRow(id);
    expect(row.state).toBe('closed_cant_help');
    expect(row.responder_id).toBe(RESPONDER);
    expect(row.cascade_cursor).toBe(0);

    // …and the requester IS woken, via the latched park key — the disposition
    // reaches the one agent who can act on a void consult.
    expect(emits).toHaveLength(1);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
    expect(emits[0].to).toEqual([REQUESTER]);
  });

  it('hard-blocked: the FIRST reply fires the park key while the chain continues behind it (D-007)', async () => {
    const id = await seedConsult({ latency: 'hard-blocked', routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps, emits } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'a1', evidence: EVIDENCE },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    // The parked requester is woken by the FIRST responder post…
    expect(emits).toHaveLength(1);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
    expect(emits[0].to).toEqual([REQUESTER]);
    // …AND the cascade still advanced behind them.
    expect(r.cascade).toEqual({ advanced_to: 'resp-2', exhausted: false, woke: 1 });
    expect((await stateRow(id)).responder_id).toBe('resp-2');
  });

  it('a mid-chain decline ADVANCES instead of closing — no park-key emit, digest records the decline', async () => {
    const id = await seedConsult({ state: 'active', routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps, emits, reachCalls } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('awaiting_responder');
    expect(r.cascade).toEqual({ advanced_to: 'resp-2', exhausted: false, woke: 1 });
    expect(emits).toHaveLength(0); // mid-chain: more feedback is coming — the parked requester sleeps on

    const row = await stateRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.closed_at).toBeNull();
    expect(row.responder_id).toBe('resp-2');
    const digest = row.cascade_digest as Array<{ ownerId: string; kind: string }>;
    expect((await jsonbShapes(id)).cascade_digest_type).toBe('array');
    expect(digest).toMatchObject([{ ownerId: RESPONDER, kind: 'decline' }]);
    expect(reachCalls[0].body).toContain(`- ${RESPONDER} (decline): not my area`);
  });

  it('advanceCascade is CAS-guarded: a stale-cursor second call is a raced no-op (no duplicate wake, no duplicate digest)', async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2', 'resp-3']) });
    const wakes: string[] = [];
    const reach = async (o: { responder: string }) => {
      wakes.push(o.responder);
      return { woke: 1 };
    };
    const params = {
      workspaceId: WS,
      conversationId: id,
      question: 'q',
      latencyContract: 'proceed',
      routing: menuSnapshot([RESPONDER, 'resp-2', 'resp-3']),
      cascadeCursor: 0,
      digest: [],
      event: makeDigestEntry(RESPONDER, 'decline' as const, NOW.toISOString(), 'x'),
      stateOnAdvance: 'awaiting_responder' as const,
      nowIso: NOW.toISOString(),
    };
    const first = await advanceCascade(params, rootSql, reach);
    expect(first).toMatchObject({ advanced: true, raced: false, next: { ownerId: 'resp-2' } });
    const second = await advanceCascade(params, rootSql, reach); // same stale cursor 0
    expect(second).toMatchObject({ advanced: false, exhausted: false, raced: true, woke: 0 });
    expect(wakes).toEqual(['resp-2']); // exactly one wake
    const digest = (await stateRow(id)).cascade_digest as unknown[];
    expect(digest).toHaveLength(1); // the raced call appended nothing
  });
});

// ── WI-39862 honest expiry (late disposition) + WI-39861 refill via decline ──
describe('consultCloseCore — late disposition on an expired consult (WI-39862 / EI-20824019943814803)', () => {
  async function seedExpired(opts: { digest?: unknown[]; outcome?: unknown } = {}): Promise<string> {
    const id = await seedConsult({ state: 'expired' });
    await rootSql`
      UPDATE harness_shared.consult_state
         SET closed_at = ${NOW.toISOString()}::timestamptz,
             cascade_digest = ${rootSql.json((opts.digest ?? []) as never)},
             outcome = ${opts.outcome ? rootSql.json(opts.outcome as never) : null}
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    return id;
  }

  it('the REQUESTER may close an expired consult — the late disposition overwrites state + outcome (archive candidacy regained)', async () => {
    const id = await seedExpired({
      digest: [{ ownerId: 'rev-1', kind: 'answer', at: NOW.toISOString(), excerpt: 'ans' }],
      outcome: { disposition: 'cascade_exhausted_with_answers', answers: 1, answered_by: ['rev-1'] },
    });
    const { deps, posts } = makeDeps();
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'answered', answer: 'the settled answer', confidence: 0.8 },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('closed_answered');
    expect(posts).toHaveLength(1);
    const row = await stateRow(id);
    expect(row.state).toBe('closed_answered');
    const outcome = typeof row.outcome === 'string' ? JSON.parse(row.outcome as string) : row.outcome;
    expect(outcome).toMatchObject({ answer: 'the settled answer', confidence: 0.8 });
    expect(row.closed_at).not.toBeNull();
  });

  it('a NON-requester (even the last responder) still cannot close an expired consult', async () => {
    const id = await seedExpired();
    const { deps } = makeDeps();
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'cant_help', reason: 'late' },
      deps,
    );
    expect(r).toMatchObject({ error: 'consult_not_open', state: 'expired' });
  });

  it('reply and decline on an expired consult stay refused — the hint names the requester late-close path', async () => {
    const id = await seedExpired();
    const { deps } = makeDeps();
    const reply = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'late', evidence: EVIDENCE },
      deps,
    );
    expect(reply).toMatchObject({ error: 'consult_not_open', state: 'expired' });
    expect((reply as { hint?: string }).hint).toContain('consult:close');
    const decline = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'late' },
      deps,
    );
    expect(decline).toMatchObject({ error: 'consult_not_open', state: 'expired' });
  });
});

describe('consultDeclineCore — exhaustion honesty + min-ANSWERS refill (WI-39862 / WI-39861)', () => {
  it('a decline-exhaustion terminal that collected answers says so on the outcome', async () => {
    // Menu [ans-r, RESPONDER], cursor 1 (RESPONDER current), digest holds ans-r's answer.
    const id = await seedConsult({ state: 'active', routing: menuSnapshot(['ans-r', RESPONDER]) });
    await rootSql`
      UPDATE harness_shared.consult_state
         SET cascade_cursor = 1,
             cascade_digest = ${rootSql.json([{ ownerId: 'ans-r', kind: 'answer', at: NOW.toISOString(), excerpt: 'real answer' }] as never)}
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    const { deps } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'cannot add more' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('declined');
    expect(r.cascade.exhausted).toBe(true);
    const row = await stateRow(id);
    const outcome = typeof row.outcome === 'string' ? JSON.parse(row.outcome as string) : row.outcome;
    expect(outcome).toMatchObject({ reason: 'cannot add more', answers: 1, answered_by: ['ans-r'] });
    expect(await jsonbShapes(id)).toEqual({ routing_type: 'object', outcome_type: 'object', cascade_digest_type: 'array' });
  });

  it('a decline that exhausts BELOW min triggers the refill round (trigger-independence with the expiry path)', async () => {
    const routing = {
      floor: 0.5,
      simFloor: 0.4,
      candidates: [
        { ownerId: RESPONDER, score: 0.9, signals: { similarity: 0.8 }, liveness: 'live' },
        { ownerId: 'w-b', score: 0.6, signals: { similarity: 0.5 }, liveness: 'live' },
      ],
      selection: {
        min: 1,
        max: 1,
        selected: [{ ownerId: RESPONDER, via: 'floor', score: 0.9, similarity: 0.8, liveness: 'live' }],
      },
    };
    const id = await seedConsult({ state: 'active', routing });
    const { deps, reachCalls } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('awaiting_responder');
    expect(r.cascade).toMatchObject({ advanced_to: 'w-b', exhausted: false, refilled: true });
    expect(r.hint).toContain('min-ANSWERS refill');
    const row = await stateRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.responder_id).toBe('w-b');
    expect(row.closed_at).toBeNull();
    const routingRow = (typeof row.routing === 'string' ? JSON.parse(row.routing as string) : row.routing) as {
      selection?: { selected?: Array<Record<string, unknown>>; refill?: { added?: string[] } };
    };
    expect(routingRow.selection?.selected?.[1]).toMatchObject({ ownerId: 'w-b', refill: true });
    expect(routingRow.selection?.refill?.added).toEqual(['w-b']);
    expect(reachCalls.at(-1)?.responder).toBe('w-b');
  });
});

// ── EI-20864690354207496: refill-exhaustion revival + honest under-filled ──
//
// The probe both vetting reviewers demanded (conv-mszpqo7t posts 70130/70135):
// drive a consult to refill exhaustion with ONLY dead untried above-floor
// candidates in the snapshot and assert the DISJUNCTION — either a dead
// above-floor candidate is revived within the persisted per-consult budget,
// XOR the terminal state honestly reports why the min stays unfilled
// (selection.underFilled). Silence is the one outcome these pin out.
describe('advanceCascade — refill-exhaustion revival (EI-20864690354207496)', () => {
  type ParsedRouting = {
    selection?: {
      selected?: Array<Record<string, unknown>>;
      refill?: { added?: string[] };
      underFilled?: Record<string, unknown>;
    };
  };
  const parseRouting = (raw: unknown): ParsedRouting =>
    (typeof raw === 'string' ? JSON.parse(raw) : raw) as ParsedRouting;

  /** min:1 snapshot whose untried pool holds ONLY a dead candidate. The dead
   * candidate clears both floors unless lowScore drops it below them. */
  function deadPoolRouting(opts: { revivedAlready?: boolean; lowScore?: boolean } = {}) {
    return {
      floor: 0.5,
      simFloor: 0.4,
      candidates: [
        { ownerId: RESPONDER, score: 0.9, signals: { similarity: 0.8 }, liveness: 'live' },
        opts.lowScore
          ? { ownerId: 'dead-low', score: 0.2, signals: { similarity: 0.1 }, liveness: 'ended' }
          : { ownerId: 'dead-x', score: 0.7, signals: { similarity: 0.6 }, liveness: 'ended' },
      ],
      selection: {
        min: 1,
        max: 1,
        selected: [
          {
            ownerId: RESPONDER,
            via: 'floor',
            score: 0.9,
            similarity: 0.8,
            liveness: 'live',
            ...(opts.revivedAlready ? { revived: true } : {}),
          },
        ],
      },
    };
  }

  it('driven through consult:decline — exhaustion below min with only a dead above-floor untried candidate REVIVES them: menu extended revived-first, cursor lands on them, consult stays open', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting() });
    const { deps, reachCalls } = makeDeps();
    const revived: Array<{ ownerId: string; conversationId: string; brief: string }> = [];
    deps.revive = async (o) => {
      revived.push(o);
      return { spawned: true, verified: true, detail: 'live host registered' };
    };
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('awaiting_responder'); // NOT terminal — revival filled the slot
    expect(r.cascade).toMatchObject({
      advanced_to: 'dead-x',
      exhausted: false,
      revival: { ownerId: 'dead-x', spawned: true },
    });
    expect(r.hint).toContain('refill-exhaustion revival');
    expect(revived).toHaveLength(1);
    expect(revived[0].conversationId).toBe(id);
    expect(revived[0].brief).toContain('REVIVED');
    const row = await stateRow(id);
    expect(row.responder_id).toBe('dead-x');
    expect(row.closed_at).toBeNull();
    const routingRow = parseRouting(row.routing);
    // Revived entry HEADS the extension, labeled with provenance (via floor +
    // revived) — this persisted stamp IS the budget debit the next
    // exhaustion reads.
    expect(routingRow.selection?.selected?.[1]).toMatchObject({ ownerId: 'dead-x', via: 'floor', revived: true });
    expect(routingRow.selection?.underFilled).toBeUndefined();
    // The revived head is reach-woken too (redundant delivery; the spawn
    // brief is primary — same shape as the creation site).
    expect(reachCalls.at(-1)?.responder).toBe('dead-x');
  });

  it('persists a pending revival head before spawning: its first reply claims the head and the finalizer cannot clobber it', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting() });
    const { deps } = makeDeps();
    let pendingAtSpawn: Record<string, unknown> | undefined;
    let revivedReply: Awaited<ReturnType<typeof consultReplyCore>> | undefined;
    deps.revive = async () => {
      const pendingRow = await stateRow(id);
      const pendingRouting = parseRouting(pendingRow.routing);
      pendingAtSpawn = pendingRouting.selection?.selected?.[1];
      revivedReply = await consultReplyCore(
        {
          workspaceId: WS,
          authorId: 'dead-x',
          conversationId: id,
          kind: 'answer',
          body: 'revived first-turn answer',
          evidence: EVIDENCE,
        },
        deps,
      );
      return { spawned: true, verified: true, detail: 'first turn replied before revive finalized' };
    };

    const decline = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in decline) throw new Error(decline.error);
    expect(pendingAtSpawn).toMatchObject({ ownerId: 'dead-x', revivalPending: true });
    expect(revivedReply).toMatchObject({ ok: true, role: 'responder', state: 'active' });
    // The outer revival finalizer lost its reservation CAS after the first
    // turn claimed it; it must not restore awaiting_responder or erase the
    // reply's digest/state transition.
    expect(decline.cascade.exhausted).toBe(false);
    const row = await stateRow(id);
    expect(row.state).toBe('active');
    expect(row.responder_id).toBe('dead-x');
    expect(row.cascade_cursor).toBe(1);
    const routingRow = parseRouting(row.routing);
    expect(routingRow.selection?.selected?.[1]).toMatchObject({ ownerId: 'dead-x', revived: true });
    expect(routingRow.selection?.selected?.[1]?.revivalPending).toBeUndefined();
    expect(row.cascade_digest).toMatchObject([
      { ownerId: RESPONDER, kind: 'decline' },
      { ownerId: 'dead-x', kind: 'answer' },
    ]);
  });

  it('budget already spent (persisted revived stamp) — NO second revival: honest terminal, selection.underFilled says budget-spent', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting({ revivedAlready: true }) });
    const { deps } = makeDeps();
    let reviveCalls = 0;
    deps.revive = async () => {
      reviveCalls += 1;
      return { spawned: true, verified: true, detail: 'x' };
    };
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'no' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(reviveCalls).toBe(0); // the persisted stamp, not a local flag, is the budget
    expect(r.state).toBe('declined');
    expect(r.cascade.exhausted).toBe(true);
    const routingRow = parseRouting((await stateRow(id)).routing);
    expect(routingRow.selection?.underFilled).toMatchObject({ answers: 0, min: 1, reason: 'budget-spent' });
  });

  it('no revive seam bound — the disjunction still holds: honest under-filled terminal, never a silent exhaustion', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting() });
    const { deps } = makeDeps(); // no revive dep
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'no' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('declined');
    const routingRow = parseRouting((await stateRow(id)).routing);
    expect(routingRow.selection?.underFilled).toMatchObject({ answers: 0, min: 1, reason: 'no-revive-dep' });
  });

  it('spawn-fail with no live candidates — honest terminal labeled revival-failed (the attempt is reported, not papered over)', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting() });
    const { deps } = makeDeps();
    deps.revive = async () => ({ spawned: false, verified: null, detail: 'no adv_sessions row' });
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'no' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('declined');
    expect(r.cascade.exhausted).toBe(true);
    const routingRow = parseRouting((await stateRow(id)).routing);
    expect(routingRow.selection?.underFilled).toMatchObject({ reason: 'revival-failed' });
  });

  it('a dead BELOW-floor candidate is never revived (no costumed expert) — honest terminal: no-revivable-candidate', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting({ lowScore: true }) });
    const { deps } = makeDeps();
    let reviveCalls = 0;
    deps.revive = async () => {
      reviveCalls += 1;
      return { spawned: true, verified: true, detail: 'x' };
    };
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'no' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(reviveCalls).toBe(0);
    expect(r.state).toBe('declined');
    const routingRow = parseRouting((await stateRow(id)).routing);
    expect(routingRow.selection?.underFilled).toMatchObject({ reason: 'no-revivable-candidate' });
  });
});

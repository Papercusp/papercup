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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import {
  consultCloseCore,
  consultDeclineCore,
  consultReplyCore,
  type ConsultVerbDeps,
} from './consult-verbs-core';

const WS = 'ws-consult-verbs';
const NOW = new Date('2026-08-16T00:00:00Z');
const REQUESTER = 'req-1';
const RESPONDER = 'resp-1';
const MIGRATION_834 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);

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
       ${opts.originTaskRef ?? null}, ${JSON.stringify(opts.routing ?? {})}::jsonb)
  `;
  return id;
}

function makeDeps(opts: { postError?: string; withReach?: boolean } = {}) {
  const posts: Array<{ conversation_id: string; body: string; via_consult_verb: true }> = [];
  const emits: Array<{ key: string; summary: string; payload: Record<string, unknown>; to: string[] }> = [];
  const reached: Array<{ responder: string; conversationId: string }> = [];
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
    ...(opts.withReach === false
      ? {}
      : {
          reach: async (o) => {
            reached.push({ responder: o.responder, conversationId: o.conversationId });
            return { woke: 1 };
          },
        }),
    now: () => NOW,
  };
  return { deps, posts, emits, reached };
}

async function stateRow(conversationId: string) {
  const rows = (await rootSql`
    SELECT * FROM harness_shared.consult_state
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
  `) as unknown as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  // This fixture connection returns jsonb unparsed — normalize before asserting.
  for (const k of ['routing', 'outcome'] as const) {
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
    expect(r.exchanges_used).toBe(1);
    expect(r.wake).toBeUndefined(); // responder replies never wake-budget

    // Write-through went via the (gated) post seam.
    expect(posts).toEqual([{ conversation_id: id, body: 'the answer', via_consult_verb: true }]);

    // Typed overlay landed under the migration's kind CHECK, evidence verbatim.
    const meta = await metaRows(id);
    expect(meta).toHaveLength(1);
    expect(meta[0].kind).toBe('answer');
    expect(meta[0].author_id).toBe(RESPONDER);
    expect(meta[0].evidence).toEqual(EVIDENCE);

    // State row transitioned + debited.
    const row = await stateRow(id);
    expect(row.state).toBe('active');
    expect(row.exchanges_used).toBe(1);

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
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: 'stranger', conversationId: id, kind: 'new_fact', body: 'b' }, deps),
    ).toEqual({ error: 'not_a_participant' });
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

  it('the exchange cap refuses a reply with the close-instead nudge; close still works AT the cap', async () => {
    const id = await seedConsult({ state: 'active', exchangesUsed: 4, maxExchanges: 4 });
    const { deps, posts } = makeDeps();
    const refused = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'new_fact', body: 'one more thing' },
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

describe('consultReplyCore — requester follow-up wake budget (D-005)', () => {
  it('under budget: wakes the responder, debits wakes_used, reports the running total', async () => {
    const ref = 'WI-V-BUDGET-1';
    const id = await seedConsult({ state: 'active', originTaskRef: ref, wakesUsed: 1 });
    const { deps, reached, emits } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'question', body: 'and what about X?' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.role).toBe('requester');
    expect(r.wake).toMatchObject({ attempted: true, woke: 1, budget_exhausted: false, wakes_used_for_task: 2 });
    expect(reached).toEqual([{ responder: RESPONDER, conversationId: id }]);
    expect(emits).toHaveLength(0); // requester posts never fire the park key
    expect((await stateRow(id)).wakes_used).toBe(2);
    const meta = await metaRows(id);
    expect(meta[0].kind).toBe('question');
  });

  it('exhausted budget (aggregated over origin_task_ref): posts + delivers, but does NOT wake', async () => {
    const ref = 'WI-V-BUDGET-2';
    // Sibling consults on the same origin ref have spent the budget (4).
    for (let i = 0; i < 4; i++) await seedConsult({ originTaskRef: ref, wakesUsed: 1 });
    const id = await seedConsult({ state: 'active', originTaskRef: ref, wakesUsed: 0 });
    const { deps, reached } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body: 'found another log line' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.wake).toMatchObject({ attempted: false, woke: 0, budget_exhausted: true, wakes_used_for_task: 4 });
    expect(r.hint).toContain('exhausted');
    expect(reached).toHaveLength(0);
    expect((await stateRow(id)).wakes_used).toBe(0); // no debit without an attempt
    expect((await stateRow(id)).exchanges_used).toBe(1); // the post itself landed
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
    expect(r.hint).toContain(`exclude:['${RESPONDER}']`);

    const row = await stateRow(id);
    expect(row.state).toBe('declined');
    expect(row.outcome).toEqual({ reason: 'my transcript covers the file, not this subsystem' });
    expect(row.closed_at).not.toBeNull();

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
    const { deps, emits } = makeDeps();
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

    const meta = await metaRows(id);
    expect(meta[0].kind).toBe('close');
    expect(meta[0].evidence).toEqual(EVIDENCE);

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
});

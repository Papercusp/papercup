/**
 * conversations.integration.test.ts — the conversation/question workflow
 * (coordination-conversations-2026-06-03) end-to-end against REAL Postgres
 * (throwaway db on the shared testcontainer), driving conversations-core over the
 * real @papercusp/coordination capability stores + the PgConversationStore, with
 * an in-memory delivery sink + a stub capture + a deterministic clock/id.
 *
 * Proves the substrate-consumption contract:
 *  • open → conversation row + thread + topic tags; topic subscriber notified;
 *    the asker is NOT notified of their own question but IS subscribed.
 *  • answer → the asker is notified; the answerer (actor) is excluded + auto-joined.
 *  • resolve → Lifecycle state flips, accepted answer + capture target recorded,
 *    answer-capture invoked (D-004), subscribers notified (resolution reaches
 *    even mention-mode followers).
 *  • delivery_mode (D-006): a 'mention' subscriber is gated out of a normal post
 *    but receives a resolution.
 *  • the knowledge tier returns candidates from mem0 with cited sources, and a
 *    miss returns empty (degrading cleanly when the search tables are absent).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  ensureCoordCapabilityTables,
  PgEntitySubscriptionStore,
  PgTaggableStore,
  PgThreadStore,
  PgTopicStore,
} from '@papercusp/coordination/capabilities';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { ensureConversationsTable, PgConversationStore, reparentThread } from './conversations-store';
import type { InjectSink } from './fanout-delivery';
import type { AgentIdentity } from './identity';
import {
  answerQuestionCore,
  getConversationCore,
  joinConversationCore,
  openConversationCore,
  promoteConversationCore,
  resolveConversationCore,
  type CaptureFn,
  type ConversationDeps,
} from './conversations-core';
import { runKnowledgeTier, type KnowledgeMem0Client } from './ask-knowledge-tier';

const WS = 'default';

let db: FreshPgDb;
let sql: postgres.Sql;

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: WS, userId: null } as AgentIdentity;
}

// In-memory delivery sink: collects appended notify envelopes per recipient.
function makeSink(): { sink: InjectSink; inbox: Record<string, CoordEnvelope[]>; clear: () => void } {
  const inbox: Record<string, CoordEnvelope[]> = {};
  const sink: InjectSink = {
    async appendLine(_surface, writerKey, line) {
      (inbox[writerKey] ??= []).push(line);
    },
  };
  return { sink, inbox, clear: () => Object.keys(inbox).forEach((k) => delete inbox[k]) };
}

let sinkBox: ReturnType<typeof makeSink>;
let captureCalls: Array<Parameters<CaptureFn>[0]>;
let promotedIssues: Array<{ title: string; scope?: string; topics?: string[]; foundDuring?: string; severity?: string; source?: string }>;
let deps: ConversationDeps;
let idSeq: number;

function freshDeps(): ConversationDeps {
  const opts = { getSql: () => sql, ensureSchema: async () => {}, workspaceId: WS };
  sinkBox = makeSink();
  captureCalls = [];
  promotedIssues = [];
  idSeq = 0;
  const capture: CaptureFn = async (input) => {
    captureCalls.push(input);
    return { target: `mem0:${input.harness_slug ?? `workspace:${input.workspace_id}`}`, ok: true };
  };
  return {
    conversations: new PgConversationStore(opts),
    threads: new PgThreadStore(opts),
    tags: new PgTaggableStore(opts),
    subs: new PgEntitySubscriptionStore(opts),
    topics: new PgTopicStore(opts),
    sink: sinkBox.sink,
    capture,
    nowIso: () => '2026-06-04T00:00:00.000Z',
    newId: (prefix) => `${prefix}-${++idSeq}`,
    // Stub the issues bridge; reparentThread is the REAL helper against PG.
    promote: {
      createIssue: async (i) => {
        promotedIssues.push(i);
        return { id: `EI-${promotedIssues.length}`, title: i.title };
      },
      reparentThread: (from, to, newThreadId) => reparentThread(sql, WS, from, to, newThreadId),
      issueThreadId: (id) => `issue-thread-${id}`,
    },
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('conversations');
  sql = db.sql;
  await ensureCoordCapabilityTables(sql);
  await ensureConversationsTable(sql);
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await sql`TRUNCATE harness_shared.coord_conversations,
                    harness_shared.coord_entity_subscriptions,
                    harness_shared.coord_threads,
                    harness_shared.coord_thread_posts,
                    harness_shared.coord_links,
                    harness_shared.coord_topics RESTART IDENTITY`;
  deps = freshDeps();
});

describe('conversation lifecycle (real PG)', () => {
  it('open question → topic subscriber notified, asker not, asker subscribed, thread + tags created', async () => {
    await deps.topics.create({ slug: 'zero-cache', description: 'the zero-cache replicator', created_ts: '2026-06-04T00:00:00.000Z' });
    await deps.subs.subscribe({ subscriber_id: 'agB', target_kind: 'topic', target_ref: 'zero-cache', created_ts: '2026-06-04T00:00:00.000Z' });

    const res = await openConversationCore(deps, ident('agA'), {
      kind: 'question',
      body: 'Why does the shop freeze on page change in Firefox?',
      topics: ['zero-cache'],
    });

    expect(res.conversation.kind).toBe('question');
    expect(res.conversation.state).toBe('open');
    expect(res.topics).toEqual(['zero-cache']);
    expect(res.unrouted).toBe(false);

    // The topic subscriber got exactly one question_opened; the asker got nothing.
    expect(sinkBox.inbox.agB).toHaveLength(1);
    expect(sinkBox.inbox.agB[0].notify_kind).toBe('question_opened');
    expect(sinkBox.inbox.agA).toBeUndefined();
    expect(res.delivered).toBe(1);

    // The asker is now subscribed to the object (so answers come back).
    const subs = await deps.subs.listTargetSubscribers('object', `conversation:${res.conversation.id}`);
    expect(subs.map((s) => s.subscriber_id)).toContain('agA');

    // Thread + tags persisted on the substrate.
    const detail = await getConversationCore(deps, res.conversation.id);
    expect(detail?.topics).toEqual(['zero-cache']);
  });

  it('answer → asker notified, answerer excluded + auto-joined', async () => {
    const opened = await openConversationCore(deps, ident('agA'), { kind: 'question', body: 'q?', topics: ['t'] });
    sinkBox.clear();

    const ans = await answerQuestionCore(deps, ident('agB'), { conversation_id: opened.conversation.id, body: 'the answer' });
    expect('post' in ans).toBe(true);
    if ('error' in ans) throw new Error(ans.error);

    // Asker agA notified of the answer; the answerer agB is excluded.
    expect(sinkBox.inbox.agA).toHaveLength(1);
    expect(sinkBox.inbox.agA[0].notify_kind).toBe('answer_posted');
    expect(sinkBox.inbox.agB).toBeUndefined();

    // The answerer is now auto-joined.
    const subs = await deps.subs.listTargetSubscribers('object', `conversation:${opened.conversation.id}`);
    expect(subs.map((s) => s.subscriber_id).sort()).toEqual(['agA', 'agB']);
  });

  it('resolve → state flips, answer + capture recorded, answer-capture invoked, subscribers notified', async () => {
    await deps.subs.subscribe({ subscriber_id: 'agB', target_kind: 'topic', target_ref: 'zero-cache', created_ts: '2026-06-04T00:00:00.000Z' });
    const opened = await openConversationCore(deps, ident('agA'), {
      kind: 'question',
      body: 'why does it freeze?',
      title: 'shop freeze',
      topics: ['zero-cache'],
    });
    const ans = await answerQuestionCore(deps, ident('agB'), { conversation_id: opened.conversation.id, body: 'zero-cache was down (orphaned replicator lock)' });
    if ('error' in ans) throw new Error(ans.error);
    sinkBox.clear();

    const res = await resolveConversationCore(deps, ident('agA'), {
      conversation_id: opened.conversation.id,
      accepted_post_id: ans.post.id,
      capture: 'mem0',
    });
    if ('error' in res) throw new Error(res.error);

    expect(res.conversation.state).toBe('resolved');
    expect(res.conversation.accepted_answer).toContain('orphaned replicator lock');
    expect(res.conversation.capture_target).toMatch(/^mem0:/);
    expect(res.conversation.resolved_ts).not.toBeNull();

    // Answer-capture (D-004) was invoked with the Q + accepted answer.
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0].question).toBe('shop freeze');
    expect(captureCalls[0].answer).toContain('orphaned replicator lock');

    // The subscriber agB is notified of the resolution; the resolver agA excluded.
    expect(sinkBox.inbox.agB?.[0]?.notify_kind).toBe('conversation_resolved');
    expect(sinkBox.inbox.agA).toBeUndefined();
  });

  it('delivery_mode mention: gated out of a normal post, but receives a resolution (D-006)', async () => {
    await deps.topics.create({ slug: 'area', description: 'an area', created_ts: '2026-06-04T00:00:00.000Z' });
    // agC follows the topic in mention-mode (the quiet floor).
    await deps.subs.subscribe({ subscriber_id: 'agC', target_kind: 'topic', target_ref: 'area', delivery_mode: 'mention', created_ts: '2026-06-04T00:00:00.000Z' });

    const opened = await openConversationCore(deps, ident('agA'), { kind: 'question', body: 'q', topics: ['area'] });
    // A mention-mode subscriber is NOT notified of a normal open (no @-mention, not a resolution).
    expect(sinkBox.inbox.agC).toBeUndefined();

    sinkBox.clear();
    const res = await resolveConversationCore(deps, ident('agA'), { conversation_id: opened.conversation.id, accepted_answer: 'done', capture: 'none' });
    if ('error' in res) throw new Error(res.error);
    // …but DOES receive the resolution.
    expect(sinkBox.inbox.agC?.[0]?.notify_kind).toBe('conversation_resolved');
  });

  it('not_found + no_answer guards', async () => {
    expect(await answerQuestionCore(deps, ident('agA'), { conversation_id: 'nope', body: 'x' })).toEqual({ error: 'not_found' });
    expect(await joinConversationCore(deps, ident('agA'), { conversation_id: 'nope' })).toEqual({ error: 'not_found' });
    const opened = await openConversationCore(deps, ident('agA'), { kind: 'question', body: 'q', topics: ['t'] });
    expect(await resolveConversationCore(deps, ident('agA'), { conversation_id: opened.conversation.id })).toEqual({ error: 'no_answer' });
  });

  it('harness scope tags harness_slug + threads through to capture', async () => {
    const opened = await openConversationCore(deps, ident('agA'), { kind: 'question', body: 'q', topics: ['t'], harness_slug: 'papercup' });
    expect(opened.conversation.scope).toBe('harness');
    expect(opened.conversation.harness_slug).toBe('papercup');
    const ans = await answerQuestionCore(deps, ident('agB'), { conversation_id: opened.conversation.id, body: 'a' });
    if ('error' in ans) throw new Error(ans.error);
    const res = await resolveConversationCore(deps, ident('agA'), { conversation_id: opened.conversation.id, accepted_post_id: ans.post.id });
    if ('error' in res) throw new Error(res.error);
    expect(captureCalls[0].scope).toBe('harness');
    expect(captureCalls[0].harness_slug).toBe('papercup');
  });
});

describe('promote → engineer issue (D-005, real PG re-parent)', () => {
  it('mints an issue carrying the conversation thread; conversation closes + records the issue', async () => {
    await deps.topics.create({ slug: 'zero-cache', description: 'zc', created_ts: '2026-06-04T00:00:00.000Z' });
    await deps.subs.subscribe({ subscriber_id: 'agB', target_kind: 'topic', target_ref: 'zero-cache', created_ts: '2026-06-04T00:00:00.000Z' });
    const opened = await openConversationCore(deps, ident('agA'), {
      kind: 'question',
      body: 'the shop keeps freezing',
      title: 'shop freeze',
      topics: ['zero-cache'],
      harness_slug: 'papercup',
    });
    // A reply lands a post in the conversation's thread (the thing we carry).
    const reply = await answerQuestionCore(deps, ident('agB'), { conversation_id: opened.conversation.id, body: 'looks like a real bug in the replicator' });
    if ('error' in reply) throw new Error(reply.error);
    sinkBox.clear();

    const res = await promoteConversationCore(deps, ident('agA'), { conversation_id: opened.conversation.id, severity: 'major' });
    if ('error' in res) throw new Error(res.error);

    // Issue minted carrying topics + harness scope; severity passed through.
    expect(res.issue.id).toBe('EI-1');
    expect(promotedIssues[0].scope).toBe('harness:papercup');
    expect(promotedIssues[0].topics).toEqual(['zero-cache']);
    expect(promotedIssues[0].severity).toBe('major');
    expect(res.thread_reparented).toBe(true);

    // Conversation closed + records the promotion.
    expect(res.conversation.state).toBe('closed');
    expect(res.conversation.promoted_issue_id).toBe('EI-1');

    // The thread is CARRIED onto the issue (re-parented + re-keyed), posts follow.
    const convThread = await deps.threads.getThreadByParent({ kind: 'conversation', ref: opened.conversation.id });
    expect(convThread).toBeNull();
    const issueThread = await deps.threads.getThreadByParent({ kind: 'issue', ref: 'EI-1' });
    expect(issueThread?.thread_id).toBe('issue-thread-EI-1');
    const carried = await deps.threads.listPosts('issue-thread-EI-1');
    expect(carried.map((p) => p.body)).toContain('looks like a real bug in the replicator');

    // The issue's lazy getOrCreateThread (its convention) now finds the carried
    // thread instead of dup'ing on the (parent_kind,parent_ref) unique index.
    const found = await deps.threads.getOrCreateThread({ kind: 'issue', ref: 'EI-1' }, { thread_id: 'issue-thread-EI-1', created_ts: '2026-06-04T00:00:00.000Z' });
    expect(found.thread_id).toBe('issue-thread-EI-1');

    // Subscriber notified of the promotion.
    expect(sinkBox.inbox.agB?.[0]?.notify_kind).toBe('conversation_promoted');
  });

  it('guards: not_found + already_promoted', async () => {
    expect(await promoteConversationCore(deps, ident('agA'), { conversation_id: 'nope' })).toEqual({ error: 'not_found' });
    const opened = await openConversationCore(deps, ident('agA'), { kind: 'discussion', body: 'x', topics: ['t'] });
    const first = await promoteConversationCore(deps, ident('agA'), { conversation_id: opened.conversation.id });
    if ('error' in first) throw new Error(first.error);
    expect(await promoteConversationCore(deps, ident('agA'), { conversation_id: opened.conversation.id })).toEqual({ error: 'already_promoted' });
  });
});

describe('knowledge tier (injected stub mem0)', () => {
  function stubMem0(byKey: Record<string, Array<{ id: string; memory: string; score: number }>>): KnowledgeMem0Client {
    return {
      async search(_q, opts) {
        return { results: byKey[opts.filters.user_id] ?? [] };
      },
    };
  }

  it('returns a mem0 candidate with a cited source on a hit', async () => {
    const client = stubMem0({
      'workspace:default': [{ id: 'm1', memory: 'Q: why freeze? A: zero-cache down', score: 0.9 }],
    });
    const res = await runKnowledgeTier(
      { query: 'why does the shop freeze', workspaceId: WS, asker_id: 'agA' },
      { sql, getMemoryClient: async () => client },
    );
    expect(res.searched).toContain('mem0');
    const mem = res.candidates.find((c) => c.source === 'mem0');
    expect(mem).toBeDefined();
    expect(mem?.excerpt).toContain('zero-cache down');
  });

  it('returns no candidates on a miss (degrades cleanly with absent search tables + empty mem0)', async () => {
    const res = await runKnowledgeTier(
      { query: 'nothing matches this', workspaceId: WS, asker_id: 'agA' },
      { sql, getMemoryClient: async () => stubMem0({}) },
    );
    expect(res.candidates).toHaveLength(0);
  });

  it('reads the harness mem0 scope when a harness is given', async () => {
    const client = stubMem0({ 'harness:papercup': [{ id: 'h1', memory: 'harness fact', score: 0.8 }] });
    const res = await runKnowledgeTier(
      { query: 'q', workspaceId: WS, asker_id: 'agA', harness_slug: 'papercup' },
      { sql, getMemoryClient: async () => client },
    );
    expect(res.candidates.some((c) => c.excerpt === 'harness fact')).toBe(true);
  });
});

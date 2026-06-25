/**
 * conversations-edges.integration.test.ts — the LIFECYCLE-core edge paths
 * (conversations-core.ts:resolveConversationCore + conversations-store.ts:
 * reparentThread) that conversations.integration.test.ts's happy paths skip.
 * Real Postgres (throwaway db on the shared testcontainer), same setup as that
 * test, with an in-memory sink + a stub capture + a deterministic clock/id.
 *
 * These are the conversation lifecycle cores (conversations-core / -store), NOT
 * the federation projection — confirmed against the imports below.
 *
 * Covered:
 *  • resolve with accepted_post_id matching NO post in the thread (and no
 *    accepted_answer) → {error:'no_answer'}: NO capture, NO state flip, the
 *    accepted_answer stays null. (Happy resolve covers the matching post; this
 *    covers the lookup MISS.)
 *  • reparentThread over a `from` object that has NO thread → {reparented:false},
 *    directly, AND through promote: a conversation row with no thread (no posts)
 *    still mints the issue + closes the conversation, but carries
 *    thread_reparented:false.
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
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { ensureConversationsTable, PgConversationStore, reparentThread } from './conversations-store';
import type { InjectSink } from './fanout-delivery';
import type { AgentIdentity } from './identity';
import {
  answerQuestionCore,
  getConversationCore,
  openConversationCore,
  promoteConversationCore,
  resolveConversationCore,
  type CaptureFn,
  type ConversationDeps,
} from './conversations-core';

const WS = 'default';

let db: FreshPgDb;
let sql: postgres.Sql;

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: WS, userId: null } as AgentIdentity;
}

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
let promotedIssues: Array<{ title: string; scope?: string; topics?: string[]; severity?: string }>;
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
    // Exercise the REAL bounded+atomic write path against the throwaway PG client.
    threadTxn: (fn) => boundedOrgTxn((tx) => fn(new PgThreadStore({ ...opts, getSql: () => tx })), { client: sql }),
    tags: new PgTaggableStore(opts),
    subs: new PgEntitySubscriptionStore(opts),
    topics: new PgTopicStore(opts),
    sink: sinkBox.sink,
    capture,
    nowIso: () => '2026-06-04T00:00:00.000Z',
    newId: (prefix) => `${prefix}-${++idSeq}`,
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
  db = await createFreshPgDb('conversations-edges');
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

describe('resolve — accepted_post_id matches no post (lookup miss)', () => {
  it('a bogus accepted_post_id with no accepted_answer → no_answer, no capture, no state flip', async () => {
    const opened = await openConversationCore(deps, ident('agA'), { kind: 'question', body: 'q?', topics: ['t'] });
    // A real answer exists, but we accept a DIFFERENT (non-existent) post id.
    const ans = await answerQuestionCore(deps, ident('agB'), { conversation_id: opened.conversation.id, body: 'real answer' });
    if ('error' in ans) throw new Error(ans.error);
    sinkBox.clear();

    const res = await resolveConversationCore(deps, ident('agA'), {
      conversation_id: opened.conversation.id,
      accepted_post_id: ans.post.id + 9999, // no such post in the thread
      capture: 'mem0',
    });
    expect(res).toEqual({ error: 'no_answer' });

    // Nothing was captured and the lifecycle did NOT flip.
    expect(captureCalls).toHaveLength(0);
    const detail = await getConversationCore(deps, opened.conversation.id);
    expect(detail?.conversation.state).toBe('open');
    expect(detail?.conversation.accepted_answer).toBeNull();
    expect(detail?.conversation.accepted_post_id).toBeNull();
    expect(detail?.conversation.resolved_ts).toBeNull();
    // No resolution was fanned out.
    expect(Object.keys(sinkBox.inbox)).toHaveLength(0);
  });

  it('a bogus post id on a thread with NO posts at all → no_answer', async () => {
    const opened = await openConversationCore(deps, ident('agA'), { kind: 'question', body: 'q?', topics: ['t'] });
    // No answer posted; resolve by a post id against an empty thread.
    const res = await resolveConversationCore(deps, ident('agA'), {
      conversation_id: opened.conversation.id,
      accepted_post_id: 1,
    });
    expect(res).toEqual({ error: 'no_answer' });
    expect(captureCalls).toHaveLength(0);
    const detail = await getConversationCore(deps, opened.conversation.id);
    expect(detail?.conversation.state).toBe('open');
  });
});

describe('reparentThread — no thread on the source', () => {
  it('returns {reparented:false} for a `from` object that has no thread (direct)', async () => {
    const rep = await reparentThread(
      sql,
      WS,
      { kind: 'conversation', ref: 'never-threaded' },
      { kind: 'issue', ref: 'EI-99' },
      'issue-thread-EI-99',
    );
    expect(rep).toEqual({ reparented: false });
    // No thread was conjured at the destination either.
    const issueThread = await deps.threads.getThreadByParent({ kind: 'issue', ref: 'EI-99' });
    expect(issueThread).toBeNull();
  });
});

describe('promote — a conversation with no thread (no posts)', () => {
  it('mints the issue + closes the conversation, but carries thread_reparented:false', async () => {
    // A conversation row created directly on the store (NOT via openConversationCore)
    // has NO thread — the freshest "no posts" case. The promote must still succeed
    // and just report nothing was carried.
    await deps.conversations.create({
      id: 'conv-noth',
      kind: 'discussion',
      scope: 'operator',
      asker_id: 'agA',
      title: 'orphan discussion',
      body: 'this conversation never grew a thread',
      created_ts: '2026-06-04T00:00:00.000Z',
    });

    const res = await promoteConversationCore(deps, ident('agA'), { conversation_id: 'conv-noth', severity: 'minor' });
    if ('error' in res) throw new Error(res.error);

    // The issue is minted (D-005) even though there was nothing to carry…
    expect(res.issue.id).toBe('EI-1');
    expect(promotedIssues).toHaveLength(1);
    expect(promotedIssues[0].title).toBe('orphan discussion');
    // …and thread_reparented is false (reparentThread found no source thread).
    expect(res.thread_reparented).toBe(false);

    // The conversation is closed + records the issue.
    expect(res.conversation.state).toBe('closed');
    expect(res.conversation.promoted_issue_id).toBe('EI-1');

    // No issue thread was created by the (no-op) reparent.
    const issueThread = await deps.threads.getThreadByParent({ kind: 'issue', ref: 'EI-1' });
    expect(issueThread).toBeNull();
  });
});

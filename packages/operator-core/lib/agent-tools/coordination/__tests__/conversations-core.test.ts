/**
 * conversations-core.test.ts — UNIT tests for the pure conversation-engine logic
 * (app-wide-test-coverage-2026-06-05 P-009), driven over the capability seams'
 * in-memory doubles (@papercusp/coordination/capabilities InMemory* stores) + an
 * in-memory ConversationStoreLike + an in-memory sink — no PG, no Docker.
 *
 * The two sibling integration suites (conversations.integration.test.ts +
 * conversations-edges.integration.test.ts) drive the SAME core over real Postgres
 * for the lifecycle happy paths; this file targets the pure branches they skip:
 *
 *  • open — unrouted (no topics), topic slug normalization/dedup, scope
 *    precedence (harness_slug wins over an explicit scope), discussion-kind
 *    notify rendering, summary truncation, and the best-effort fan-out (a
 *    subscriber-resolution failure never breaks the write).
 *  • the asker-exclusion contract on open when the asker ALREADY follows one of
 *    the tagged topics (a regression pin — this was a real bug, fixed
 *    2026-06-09; see the comment on that test).
 *  • post — the 'conversation_post' reply kind, the lazy thread-create branch,
 *    @-mention plumbing through the mention-mode gate, touch-on-activity.
 *  • resolve — whitespace-only accepted_answer, explicit-answer precedence over
 *    accepted_post_id, resolver≠asker exclusion, the 'mem0' capture default.
 *  • join/leave — delivery_mode honored, ttl_sec → expires_ts, leave silences.
 *  • listConversationsWithTopics — the wide-page-then-narrow topic filter (a
 *    match is not lost behind the caller's limit), topic input normalization,
 *    non-conversation tagged objects ignored.
 *  • promote — promote_unavailable (no bridge), the forced-harness issue scope,
 *    the truncated-body title fallback.
 *
 * delivery-mode gating itself (full/digest/mention) is the fanout-delivery
 * primitive's contract and is pinned in fanout-delivery.test.ts; the knowledge-
 * first short-circuit lives in tools/ask.ts + ask-knowledge-tier.ts (covered by
 * ask-knowledge-tier-dedup.test.ts + the integration suite), not in this core.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryEntitySubscriptionStore,
  InMemoryLinkStore,
  InMemoryTaggableStore,
  InMemoryThreadStore,
  InMemoryTopicStore,
  objectToTargetRef,
  type SubscribableStore,
} from '@papercusp/coordination/capabilities';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import type { InjectSink } from '../fanout-delivery';
import type { AgentIdentity } from '../identity';
import type {
  ConversationRow,
  ConversationState,
  CreateConversationInput,
  ListConversationsOpts,
} from '../conversations-store';
import {
  answerQuestionCore,
  getConversationCore,
  joinConversationCore,
  leaveConversationCore,
  listConversationsWithTopicsCore,
  openConversationCore,
  postReplyCore,
  promoteConversationCore,
  resolveConversationCore,
  type CaptureFn,
  type ConversationDeps,
  type ConversationStoreLike,
} from '../conversations-core';

const WS = 'default';
// Far-future clock: the InMemory subscription store filters expiry against the
// REAL Date.now(), so ttl-derived expires_ts values must land in the future.
const T0 = '2030-01-01T00:00:00.000Z';

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: WS, userId: null } as AgentIdentity;
}

/** In-memory ConversationStoreLike mirroring PgConversationStore's semantics
 *  (create is idempotent-on-id, list is created_ts DESC + clamped limit, state
 *  'resolved' is the only state that sets resolved_ts). Records the raw opts of
 *  every list() call so the wide-page topic-filter behavior is observable. */
class InMemoryConversationStore implements ConversationStoreLike {
  rows = new Map<string, ConversationRow>();
  listCalls: ListConversationsOpts[] = [];

  async create(input: CreateConversationInput): Promise<ConversationRow> {
    const existing = this.rows.get(input.id);
    if (existing) return { ...existing };
    const row: ConversationRow = {
      id: input.id,
      kind: input.kind,
      scope: input.scope,
      harness_slug: input.harness_slug ?? null,
      asker_id: input.asker_id,
      title: input.title ?? null,
      body: input.body,
      state: 'open',
      accepted_answer: null,
      accepted_post_id: null,
      capture_target: null,
      promoted_issue_id: null,
      created_ts: input.created_ts,
      updated_ts: input.created_ts,
      resolved_ts: null,
    };
    this.rows.set(input.id, row);
    return { ...row };
  }

  async get(id: string): Promise<ConversationRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async list(opts: ListConversationsOpts = {}): Promise<ConversationRow[]> {
    this.listCalls.push({ ...opts });
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return [...this.rows.values()]
      .filter((r) => !opts.kind || r.kind === opts.kind)
      .filter((r) => !opts.scope || r.scope === opts.scope)
      .filter((r) => !opts.harness_slug || r.harness_slug === opts.harness_slug)
      .filter((r) => !opts.state || r.state === opts.state)
      .sort((a, b) => b.created_ts.localeCompare(a.created_ts))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async setState(id: string, state: ConversationState, opts: { now_ts: string }): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.state = state;
    row.updated_ts = opts.now_ts;
    row.resolved_ts = state === 'resolved' ? opts.now_ts : null;
  }

  async setAcceptedAnswer(
    id: string,
    input: { answer: string; post_id?: number | null; capture_target?: string | null; now_ts: string },
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.accepted_answer = input.answer;
    row.accepted_post_id = input.post_id ?? null;
    row.capture_target = input.capture_target ?? null;
    row.updated_ts = input.now_ts;
  }

  async setPromoted(id: string, input: { issue_id: string; now_ts: string }): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.promoted_issue_id = input.issue_id;
    row.state = 'closed';
    row.updated_ts = input.now_ts;
  }

  async touch(id: string, now_ts: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.updated_ts = now_ts;
  }
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

let store: InMemoryConversationStore;
let threads: InMemoryThreadStore;
let tags: InMemoryTaggableStore;
let subs: InMemoryEntitySubscriptionStore;
let topics: InMemoryTopicStore;
let sinkBox: ReturnType<typeof makeSink>;
let captureCalls: Array<Parameters<CaptureFn>[0]>;
let promotedIssues: Array<{
  title: string;
  body: string;
  scope?: string;
  topics?: string[];
  severity?: string;
  source?: string;
  foundDuring?: string;
}>;
let clock: { now: string };
let deps: ConversationDeps;

beforeEach(() => {
  store = new InMemoryConversationStore();
  threads = new InMemoryThreadStore();
  tags = new InMemoryTaggableStore(new InMemoryLinkStore());
  subs = new InMemoryEntitySubscriptionStore();
  topics = new InMemoryTopicStore();
  sinkBox = makeSink();
  captureCalls = [];
  promotedIssues = [];
  clock = { now: T0 };
  let idSeq = 0;
  deps = {
    conversations: store,
    threads,
    tags,
    subs,
    topics,
    sink: sinkBox.sink,
    capture: async (input) => {
      captureCalls.push(input);
      return { target: `${input.target}:${input.harness_slug ?? `workspace:${input.workspace_id}`}`, ok: true };
    },
    nowIso: () => clock.now,
    newId: (prefix) => `${prefix}-${++idSeq}`,
    promote: {
      createIssue: async (i) => {
        promotedIssues.push(i);
        return { id: `EI-${promotedIssues.length}`, title: i.title };
      },
      reparentThread: async () => ({ reparented: false }),
      issueThreadId: (id) => `issue-thread-${id}`,
    },
  };
});

describe('openConversationCore', () => {
  it('an untagged open is unrouted: delivered 0, unrouted true, deterministic thread, asker full-subscribed', async () => {
    const res = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'who owns the cache?' });

    expect(res.unrouted).toBe(true);
    expect(res.delivered).toBe(0);
    expect(res.topics).toEqual([]);
    expect(res.thread_id).toBe(`thr-${res.conversation.id}`);
    expect(Object.keys(sinkBox.inbox)).toHaveLength(0);

    const rows = await subs.listTargetSubscribers('object', objectToTargetRef({ kind: 'conversation', ref: res.conversation.id }));
    expect(rows).toHaveLength(1);
    expect(rows[0].subscriber_id).toBe('asker');
    expect(rows[0].delivery_mode).toBe('full');
  });

  it('normalizes topic slugs: trims, lowercases, dedupes, drops empties — tags persisted once each', async () => {
    const res = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'q',
      topics: ['  Zero-Cache ', 'zero-cache', 'OTHER', '', '   '],
    });
    expect(res.topics).toEqual(['zero-cache', 'other']);
    expect((await tags.listTags({ kind: 'conversation', ref: res.conversation.id })).sort()).toEqual(['other', 'zero-cache']);
  });

  it('harness_slug forces harness scope even over an explicit scope:"operator"; absent both → operator', async () => {
    const harness = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'q',
      scope: 'operator',
      harness_slug: 'papercup',
    });
    expect(harness.conversation.scope).toBe('harness');
    expect(harness.conversation.harness_slug).toBe('papercup');

    const plain = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q2' });
    expect(plain.conversation.scope).toBe('operator');
    expect(plain.conversation.harness_slug).toBeNull();
  });

  it('a discussion open notifies as discussion_opened with the 💬 rendering', async () => {
    await subs.subscribe({ subscriber_id: 'follower', target_kind: 'topic', target_ref: 'area', created_ts: T0 });
    await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', title: 'design talk', topics: ['area'] });
    expect(sinkBox.inbox.follower).toHaveLength(1);
    expect(sinkBox.inbox.follower[0].notify_kind).toBe('discussion_opened');
    expect(sinkBox.inbox.follower[0].summary).toBe('💬 discussion: design talk');
  });

  it('an untitled open truncates the body into the summary (whitespace-collapsed, 120 chars + ellipsis)', async () => {
    await subs.subscribe({ subscriber_id: 'follower', target_kind: 'topic', target_ref: 'area', created_ts: T0 });
    const long = 'a'.repeat(150);
    await openConversationCore(deps, ident('asker'), { kind: 'question', body: long, topics: ['area'] });
    expect(sinkBox.inbox.follower[0].summary).toBe(`❓ question: ${'a'.repeat(119)}…`);

    sinkBox.clear();
    await openConversationCore(deps, ident('asker2'), { kind: 'question', body: '  line1\n\n line2  ', topics: ['area'] });
    expect(sinkBox.inbox.follower[0].summary).toBe('❓ question: line1 line2');
  });

  // Regression (fixed 2026-06-09): openConversationCore used to fan the OPEN
  // out without an excludeId. The fanout-before-self-subscribe ordering only
  // shields the asker's OBJECT subscription; an asker who already followed one
  // of the question's TOPICS was resolved as a topic subscriber and WAS
  // notified of their own question — violating the module's documented
  // contract. The open fan-out now passes identity.ownerId like every other
  // lifecycle fan-out in this module.
  it('an asker who already follows a tagged topic is NOT notified of their own question', async () => {
    await subs.subscribe({ subscriber_id: 'asker', target_kind: 'topic', target_ref: 'area', created_ts: T0 });
    const res = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    expect(sinkBox.inbox.asker).toBeUndefined();
    expect(res.delivered).toBe(0);
  });

  it('a subscriber-resolution failure never breaks the open (best-effort fan-out → delivered 0)', async () => {
    const failing: SubscribableStore = {
      subscribe: (input) => subs.subscribe(input),
      unsubscribe: (a, b, c) => subs.unsubscribe(a, b, c),
      listSubscriptions: (id) => subs.listSubscriptions(id),
      listTargetSubscribers: async () => {
        throw new Error('pg down');
      },
    };
    deps.subs = failing;

    const res = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    expect(res.delivered).toBe(0);
    expect(res.conversation.state).toBe('open');
    // The write went through despite the delivery failure.
    expect(await store.get(res.conversation.id)).not.toBeNull();
    expect(Object.keys(sinkBox.inbox)).toHaveLength(0);
  });
});

describe('postReplyCore', () => {
  it('a reply notifies as conversation_post, excludes the poster, auto-joins them, and touches the row', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', topics: ['area'] });
    sinkBox.clear();

    clock.now = '2030-01-01T01:00:00.000Z';
    const res = await postReplyCore(deps, ident('replier'), { conversation_id: opened.conversation.id, body: 'a thought' });
    if ('error' in res) throw new Error(res.error);

    expect(res.post.body).toBe('a thought');
    expect(sinkBox.inbox.asker).toHaveLength(1);
    expect(sinkBox.inbox.asker[0].notify_kind).toBe('conversation_post');
    expect(sinkBox.inbox.asker[0].summary).toContain('💬 reply');
    expect(sinkBox.inbox.replier).toBeUndefined();

    const objSubs = await subs.listTargetSubscribers('object', objectToTargetRef({ kind: 'conversation', ref: opened.conversation.id }));
    expect(objSubs.map((s) => s.subscriber_id).sort()).toEqual(['asker', 'replier']);

    // touch-on-activity: updated_ts advanced to the post's clock.
    expect((await store.get(opened.conversation.id))?.updated_ts).toBe('2030-01-01T01:00:00.000Z');
  });

  it('lazily creates the deterministic thread when the conversation row exists without one', async () => {
    await store.create({
      id: 'conv-bare',
      kind: 'discussion',
      scope: 'operator',
      asker_id: 'someone',
      body: 'created off-path, no thread',
      created_ts: T0,
    });
    expect(await threads.getThreadByParent({ kind: 'conversation', ref: 'conv-bare' })).toBeNull();

    const res = await postReplyCore(deps, ident('replier'), { conversation_id: 'conv-bare', body: 'first post' });
    if ('error' in res) throw new Error(res.error);

    const thread = await threads.getThreadByParent({ kind: 'conversation', ref: 'conv-bare' });
    expect(thread?.thread_id).toBe('thr-conv-bare');
    expect((await threads.listPosts('thr-conv-bare')).map((p) => p.body)).toEqual(['first post']);
  });

  it('plumbs mentions through the mention-mode gate: only the @-mentioned mention-mode follower receives', async () => {
    await subs.subscribe({ subscriber_id: 'pinged', target_kind: 'topic', target_ref: 'area', delivery_mode: 'mention', created_ts: T0 });
    await subs.subscribe({ subscriber_id: 'quiet', target_kind: 'topic', target_ref: 'area', delivery_mode: 'mention', created_ts: T0 });
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    sinkBox.clear();

    const res = await postReplyCore(deps, ident('replier'), {
      conversation_id: opened.conversation.id,
      body: 'cc @pinged',
      mentions: ['pinged'],
    });
    if ('error' in res) throw new Error(res.error);

    expect(sinkBox.inbox.pinged).toHaveLength(1);
    expect(sinkBox.inbox.pinged[0].notify_kind).toBe('conversation_post');
    expect(sinkBox.inbox.quiet).toBeUndefined();
  });

  it('returns not_found for an unknown conversation', async () => {
    expect(await postReplyCore(deps, ident('x'), { conversation_id: 'nope', body: 'b' })).toEqual({ error: 'not_found' });
  });
});

describe('resolveConversationCore', () => {
  it('a whitespace-only accepted_answer is no_answer: no capture, no state flip', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const res = await resolveConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      accepted_answer: '   \n  ',
    });
    expect(res).toEqual({ error: 'no_answer' });
    expect(captureCalls).toHaveLength(0);
    expect((await store.get(opened.conversation.id))?.state).toBe('open');
  });

  it('an explicit accepted_answer wins over accepted_post_id (trimmed; the post id is still recorded)', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const ans = await answerQuestionCore(deps, ident('replier'), { conversation_id: opened.conversation.id, body: 'post body answer' });
    if ('error' in ans) throw new Error(ans.error);

    const res = await resolveConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      accepted_answer: '  the explicit answer  ',
      accepted_post_id: ans.post.id,
    });
    if ('error' in res) throw new Error(res.error);

    expect(res.conversation.accepted_answer).toBe('the explicit answer');
    expect(res.conversation.accepted_post_id).toBe(ans.post.id);
    expect(captureCalls[0].answer).toBe('the explicit answer');
  });

  it('when a peer resolves, the asker IS notified (only the resolver is excluded) and capture records both ids', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const ans = await answerQuestionCore(deps, ident('resolver'), { conversation_id: opened.conversation.id, body: 'the fix' });
    if ('error' in ans) throw new Error(ans.error);
    sinkBox.clear();

    const res = await resolveConversationCore(deps, ident('resolver'), {
      conversation_id: opened.conversation.id,
      accepted_post_id: ans.post.id,
    });
    if ('error' in res) throw new Error(res.error);

    expect(sinkBox.inbox.asker).toHaveLength(1);
    expect(sinkBox.inbox.asker[0].notify_kind).toBe('conversation_resolved');
    expect(sinkBox.inbox.resolver).toBeUndefined();
    expect(captureCalls[0].asker_id).toBe('asker');
    expect(captureCalls[0].resolver_id).toBe('resolver');
  });

  it('defaults the capture target to mem0 when none is given', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const res = await resolveConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      accepted_answer: 'done',
    });
    if ('error' in res) throw new Error(res.error);
    expect(captureCalls[0].target).toBe('mem0');
    expect(res.conversation.capture_target).toBe('mem0:workspace:default');
  });
});

describe('join / leave', () => {
  it('join honors the requested mode and converts ttl_sec into expires_ts off the injected clock', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });

    const joined = await joinConversationCore(deps, ident('joiner'), {
      conversation_id: opened.conversation.id,
      mode: 'digest',
      ttl_sec: 3600,
    });
    expect(joined).toEqual({ ok: true, mode: 'digest' });

    const rows = await subs.listSubscriptions('joiner');
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_mode).toBe('digest');
    expect(rows[0].expires_ts).toBe('2030-01-01T01:00:00.000Z'); // T0 + 3600s

    // Defaults: full mode, no expiry.
    const def = await joinConversationCore(deps, ident('joiner2'), { conversation_id: opened.conversation.id });
    expect(def).toEqual({ ok: true, mode: 'full' });
    expect((await subs.listSubscriptions('joiner2'))[0].expires_ts).toBeNull();
  });

  it('leave unsubscribes: a later fan-out no longer reaches the leaver', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    await joinConversationCore(deps, ident('lurker'), { conversation_id: opened.conversation.id });
    await leaveConversationCore(deps, ident('lurker'), opened.conversation.id);
    sinkBox.clear();

    const res = await answerQuestionCore(deps, ident('replier'), { conversation_id: opened.conversation.id, body: 'a' });
    if ('error' in res) throw new Error(res.error);
    expect(sinkBox.inbox.lurker).toBeUndefined();
    expect(sinkBox.inbox.asker).toHaveLength(1);
  });
});

describe('listConversationsWithTopicsCore', () => {
  it('a topic filter pages WIDE (store limit 200) then narrows + re-limits, so a match is not lost behind the caller limit', async () => {
    // Older conversation carries the topic; a NEWER untagged one would otherwise
    // fill a limit-1 scalar page and hide it.
    const tagged = await openConversationCore(deps, ident('a'), { kind: 'question', body: 'tagged', topics: ['area'] });
    clock.now = '2030-01-01T02:00:00.000Z';
    await openConversationCore(deps, ident('a'), { kind: 'question', body: 'newer untagged' });
    store.listCalls = [];

    const rows = await listConversationsWithTopicsCore(deps, { topic: ' AREA ', limit: 1 });
    expect(rows.map((r) => r.id)).toEqual([tagged.conversation.id]);
    expect(rows[0].topics).toEqual(['area']);
    expect(store.listCalls).toEqual([{ limit: 200 }]);

    // Without a topic filter the caller's limit goes straight to the store.
    store.listCalls = [];
    const page = await listConversationsWithTopicsCore(deps, { limit: 1 });
    expect(page.map((r) => r.body)).toEqual(['newer untagged']);
    expect(store.listCalls).toEqual([{ limit: 1 }]);
  });

  it('ignores non-conversation objects tagged with the same topic', async () => {
    const conv = await openConversationCore(deps, ident('a'), { kind: 'question', body: 'q', topics: ['area'] });
    await tags.addTag({ kind: 'issue', ref: 'EI-9' }, 'area', { created_ts: T0 });

    const rows = await listConversationsWithTopicsCore(deps, { topic: 'area' });
    expect(rows.map((r) => r.id)).toEqual([conv.conversation.id]);
  });

  it('returns [] when nothing matches', async () => {
    expect(await listConversationsWithTopicsCore(deps, { topic: 'unused' })).toEqual([]);
  });
});

describe('getConversationCore', () => {
  it('returns null for a missing id', async () => {
    expect(await getConversationCore(deps, 'nope')).toBeNull();
  });

  it('a thread-less off-path row reads back with empty posts/topics and zero subscribers', async () => {
    await store.create({ id: 'conv-bare', kind: 'discussion', scope: 'operator', asker_id: 'a', body: 'b', created_ts: T0 });
    const detail = await getConversationCore(deps, 'conv-bare');
    expect(detail?.conversation.id).toBe('conv-bare');
    expect(detail?.posts).toEqual([]);
    expect(detail?.topics).toEqual([]);
    expect(detail?.subscriber_count).toBe(0);
  });
});

describe('promoteConversationCore', () => {
  it('returns promote_unavailable when no issues bridge is injected', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', topics: ['area'] });
    deps.promote = undefined;
    expect(await promoteConversationCore(deps, ident('asker'), { conversation_id: opened.conversation.id })).toEqual({
      error: 'promote_unavailable',
    });
    expect((await store.get(opened.conversation.id))?.state).toBe('open');
  });

  it('input.harness forces a harness:<slug> issue scope for an operator-scope conversation', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', topics: ['area'] });
    const res = await promoteConversationCore(deps, ident('asker'), { conversation_id: opened.conversation.id, harness: 'pcup' });
    if ('error' in res) throw new Error(res.error);
    expect(promotedIssues[0].scope).toBe('harness:pcup');
  });

  it('an operator conversation without a forced harness mints an operator-scope issue, falling back to the truncated body as title', async () => {
    const body = `${'long problem statement '.repeat(10)}end`;
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body, topics: ['area'] });
    const res = await promoteConversationCore(deps, ident('asker'), { conversation_id: opened.conversation.id });
    if ('error' in res) throw new Error(res.error);

    expect(promotedIssues[0].scope).toBe('operator');
    // Untitled → title is the whitespace-collapsed body truncated to 120 chars.
    const collapsed = body.trim().replace(/\s+/g, ' ');
    expect(promotedIssues[0].title).toBe(`${collapsed.slice(0, 119)}…`);
    expect(promotedIssues[0].title).toHaveLength(120);
    expect(res.conversation.state).toBe('closed');
    expect(res.conversation.promoted_issue_id).toBe('EI-1');
  });
});

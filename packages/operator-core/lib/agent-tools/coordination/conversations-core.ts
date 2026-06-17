/**
 * conversations-core.ts — the conversation/question workflow, PURE over injected
 * stores + sink + capture + clock/id (same core/binding split as topics-core.ts).
 * conversations.ts binds the production stores (getOrgPg), the coordLog sink, the
 * real answer-capture, Date, and newMsgId; the integration tests bind the real PG
 * capability stores over a throwaway container + an in-memory sink + a stub
 * capture + a deterministic clock. So every line here is exercised against real
 * Postgres without touching the prod singletons.
 *
 * The conversation rides the substrate for everything shared and keeps only its
 * own scalars; delivery is the SYNCHRONOUS fan-out (resolveObjectSubscribers ∪
 * topic subs → deliverInjectMany), honoring delivery_mode (D-006), EXCLUDING the
 * actor from their own change, never blocking on a peer (D-002).
 */

import {
  objectKey,
  objectToTargetRef,
  type DeliveryMode,
  type ObjectRef,
  type SubscribableStore,
  type TaggableStore,
  type ThreadableStore,
  type ThreadPostRow,
  type TopicStore,
} from '@papercusp/coordination/capabilities';
import { type InjectEvent, type InjectSink } from './fanout-delivery';
import { fanoutForObject } from '../../sync/hyperbee/fanout-projection';
import type { AgentIdentity } from './identity';
import type {
  ConversationKind,
  ConversationRow,
  ConversationScope,
  ConversationState,
  CreateConversationInput,
  ListConversationsOpts,
} from './conversations-store';
import type { CaptureResult, CaptureTarget } from './answer-capture';

/** The conversation table surface the core needs (PgConversationStore satisfies it). */
export interface ConversationStoreLike {
  create(input: CreateConversationInput): Promise<ConversationRow>;
  get(id: string): Promise<ConversationRow | null>;
  list(opts?: ListConversationsOpts): Promise<ConversationRow[]>;
  setState(id: string, state: ConversationState, opts: { now_ts: string }): Promise<void>;
  setAcceptedAnswer(id: string, input: { answer: string; post_id?: number | null; capture_target?: string | null; now_ts: string }): Promise<void>;
  setPromoted(id: string, input: { issue_id: string; now_ts: string }): Promise<void>;
  touch(id: string, now_ts: string): Promise<void>;
}

/** The bridge to the engineer-issues surface + the thread re-parent (D-005),
 *  injected so promote is testable without the prod getOrgPg singleton. */
export interface PromoteDeps {
  /** Mint an engineer issue (issues-engineer.createIssue). Returns its EI-id + title. */
  createIssue(input: {
    title: string;
    body: string;
    severity?: string;
    source?: string;
    scope?: string;
    topics?: string[];
    foundDuring?: string;
    createdBy?: string;
  }): Promise<{ id: string; title: string }>;
  /** Carry the conversation's thread into the issue (conversations-store.reparentThread). */
  reparentThread(from: ObjectRef, to: ObjectRef, newThreadId: string): Promise<{ reparented: boolean; thread_id?: string }>;
  /** The destination domain's thread_id convention (engineer_issues: `issue-thread-<id>`). */
  issueThreadId(issueId: string): string;
}

/** The capture surface (answer-capture.captureResolvedAnswer satisfies it). */
export type CaptureFn = (input: {
  target: CaptureTarget;
  question: string;
  answer: string;
  scope: ConversationScope;
  harness_slug: string | null;
  workspace_id?: string | null;
  asker_id: string;
  resolver_id: string;
  conversation_id: string;
}) => Promise<CaptureResult>;

export interface ConversationDeps {
  conversations: ConversationStoreLike;
  threads: ThreadableStore;
  tags: TaggableStore;
  subs: SubscribableStore;
  topics: TopicStore;
  /** Delivery sink for the fan-out (coordLog in prod; an in-memory double in tests). */
  sink: InjectSink;
  capture: CaptureFn;
  nowIso: () => string;
  /** Generate an id with the given prefix (newMsgId-backed in prod; a counter in tests). */
  newId: (prefix: string) => string;
  /** Bridge to engineer-issues for conversations:promote (D-005). Absent → promote unavailable. */
  promote?: PromoteDeps;
}

function convRef(id: string): ObjectRef {
  return { kind: 'conversation', ref: id };
}

function truncate(s: string, n = 120): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase();
}

/** Resolve subscribers (direct ∪ topic), drop the actor, deliver honoring mode.
 *  Routed through the canonical fanoutForObject seam (A6), threading this
 *  module's injected stores + sink so the dependency injection its tests rely
 *  on is preserved. Best-effort — a delivery failure never breaks the write. */
async function fanout(deps: ConversationDeps, object: ObjectRef, ev: InjectEvent, excludeId?: string): Promise<number> {
  return fanoutForObject(object, ev, {
    excludeId,
    sink: deps.sink,
    stores: { subscriptions: deps.subs, tags: deps.tags, topics: deps.topics },
  });
}

async function selfSubscribe(deps: ConversationDeps, conversationId: string, subscriberId: string, now: string): Promise<void> {
  await deps.subs.subscribe({
    subscriber_id: subscriberId,
    target_kind: 'object',
    target_ref: objectToTargetRef(convRef(conversationId)),
    delivery_mode: 'full',
    created_ts: now,
  });
}

// ── Open ─────────────────────────────────────────────────────────────────────

export interface OpenConversationInput {
  kind: ConversationKind;
  body: string;
  title?: string;
  topics?: string[];
  scope?: ConversationScope;
  harness_slug?: string;
}

export interface OpenConversationResult {
  conversation: ConversationRow;
  thread_id: string;
  topics: string[];
  delivered: number;
  unrouted: boolean;
}

export async function openConversationCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: OpenConversationInput,
): Promise<OpenConversationResult> {
  const now = deps.nowIso();
  const id = deps.newId('conv');
  const scope: ConversationScope = input.harness_slug ? 'harness' : input.scope ?? 'operator';
  const harness_slug = scope === 'harness' ? input.harness_slug ?? null : null;

  const conversation = await deps.conversations.create({
    id,
    kind: input.kind,
    scope,
    harness_slug,
    asker_id: identity.ownerId,
    title: input.title ?? null,
    body: input.body,
    created_ts: now,
  });

  const thread = await deps.threads.getOrCreateThread(convRef(id), {
    // Deterministic thread_id derived from the conversation id, so every machine
    // converges on ONE canonical thread per conversation (the coord_threads
    // parent-unique index would otherwise reject a peer's thread for the same
    // conversation under a federation race). Federation, Track A.
    thread_id: `thr-${id}`,
    title: input.title,
    created_by: identity.ownerId,
    created_ts: now,
    // Federation: a harness-scoped conversation's thread + posts federate
    // (distributed-coordination-shared-harness-2026-06-04 Track A).
    harness_slug: harness_slug ?? undefined,
  });

  const topics = [...new Set((input.topics ?? []).map(normalizeSlug).filter(Boolean))];
  for (const slug of topics) {
    await deps.tags.addTag(convRef(id), slug, { created_by: identity.ownerId, created_ts: now });
  }

  // Fan out the OPEN to topic subscribers BEFORE the asker self-subscribes, so
  // the asker isn't notified of their own question; then subscribe them so peer
  // answers come back. The ordering only shields the asker's OBJECT
  // subscription — an asker already following one of the question's TOPICS is
  // resolved as a topic subscriber, so they must also be excluded explicitly
  // (excludeId), like every other lifecycle fan-out in this module.
  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${id}`,
    summary: `${input.kind === 'question' ? '❓ question' : '💬 discussion'}: ${input.title ?? truncate(input.body)}`,
    body: input.body,
    notify_kind: input.kind === 'question' ? 'question_opened' : 'discussion_opened',
    isResolution: false,
  };
  const delivered = await fanout(deps, convRef(id), ev, identity.ownerId);
  await selfSubscribe(deps, id, identity.ownerId, now);

  return { conversation, thread_id: thread.thread_id, topics, delivered, unrouted: topics.length === 0 };
}

// ── Post / answer ────────────────────────────────────────────────────────────

export interface PostResult {
  post: ThreadPostRow;
  delivered: number;
}

async function appendPost(
  deps: ConversationDeps,
  identity: AgentIdentity,
  conversationId: string,
  body: string,
  opts: { isAnswer: boolean; mentions?: string[] },
): Promise<PostResult | { error: 'not_found' } | { error: 'resolved' } | { error: 'closed' }> {
  const conv = await deps.conversations.get(conversationId);
  if (!conv) return { error: 'not_found' };
  // A terminal conversation no longer takes posts (P1-17): a resolved question
  // is answered, and a promoted one continues on its issue thread — appending
  // here would silently land a post nobody is watching the conversation for.
  if (conv.state === 'resolved') return { error: 'resolved' };
  if (conv.state === 'closed') return { error: 'closed' };
  const now = deps.nowIso();

  const existing = await deps.threads.getThreadByParent(convRef(conversationId));
  const thread_id =
    existing?.thread_id ??
    (await deps.threads.getOrCreateThread(convRef(conversationId), { thread_id: `thr-${conversationId}`, created_by: identity.ownerId, created_ts: now, harness_slug: conv.harness_slug ?? undefined })).thread_id;

  const post = await deps.threads.addPost({ thread_id, author_id: identity.ownerId, body, created_ts: now });
  await deps.conversations.touch(conversationId, now);
  // Contributing → auto-join (so the rest of the thread reaches the poster), then fan out excluding them.
  await selfSubscribe(deps, conversationId, identity.ownerId, now);

  const verb = opts.isAnswer ? '✅ answer' : '💬 reply';
  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${conversationId}`,
    summary: `${verb} on ${conv.kind} ${conversationId}: ${truncate(body)}`,
    body,
    notify_kind: opts.isAnswer ? 'answer_posted' : 'conversation_post',
    mentions: opts.mentions,
    isResolution: false,
  };
  const delivered = await fanout(deps, convRef(conversationId), ev, identity.ownerId);
  return { post, delivered };
}

export function postReplyCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[] },
): Promise<PostResult | { error: 'not_found' } | { error: 'resolved' } | { error: 'closed' }> {
  return appendPost(deps, identity, input.conversation_id, input.body, { isAnswer: false, mentions: input.mentions });
}

export function answerQuestionCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[] },
): Promise<PostResult | { error: 'not_found' } | { error: 'resolved' } | { error: 'closed' }> {
  return appendPost(deps, identity, input.conversation_id, input.body, { isAnswer: true, mentions: input.mentions });
}

// ── Resolve ──────────────────────────────────────────────────────────────────

export interface ResolveInput {
  conversation_id: string;
  accepted_answer?: string;
  accepted_post_id?: number;
  capture?: CaptureTarget;
}

export interface ResolveResult {
  conversation: ConversationRow;
  capture: CaptureResult;
  delivered: number;
}

export async function resolveConversationCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: ResolveInput,
): Promise<ResolveResult | { error: 'not_found' } | { error: 'no_answer' } | { error: 'already_resolved' }> {
  const conv = await deps.conversations.get(input.conversation_id);
  if (!conv) return { error: 'not_found' };
  // Re-resolving is rejected (P1-17): without this guard a SECOND resolve re-ran
  // capture and OVERWROTE the accepted answer with the new one — silently
  // corrupting the record the first resolver captured. The accepted answer is
  // immutable once set; a genuine correction is a fresh conversation, not a
  // re-resolve. (A promoted-closed conversation is likewise terminal.)
  if (conv.state === 'resolved' || conv.state === 'closed') return { error: 'already_resolved' };
  const now = deps.nowIso();

  let answer = input.accepted_answer?.trim();
  const postId = input.accepted_post_id ?? null;
  if (!answer && postId != null) {
    const thread = await deps.threads.getThreadByParent(convRef(input.conversation_id));
    if (thread) {
      const posts = await deps.threads.listPosts(thread.thread_id);
      const match = posts.find((p) => p.id === postId);
      if (match) answer = match.body.trim();
    }
  }
  if (!answer) return { error: 'no_answer' };

  // Capture into an INDEXED knowledge surface so the NEXT asker gets a sync hit
  // (D-004 — the loop-closer + idle-asker safety net).
  const capture = await deps.capture({
    target: input.capture ?? 'mem0',
    question: conv.title ?? conv.body,
    answer,
    scope: conv.scope,
    harness_slug: conv.harness_slug,
    workspace_id: identity.workspaceId,
    asker_id: conv.asker_id,
    resolver_id: identity.ownerId,
    conversation_id: conv.id,
  });

  await deps.conversations.setAcceptedAnswer(conv.id, { answer, post_id: postId, capture_target: capture.target, now_ts: now });
  await deps.conversations.setState(conv.id, 'resolved', { now_ts: now });

  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${conv.id}`,
    summary: `🏁 resolved ${conv.kind} ${conv.id}: ${truncate(answer)}`,
    body: answer,
    notify_kind: 'conversation_resolved',
    isResolution: true,
  };
  // Notify everyone INCLUDING the asker (only the resolver is excluded).
  const delivered = await fanout(deps, convRef(conv.id), ev, identity.ownerId);

  const updated = (await deps.conversations.get(conv.id)) ?? conv;
  return { conversation: updated, capture, delivered };
}

// ── Join / leave ───────────────────────────────────────────────────────────

export async function joinConversationCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: { conversation_id: string; mode?: DeliveryMode; ttl_sec?: number },
): Promise<{ ok: true; mode: DeliveryMode } | { error: 'not_found' }> {
  const conv = await deps.conversations.get(input.conversation_id);
  if (!conv) return { error: 'not_found' };
  const now = deps.nowIso();
  const expires_ts = input.ttl_sec != null ? new Date(Date.parse(now) + input.ttl_sec * 1000).toISOString() : null;
  const sub = await deps.subs.subscribe({
    subscriber_id: identity.ownerId,
    target_kind: 'object',
    target_ref: objectToTargetRef(convRef(input.conversation_id)),
    delivery_mode: input.mode ?? 'full',
    created_ts: now,
    expires_ts,
  });
  return { ok: true, mode: sub.delivery_mode };
}

export async function leaveConversationCore(deps: ConversationDeps, identity: AgentIdentity, conversationId: string): Promise<void> {
  await deps.subs.unsubscribe(identity.ownerId, 'object', objectToTargetRef(convRef(conversationId)));
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function listConversationsCore(deps: ConversationDeps, input: ListConversationsOpts = {}): Promise<ConversationRow[]> {
  return deps.conversations.list(input);
}

export interface ListConversationsWithTopicsOpts extends ListConversationsOpts {
  /** Filter to conversations tagged with this topic slug (normalized lowercase).
   *  Applied AFTER the scalar filters (kind/state/scope/harness) over the page. */
  topic?: string;
}

export type ConversationWithTopics = ConversationRow & { topics: string[] };

/** List conversations AND their topic tags in one batch (the browse-tab read).
 *  Topics ride a single `listTagsForMany` over the page (no N+1); an optional
 *  `topic` filters to conversations tagged with that slug via the reverse-edge
 *  index. When `topic` is set we page wide (store cap) then narrow + re-limit, so
 *  a topic match isn't lost behind the scalar page's `limit`. */
export async function listConversationsWithTopicsCore(
  deps: ConversationDeps,
  input: ListConversationsWithTopicsOpts = {},
): Promise<ConversationWithTopics[]> {
  const { topic, limit, ...rest } = input;
  const wantTopic = topic?.trim().toLowerCase();
  // When filtering by topic, fetch the full scalar page (store caps at 200) and
  // narrow afterwards; otherwise honor the caller's limit directly.
  let rows = await deps.conversations.list({ ...rest, limit: wantTopic ? 200 : limit });
  if (wantTopic) {
    const tagged = await deps.tags.listTagged(wantTopic);
    const ids = new Set(tagged.filter((o) => o.kind === 'conversation').map((o) => o.ref));
    rows = rows.filter((r) => ids.has(r.id)).slice(0, limit ?? 50);
  }
  if (rows.length === 0) return [];
  const tagMap = await deps.tags.listTagsForMany(rows.map((r) => convRef(r.id)));
  return rows.map((r) => ({ ...r, topics: tagMap.get(objectKey(convRef(r.id))) ?? [] }));
}

export interface ConversationDetail {
  conversation: ConversationRow;
  topics: string[];
  posts: ThreadPostRow[];
  subscriber_count: number;
}

export async function getConversationCore(deps: ConversationDeps, id: string): Promise<ConversationDetail | null> {
  const conversation = await deps.conversations.get(id);
  if (!conversation) return null;
  const topics = await deps.tags.listTags(convRef(id));
  const thread = await deps.threads.getThreadByParent(convRef(id));
  const posts = thread ? await deps.threads.listPosts(thread.thread_id) : [];
  const subscribers = await deps.subs.listTargetSubscribers('object', objectToTargetRef(convRef(id)));
  return { conversation, topics, posts, subscriber_count: subscribers.length };
}

// ── Promote → engineer issue (D-005) ─────────────────────────────────────────
// A question/discussion that concludes "this is a real problem" promotes into an
// engineer_issues row, CARRYING its thread (re-parented, not migrated). The
// conversation is then closed and records the issue id; the discussion continues
// on the issue.

export interface PromoteConversationInput {
  conversation_id: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
  source?: 'engineer' | 'su';
  /** Force a harness-scoped issue (overrides an operator-scope conversation). */
  harness?: string;
}

export interface PromoteConversationResult {
  conversation: ConversationRow;
  issue: { id: string; title: string };
  thread_reparented: boolean;
  delivered: number;
}

export async function promoteConversationCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: PromoteConversationInput,
): Promise<PromoteConversationResult | { error: 'not_found' } | { error: 'already_promoted' } | { error: 'promote_unavailable' }> {
  if (!deps.promote) return { error: 'promote_unavailable' };
  const conv = await deps.conversations.get(input.conversation_id);
  if (!conv) return { error: 'not_found' };
  if (conv.promoted_issue_id) return { error: 'already_promoted' };
  const now = deps.nowIso();

  // engineer_issues encodes the harness in its scope STRING ('operator' | 'harness:<slug>').
  const issueScope =
    conv.scope === 'harness' && conv.harness_slug
      ? `harness:${conv.harness_slug}`
      : input.harness
        ? `harness:${input.harness}`
        : 'operator';
  const topics = await deps.tags.listTags(convRef(conv.id));

  const issue = await deps.promote.createIssue({
    title: conv.title ?? truncate(conv.body, 120),
    body: `${conv.body}\n\n— promoted from conversation ${conv.id}`,
    severity: input.severity ?? 'minor',
    source: input.source ?? 'su',
    scope: issueScope,
    topics,
    foundDuring: `conversation:${conv.id}`,
    createdBy: identity.ownerId,
  });

  // Carry the discussion thread into the issue (D-005 — re-parent, not migrate).
  const rep = await deps.promote.reparentThread(
    convRef(conv.id),
    { kind: 'issue', ref: issue.id },
    deps.promote.issueThreadId(issue.id),
  );

  // Close the conversation + record the promotion.
  await deps.conversations.setPromoted(conv.id, { issue_id: issue.id, now_ts: now });

  // Notify the conversation's subscribers (a terminal event — isResolution so even
  // mention-mode followers hear it).
  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${conv.id}`,
    summary: `⬆️ promoted ${conv.kind} ${conv.id} → issue ${issue.id}: ${truncate(issue.title)}`,
    body: `Promoted to engineer issue ${issue.id}.`,
    notify_kind: 'conversation_promoted',
    isResolution: true,
    extra: { issue_id: issue.id },
  };
  const delivered = await fanout(deps, convRef(conv.id), ev, identity.ownerId);

  const updated = (await deps.conversations.get(conv.id)) ?? conv;
  return { conversation: updated, issue, thread_reparented: rep.reparented, delivered };
}

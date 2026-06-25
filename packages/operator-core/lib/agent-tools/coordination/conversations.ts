/**
 * conversations.ts — the PRODUCTION binding for the conversation workflow (the
 * core/binding split mirrors topics.ts ↔ topics-core.ts). It constructs the
 * @papercusp/coordination capability stores + the PgConversationStore over the
 * org embedded-pg handle, binds the coordLog delivery sink, the real
 * answer-capture, the wall clock, and newMsgId — then re-exports the core
 * functions bound to those prod deps under the names the coord:ask /
 * conversations:* tools import. All workflow logic + delivery lives in
 * conversations-core.ts (so it is integration-tested against real PG without the
 * prod singletons).
 *
 * A conversation is the FIRST consumer of the coordination substrate
 * (coordination-conversations-2026-06-03): Threadable timeline, Taggable topics,
 * Subscribable followers, Lifecycle state, delivered via the synchronous fan-out.
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  PgEntitySubscriptionStore,
  PgTaggableStore,
  PgThreadStore,
  PgTopicStore,
} from '@papercusp/coordination/capabilities';
import { newMsgId } from '@papercusp/coordination/core';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { coordLog } from './log';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { captureResolvedAnswer } from './answer-capture';
import { PgConversationStore, reparentThread } from './conversations-store';
import { createIssue } from '../../issues-engineer';
import { currentRequestWorkspaceId } from '../../workspace-als';

/**
 * EI-1534: scope conversations (and their thread/tags/subs) to the request's
 * workspace so one shared operator sidecar doesn't leak every window's
 * conversations into every other workspace. STRAND-SAFE resolution — request
 * ALS first, then an explicit process pin, then 'default'. We deliberately do
 * NOT fall through to the registry's volatile `reg.current` (what
 * `activeWorkspaceId()` does): unscoped reads landing on `reg.current`
 * (e.g. a lane fleet's 'generic-test') is exactly the strand that reverted the
 * issues per-workspace flip (su-bdc3a, EI-1460). Request-scoped reads isolate
 * correctly; unscoped/background reads stay on the stable 'default' home.
 */
function conversationsScopeWorkspace(): string {
  const req = currentRequestWorkspaceId();
  if (req && req.trim()) return req.trim();
  const env = process.env.PAPERCUSP_WORKSPACE_ID;
  if (env && env.trim()) return env.trim();
  return DEFAULT_COORD_WORKSPACE;
}
import {
  getConversationCore,
  joinConversationCore,
  leaveConversationCore,
  listConversationsCore,
  listConversationsWithTopicsCore,
  openConversationCore,
  postReplyCore,
  answerQuestionCore,
  resolveConversationCore,
  promoteConversationCore,
  type ConversationDeps,
  type ConversationDetail,
  type ConversationWithTopics,
  type ListConversationsWithTopicsOpts,
  type OpenConversationInput,
  type OpenConversationResult,
  type PostResult,
  type PromoteConversationInput,
  type PromoteConversationResult,
  type ResolveInput,
  type ResolveResult,
} from './conversations-core';
import type { AgentIdentity } from './identity';
import type { ConversationRow, ListConversationsOpts } from './conversations-store';
import type { DeliveryMode } from '@papercusp/coordination/capabilities';

const storeOpts = {
  getSql: () => getOrgPg().sql,
  // Schema is defined by migrations 123 (capabilities) + 132 (conversations);
  // the host seam is a no-op.
  ensureSchema: async () => {},
  // EI-1534: per-call workspace scope (request → pin → default). The capability
  // stores + PgConversationStore re-resolve this on every query, so the module
  // singleton below no longer pins to 'default' for the process life.
  getWorkspaceId: () => conversationsScopeWorkspace(),
};

const deps: ConversationDeps = {
  conversations: new PgConversationStore(storeOpts),
  threads: new PgThreadStore(storeOpts),
  // The post/answer durable write runs through ONE bounded, atomic admin-pool txn
  // (pg-bounded-txn): a tx-bound PgThreadStore reuses the exact tested store SQL,
  // so get-or-create-thread + add-post commit together and a DB stall fails fast +
  // typed instead of hanging the MCP call (the admin pool has no default
  // statement_timeout). Mirrors issues-engineer.commentIssue / work-items.commentWorkItem.
  threadTxn: (fn) => boundedOrgTxn((tx) => fn(new PgThreadStore({ ...storeOpts, getSql: () => tx }))),
  tags: new PgTaggableStore(storeOpts),
  subs: new PgEntitySubscriptionStore(storeOpts),
  topics: new PgTopicStore(storeOpts),
  sink: coordLog,
  capture: captureResolvedAnswer,
  nowIso: () => new Date().toISOString(),
  newId: (prefix) => `${prefix}-${newMsgId()}`,
  // Promote bridge (D-005): mint an engineer issue via the issues-engineer
  // surface + carry the thread (re-key to the issue's thread_id convention).
  promote: {
    createIssue: async (i) => {
      const issue = await createIssue({
        title: i.title,
        body: i.body,
        severity: i.severity as 'critical' | 'major' | 'minor' | 'nit' | undefined,
        source: i.source as 'engineer' | 'su' | undefined,
        scope: i.scope,
        topics: i.topics,
        foundDuring: i.foundDuring,
        createdBy: i.createdBy,
      });
      return { id: issue.id, title: issue.title };
    },
    reparentThread: (from, to, newThreadId) =>
      reparentThread(getOrgPg().sql, conversationsScopeWorkspace(), from, to, newThreadId),
    // Mirrors issues-engineer.ts threadId(): `issue-thread-<EI-id>`.
    issueThreadId: (issueId) => `issue-thread-${issueId}`,
  },
};

export type {
  ConversationDetail,
  OpenConversationInput,
  OpenConversationResult,
  PostResult,
  ResolveInput,
  ResolveResult,
} from './conversations-core';

export function openConversation(identity: AgentIdentity, input: OpenConversationInput): Promise<OpenConversationResult> {
  return openConversationCore(deps, identity, input);
}

export function postReply(
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[] },
): Promise<PostResult | { error: 'not_found' } | { error: 'resolved' } | { error: 'closed' }> {
  return postReplyCore(deps, identity, input);
}

export function answerQuestion(
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[] },
): Promise<PostResult | { error: 'not_found' } | { error: 'resolved' } | { error: 'closed' }> {
  return answerQuestionCore(deps, identity, input);
}

export async function resolveConversation(
  identity: AgentIdentity,
  input: ResolveInput,
): Promise<ResolveResult | { error: 'not_found' } | { error: 'no_answer' } | { error: 'already_resolved' }> {
  const result = await resolveConversationCore(deps, identity, input);
  // await-event-primitive-2026-06-05 P-011 (D-006 #3): ask-answered is an
  // awaitable event — a SLEEPING asker is woken when its question resolves
  // (`events:await { event: 'conversation:answered:<id>' }`). The asker is on
  // the notify list too (belt over the core's fanout — same durable inbox).
  // Host-wrapper concern, kept out of the pure core; never breaks the resolve.
  if (!('error' in result)) {
    const conv = result.conversation;
    void import('../../events/await/engine')
      .then(({ emitAwaitedEvent }) =>
        emitAwaitedEvent({
          key: `conversation:answered:${conv.id}`,
          summary: `conversation ${conv.id} resolved: ${(conv.accepted_answer ?? '').slice(0, 200)}`,
          payload: { conversation_id: conv.id, resolver: identity.ownerId },
          to: conv.asker_id && conv.asker_id !== identity.ownerId ? [conv.asker_id] : [],
          source: identity.ownerId,
        }),
      )
      .catch(() => {});
  }
  return result;
}

export function joinConversation(
  identity: AgentIdentity,
  input: { conversation_id: string; mode?: DeliveryMode; ttl_sec?: number },
): Promise<{ ok: true; mode: DeliveryMode } | { error: 'not_found' }> {
  return joinConversationCore(deps, identity, input);
}

export function leaveConversation(identity: AgentIdentity, conversationId: string): Promise<void> {
  return leaveConversationCore(deps, identity, conversationId);
}

export function listConversations(input: ListConversationsOpts = {}): Promise<ConversationRow[]> {
  return listConversationsCore(deps, input);
}

export function listConversationsWithTopics(input: ListConversationsWithTopicsOpts = {}): Promise<ConversationWithTopics[]> {
  return listConversationsWithTopicsCore(deps, input);
}

export function getConversation(id: string): Promise<ConversationDetail | null> {
  return getConversationCore(deps, id);
}

export function promoteConversation(
  identity: AgentIdentity,
  input: PromoteConversationInput,
): Promise<PromoteConversationResult | { error: 'not_found' } | { error: 'already_promoted' } | { error: 'promote_unavailable' }> {
  return promoteConversationCore(deps, identity, input);
}

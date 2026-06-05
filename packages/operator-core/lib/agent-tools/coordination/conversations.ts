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
import { captureResolvedAnswer } from './answer-capture';
import { PgConversationStore, reparentThread } from './conversations-store';
import { createIssue } from '../../issues-engineer';
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
};

const deps: ConversationDeps = {
  conversations: new PgConversationStore(storeOpts),
  threads: new PgThreadStore(storeOpts),
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
      reparentThread(getOrgPg().sql, DEFAULT_COORD_WORKSPACE, from, to, newThreadId),
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
): Promise<PostResult | { error: 'not_found' }> {
  return postReplyCore(deps, identity, input);
}

export function answerQuestion(
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[] },
): Promise<PostResult | { error: 'not_found' }> {
  return answerQuestionCore(deps, identity, input);
}

export function resolveConversation(
  identity: AgentIdentity,
  input: ResolveInput,
): Promise<ResolveResult | { error: 'not_found' } | { error: 'no_answer' }> {
  return resolveConversationCore(deps, identity, input);
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

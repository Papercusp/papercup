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
import { currentRequestWorkspaceId, runWithWorkspaceIfConcrete } from '../../workspace-als';

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
export function conversationsScopeWorkspace(): string {
  const req = currentRequestWorkspaceId();
  if (req && req.trim()) return req.trim();
  const env = process.env.PAPERCUSP_WORKSPACE_ID;
  if (env && env.trim()) return env.trim();
  return DEFAULT_COORD_WORKSPACE;
}

/**
 * WI-1571 (workspace-threading class, sibling of WI-1564): resolve the
 * workspace partition a conversation write/read should use from the CALLER's
 * `identity.workspaceId` — mirrors `resolveClaimSpecWorkspace`
 * (scheduler/claim-spec-store.ts, WI-1564) exactly.
 *
 * THE BUG: `conversationsScopeWorkspace()` above (EI-1534) only ever consults
 * request-ALS → env → 'default'. A HARNESS-scoped conversation opened from a
 * context with no request ALS (a background/system caller — e.g. a queen
 * principal acting for a shared hive) therefore lands under the literal
 * 'default' workspace partition, even when the hive's real home is a
 * DIFFERENT, concrete workspace. The federation outbox-drain only serves the
 * booted (workspace, harness) handle for that hive's REAL home — a row
 * captured under (default, <hive>) is never drained (live evidence: 4
 * coord_conversations + 4 coord_threads rows undrained under
 * (default, papercusp), newest 2026-07-02 06:56).
 *
 * THE FIX: every identity-bearing entry point below (open/reply/answer/
 * resolve/join/leave/promote) already receives `identity.workspaceId` — the
 * caller's OWN resolved workspace (for a harness-scoped principal this is
 * `principal.workspaceId`, the hive's registered home; identity.ts). Running
 * the call through `runWithWorkspaceIfConcrete(identityWs, fn)` (workspace-als)
 * pins that value onto `currentRequestWorkspaceId()` for the call's async
 * extent, so `conversationsScopeWorkspace()` picks it up as its TOP-priority
 * read — the SAME resolver every downstream store op (write AND read) uses.
 * Two independent callers scoped to the SAME hive therefore agree on the
 * partition (the WI-1564 "resolver shared by writer+reader" invariant),
 * instead of both silently falling through to 'default'. An identity with no
 * concrete workspaceId (unscoped SU/power-user session) is UNCHANGED —
 * `runWithWorkspaceIfConcrete` is a no-op and the existing request→env→
 * default chain still applies (STRAND-SAFE, EI-1460 — never pins the
 * volatile `reg.current`).
 *
 * Reads (`getConversation` / `listConversations` / `listConversationsWithTopics`)
 * take an OPTIONAL identity: the original WI-1571 fix threaded writes only, on
 * the assumption reads came exclusively from request-scoped UI/TUI contexts —
 * but the agent MCP tools (conversations:get/list, plans:attention) and the
 * coord-op caps (listPosts/readAnswer, i.e. coord:ask-owner's answer poll) read
 * from contexts with NO request ALS, so they landed on 'default' while the same
 * caller's writes landed on identity.workspaceId. Live evidence 2026-07-07: 23
 * conversations under (papercusp-workspace) invisible to conversations:get/list,
 * and every coord:ask-owner bounded wait timing out because readAnswer polled
 * the wrong partition. Identity-bearing read callers must pass their identity;
 * UI/sync-resolver reads stay identity-less on the request-ALS chain.
 */
export function resolveConversationsIdentityWorkspace(
  identityWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identityWorkspaceId?.trim();
  return ws && ws !== '*' ? ws : undefined;
}

/** Run `fn` with the identity's workspace pinned (see resolver doc above). A
 *  harness-scoped open with NO resolvable workspace (neither the caller's
 *  identity nor an ambient request scope) is the exact strand condition — warn
 *  loudly so it's visible instead of silently mis-partitioning (mirrors
 *  claim-spec-store's `warning` field, surfaced here via a log since
 *  OpenConversationResult's shape is owned by conversations-core.ts). */
export function withConversationsIdentityScope<T>(
  identity: AgentIdentity,
  harnessSlugIfOpening: string | undefined,
  fn: () => T,
): T {
  const identityWs = resolveConversationsIdentityWorkspace(identity.workspaceId);
  if (!identityWs && harnessSlugIfOpening && !currentRequestWorkspaceId() && !process.env.PAPERCUSP_WORKSPACE_ID) {
    console.warn(
      `[conversations] opening a harness-scoped conversation (harness_slug='${harnessSlugIfOpening}') ` +
        `with no resolvable workspace (identity.workspaceId and the request scope are both unset) — ` +
        `it will land under the '${DEFAULT_COORD_WORKSPACE}' partition, which the federation outbox-drain ` +
        `likely does not serve for this harness (WI-1571). Thread a workspace-scoped identity.`,
    );
  }
  return runWithWorkspaceIfConcrete(identityWs, fn);
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
  return withConversationsIdentityScope(identity, input.harness_slug, () =>
    openConversationCore(deps, identity, input),
  );
}

export function postReply(
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[] },
): Promise<PostResult | { error: 'not_found' } | { error: 'resolved' } | { error: 'closed' }> {
  return withConversationsIdentityScope(identity, undefined, () => postReplyCore(deps, identity, input));
}

export function answerQuestion(
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[] },
): Promise<PostResult | { error: 'not_found' } | { error: 'resolved' } | { error: 'closed' }> {
  return withConversationsIdentityScope(identity, undefined, () => answerQuestionCore(deps, identity, input));
}

export async function resolveConversation(
  identity: AgentIdentity,
  input: ResolveInput,
): Promise<ResolveResult | { error: 'not_found' } | { error: 'no_answer' } | { error: 'already_resolved' }> {
  const result = await withConversationsIdentityScope(identity, undefined, () =>
    resolveConversationCore(deps, identity, input),
  );
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
  return withConversationsIdentityScope(identity, undefined, () => joinConversationCore(deps, identity, input));
}

export function leaveConversation(identity: AgentIdentity, conversationId: string): Promise<void> {
  return withConversationsIdentityScope(identity, undefined, () =>
    leaveConversationCore(deps, identity, conversationId),
  );
}

// Reads: identity is OPTIONAL (see the resolver doc above) — an identity-bearing
// caller (agent tool / coord-op cap) passes it so reader and writer resolve the
// SAME partition; an identity-less caller (UI/sync-resolver, request-scoped)
// keeps the request-ALS chain unchanged.
export function listConversations(input: ListConversationsOpts = {}, identity?: AgentIdentity): Promise<ConversationRow[]> {
  const run = () => listConversationsCore(deps, input);
  return identity ? withConversationsIdentityScope(identity, undefined, run) : run();
}

export function listConversationsWithTopics(
  input: ListConversationsWithTopicsOpts = {},
  identity?: AgentIdentity,
): Promise<ConversationWithTopics[]> {
  const run = () => listConversationsWithTopicsCore(deps, input);
  return identity ? withConversationsIdentityScope(identity, undefined, run) : run();
}

export function getConversation(id: string, identity?: AgentIdentity): Promise<ConversationDetail | null> {
  const run = () => getConversationCore(deps, id);
  return identity ? withConversationsIdentityScope(identity, undefined, run) : run();
}

export function promoteConversation(
  identity: AgentIdentity,
  input: PromoteConversationInput,
): Promise<PromoteConversationResult | { error: 'not_found' } | { error: 'already_promoted' } | { error: 'promote_unavailable' }> {
  return withConversationsIdentityScope(identity, undefined, () => promoteConversationCore(deps, identity, input));
}

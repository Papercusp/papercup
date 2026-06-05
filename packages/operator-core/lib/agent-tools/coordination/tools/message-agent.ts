/**
 * coord:message-agent — open a work-item-scoped conversation with a specific
 * agent (inbox-tiering-and-message-agent-2026-06-05, D-004, P-004).
 *
 * The inbox's "Message owner" action: the human (or any agent) opens a thread
 * with the agent that owns an attention item, scoped to that item's work-item.
 * It is the inbox-entry half of the conversations surface — Brief 25's
 * conversations-tab browses the same `coord_conversations` rows.
 *
 * Conversations fan out to topic/object SUBSCRIBERS, not to a directly-named
 * recipient, so reaching one specific agent takes three steps:
 *   1. open a `discussion` conversation (scoped to the item's harness, tagged
 *      with any work-item topics) carrying the message as its body — this is
 *      the durable, browseable thread;
 *   2. subscribe the owning agent to the conversation object, so every later
 *      reply in the thread reaches them;
 *   3. ping the owning agent via a direct coord message (the path agents read
 *      mid-turn), pointing at the conversation so they reply in-thread.
 *
 * `to` (the owning agent) is optional: an item with no single agent owner
 * (plan-item / smoke-fail / plan-review) opens a harness-scoped conversation
 * with no direct ping — its harness's agents still see it via scope/topic
 * (D-005 graceful degradation).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { PgEntitySubscriptionStore, objectToTargetRef } from '@papercusp/coordination/capabilities';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { openConversation } from '../conversations';
import { sendMessage } from '../messages';

function jsonText(v: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(v) }] };
}

function truncate(s: string, n = 100): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export default defineTool({
  name: 'coord:message-agent',
  description:
    "Open a work-item-scoped conversation with a specific agent — the inbox's \"Message owner\" action. Creates a browseable discussion thread (Brief 25's conversations tab) scoped to the item's harness, subscribes the owning agent, and pings them so they reply in-thread. Returns { conversation_id, thread_id }.",
  guidance: {
    when: 'You (or the human via the inbox) want to message the agent that owns a specific work-item — start a durable, scoped thread with them about that item.',
    notWhen:
      'A quick one-off note to a peer with no thread — use coord:send. A question to the OWNER/human — coord:ask-owner. A reply in an existing conversation — conversations:post.',
    chaining: 'coord:message-agent → conversations:get to read the thread → conversations:post to reply.',
    byRole: {
      operator: 'Message the agent that owns an inbox item to unblock it without taking over the work.',
    },
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    /** The owning agent's ownerId. Optional: absent → a harness-scoped
     *  conversation with no direct ping (no single agent owner). */
    to: z.string().min(1).optional(),
    /** The message to the owner. */
    body: z.string().min(1),
    /** A short thread title (defaults to a work-item label / the body). */
    title: z.string().optional(),
    /** Scope the conversation + thread to this harness (the item's harness). */
    harness: z.string().optional(),
    /** The plan slug the item belongs to, for the title/link. */
    plan_slug: z.string().optional(),
    /** The work-item ref (P-NNN), for the title/link. */
    item_ref: z.string().optional(),
    /** Topic slugs to tag the conversation with (work-item linkage). */
    topics: z.array(z.string().min(1)).max(8).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workItemLabel =
      args.item_ref && args.plan_slug
        ? `${args.plan_slug} ${args.item_ref}`
        : args.item_ref || args.plan_slug || null;
    const title = args.title?.trim() || (workItemLabel ? `Re ${workItemLabel}` : truncate(args.body));

    // 1. Open the durable, browseable conversation (scoped to the work-item).
    const opened = await openConversation(identity, {
      kind: 'discussion',
      title,
      body: args.body,
      topics: args.topics,
      harness_slug: args.harness,
    });
    const conversationId = opened.conversation.id;

    // 2. Subscribe the owning agent so every later thread reply reaches them.
    let subscribedOwner = false;
    if (args.to && args.to !== identity.ownerId) {
      try {
        const subs = new PgEntitySubscriptionStore({
          getSql: () => getOrgPg().sql,
          ensureSchema: async () => {},
        });
        await subs.subscribe({
          subscriber_id: args.to,
          target_kind: 'object',
          target_ref: objectToTargetRef({ kind: 'conversation', ref: conversationId }),
          delivery_mode: 'full',
          created_ts: new Date().toISOString(),
        });
        subscribedOwner = true;
      } catch {
        /* best-effort — the ping below still reaches the owner */
      }
    }

    // 3. Ping the owning agent directly so they see it this turn + reply in-thread.
    let pinged = false;
    if (args.to && args.to !== identity.ownerId) {
      try {
        await sendMessage(identity, {
          to: [args.to],
          summary: `💬 ${identity.ownerLabel ?? identity.ownerId} messaged you${workItemLabel ? ` re ${workItemLabel}` : ''}`,
          body: `${args.body}\n\n— reply in conversation ${conversationId} (conversations:post).`,
          ...(args.harness ? { harnessSlug: args.harness } : {}),
          ...(args.plan_slug ? { plan_slug: args.plan_slug } : {}),
        });
        pinged = true;
      } catch {
        /* best-effort */
      }
    }

    return jsonText({
      ok: true,
      conversation_id: conversationId,
      thread_id: opened.thread_id,
      to: args.to ?? null,
      subscribedOwner,
      pinged,
    });
  },
});

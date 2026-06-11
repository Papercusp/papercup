/**
 * coord:send — send a typed message (or coord broadcast) to one or
 * more other agents. agent-coordination-architecture-v2 §6.4 (#6).
 *
 * Persists to the `messages` surface of the CoordEventLog (the operator
 * backs it with Postgres — harness_shared.coord_event_log). Recipients
 * see it via coord:inbox.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { sendMessage } from '../messages';
import { wakeRecipients } from '../inbox-wake';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:send',
  description:
    'Send a message to other coordination agents. `to` is a list of ownerIds; use ["*"] to broadcast, ["human"] to surface to the user. By default the message is INJECTED (lands in the recipient\'s inbox, seen on their next natural turn — cheap, no token cost). Pass `wake:true` to ALSO re-invoke a SLEEPING recipient now (deliver-and-wake) — targeted to exactly the addressees, never a broadcast. Returns the assigned msg_id.',
  guidance: {
    when: 'Sharing context with another agent — "I just finished X, the next step is Y", or asking a question, or handing off a piece of work. Use wake:true ONLY when the recipient is idle/asleep and must act now (a Queen placing work onto a sleeping bee); a running recipient already sees the inject mid-turn, so wake is wasted on it.',
    notWhen: 'For an in-conversation reply to the human, just speak. For locking a file, use locks:acquire — coord:send is async/eventual, not a lock. Don\'t set wake:true for routine/ambient notes — a wake is a billable turn (unify-watch D-002: inject is the default, wake is the deliberate opt-in).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    to: z.array(z.string().min(1)).min(1),
    summary: z.string().min(1),
    body: z.string().optional(),
    files: z.array(z.string()).optional(),
    plan_slug: z.string().optional(),
    related_msg_id: z.string().optional(),
    wake: z
      .boolean()
      .optional()
      .describe(
        'Default false (cheap inject). true = ALSO fire each addressee\'s inbox-wake key so a SLEEPING recipient is re-invoked now. Targeted to the addressees only — never a broadcast wake (\'*\'/\'human\' are skipped).',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Record the sender's harness when it's a real, harness-scoped agent
    // (pipeline roles carry ctx.harnessSlug). '*'/empty = operator/SU/oracle
    // wildcard ⇒ workspace-level (broadcast); leave harness unset there.
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harnessSlug =
      typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;
    const env = await sendMessage(identity, {
      to: args.to,
      summary: args.summary,
      body: args.body,
      files: args.files,
      plan_slug: args.plan_slug,
      related_msg_id: args.related_msg_id,
      ...(harnessSlug ? { harnessSlug } : {}),
      // EI-279: persist the wake intent ON the envelope so it federates — a
      // recipient homed on a REMOTE instance is woken by the coord-message
      // projection's fan when the row arrives there (the local fan below only
      // covers THIS instance's await store).
      ...(args.wake ? { extra: { wake: true } } : {}),
    });

    // Deliver-and-wake (P-040): the message already persisted to the inbox above
    // (the durable default). When the sender opted in, ALSO fire each addressed
    // recipient's OWN inbox-wake key so a SLEEPING addressee is re-invoked — one
    // targeted emit per ownerId, NEVER a broadcast key (P-042). We wake the
    // POST-expansion recipients (`env.to` — audience selectors already resolved),
    // so a `@plan:`/`@topic:` send wakes exactly the resolved set, not '*'.
    let wake: { targets: string[]; woken: number; warning?: string } | undefined;
    if (args.wake) {
      const fan = await wakeRecipients(env.to, {
        summary: args.summary,
        source: identity.ownerId,
      });
      wake = { targets: fan.targets, woken: fan.woken };
      // turn-lifecycle-control P-007 / D-010: a wake:true that fired with zero
      // live awaits re-invoked NO ONE — it degraded to a plain inbox inject.
      // Surface that instead of a silent ok (the gap that made su-d96e6 look
      // fine when nothing was listening).
      if (fan.targets.length > 0 && fan.woken === 0) {
        wake.warning =
          'wake fired but no live wake-watch was registered for the addressee(s) — the message was injected to their inbox (seen on their next natural turn) but no session was re-invoked now.';
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, msg_id: env.msg_id, ts: env.ts, ...(wake ? { wake } : {}) }),
        },
      ],
    };
  },
});

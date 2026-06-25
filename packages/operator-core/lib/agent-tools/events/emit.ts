/**
 * events:emit — fire an event through the await-event primitive
 * (await-event-primitive-2026-06-05 P-003, D-001).
 *
 * The agent-facing half of the emit surface (sources inside the host call
 * `emitAwaitedEvent` directly). The emitter is the SOURCE layer: it has
 * already resolved who the event concerns — a targeted key both sides agreed
 * on, and/or an explicit `to[]` (ownerIds / Brief 28 @-selectors / '*' /
 * 'human'). Delivery is policy-per-recipient: wake-awaiters on the key are
 * woken (durable, liveness-adaptive); the rest of `to[]` get one coord inbox
 * message (notify — never wakes).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitAwaitedEvent } from '../../events/await/engine';
import { softText, clampText, LIMITS } from '../limits';

export default defineTool({
  name: 'events:emit',
  description:
    'Fire an event key through the await-event primitive: every agent with an events:await on the key is woken (durable delivery — pty-inject / session-resume / inbox ladder); an optional `to` list additionally receives a coord inbox notification (notify policy — never wakes). Use the key your waiter registered (events:await tells them what to wait on).',
  guidance: {
    when: 'Announcing that the thing a peer is blocked on has happened: their requested work is done, an artifact landed, a decision resolved. Pair with events:await — the waiter registers the key, you emit it. (To WAKE a parked AGENT — re-invoke its turn — the key is `coord:inbox-wake:<ownerId>`, but prefer the higher-level verbs that hide the key: coord:wake to nudge, coord:dispatch to assign+wake, coord:send {wake:\'required\'} to message+wake.)',
    notWhen:
      'General status narration — lifecycle auto-emits + work_items:complete already cover it. Conversation — coord:send. Waking a specific agent — use coord:wake / coord:dispatch (they fire the inbox-wake key for you + report woken/dead). If nobody could plausibly be awaiting the key and you have no `to`, the emit reaches no one (it is not a log).',
    chaining: 'Peer: events:await { event: K } → you: do the work → events:emit { event: K, summary } → peer wakes.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    event: z.string().min(1).max(200).describe('Exact event key to fire.'),
    summary: softText(LIMITS.ANNOTATION).optional().describe('One human line — rides the wake turn / notify summary. Auto-truncated to 2000 chars if longer.'),
    payload: z.unknown().optional().describe('Structured data carried on the wake (truncated at 400 chars in the turn text).'),
    to: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Additional NOTIFY audience: ownerIds, @plan:/@topic:/@object:/@file: selectors, '*' or 'human'. Wake-awaiters are excluded (their wake already carries it)."),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const result = await emitAwaitedEvent({
      key: args.event,
      summary: clampText(args.summary, LIMITS.ANNOTATION),
      payload: args.payload,
      to: args.to,
      source: identity.ownerId,
      workspaceId: identity.workspaceId ?? undefined,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            event: result.key,
            woken: result.woken,
            notified: result.notified.length,
            msg_id: result.msgId,
          }),
        },
      ],
    };
  },
});

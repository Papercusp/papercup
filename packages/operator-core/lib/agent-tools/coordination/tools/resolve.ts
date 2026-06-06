/**
 * coord:resolve — record the human's choice on an escalation.
 *
 * Append-only: writes a sibling `escalation_resolved` event; the open
 * escalation file is never mutated. Idempotent on an already-resolved
 * escalation (returns already_resolved without appending).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { resolveEscalation } from '../escalations';
import { unblockLinkedCard } from '../card-link';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:resolve',
  description:
    'Resolve an escalation by msg_id. Records the chosen option id (or arbitrary string) and optional note as an append-only escalation_resolved event.',
  guidance: {
    when: 'The human (or an authorised agent acting on their behalf) has decided how to proceed on an open escalation.',
    notWhen: 'Acknowledging without deciding — use coord:ack. The escalation file is the human-resolution surface.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    msg_id: z.string().min(1),
    choice: z.string().min(1),
    note: z.string().optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const out = await resolveEscalation({
      msg_id: args.msg_id,
      choice: args.choice,
      note: args.note,
      resolver: identity.ownerId,
    });
    if (out === 'not_found') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'not_found',
              detail: `no escalation with msg_id=${args.msg_id}`,
            }),
          },
        ],
        isError: true,
      };
    }
    if (out === 'already_resolved') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'already_resolved',
              detail: `escalation msg_id=${args.msg_id} already has a resolution`,
            }),
          },
        ],
        isError: true,
      };
    }
    if (out === 'requires_spawn_approve') {
      // unify-agent-spawn-chokepoint P-005/P-006: a new_subagent spawn-approval
      // request is brain-only — coord:resolve (open to all coord roles) may not
      // decide it; route the brain to the gated tool.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'requires_spawn_approve',
              detail: `msg_id=${args.msg_id} is a new_subagent spawn request — only the brain may decide it, via new_subagent:approve`,
            }),
          },
        ],
        isError: true,
      };
    }
    // inbox-cards-unification Phase D (P-035): if this escalation was linked to
    // a live ctx.askUser card (agent blocked waiting), unblock it too so an
    // inbox resolution resumes the agent. No-op when unlinked (flag-off) or the
    // card already resolved; the escalation is resolved regardless.
    unblockLinkedCard(out, args.choice);
    // await-event-primitive-2026-06-05 P-015: a SLEEPING escalator (no live
    // askUser card) wakes on `escalation:resolved:<msg_id>` (events:await).
    // The resolution event above already covers the inbox/notify half.
    void import('../../../events/await/engine')
      .then(({ emitAwaitedEvent }) =>
        emitAwaitedEvent({
          key: `escalation:resolved:${args.msg_id}`,
          summary: `escalation resolved → ${args.choice}${args.note ? ` — ${args.note}` : ''}`,
          payload: { msg_id: args.msg_id, choice: args.choice, resolver: identity.ownerId },
          source: identity.ownerId,
        }),
      )
      .catch(() => {});
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, escalation: out }),
        },
      ],
    };
  },
});

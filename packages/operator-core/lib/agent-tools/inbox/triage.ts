/**
 * inbox:triage — the operator's inbox-triage PASS
 * (inbox-tiering-and-message-agent-2026-06-05, D-006, P-017).
 *
 * At each user-driven wake the operator manages the inbox FIRST: it
 * downgrades false-positive decisions, ESCALATES under-flagged items its bigger
 * context flags as urgent, and confirms/resolves the rest. Each call persists a
 * triage record (attention_triage) which plans:attention overlays via
 * applyTriage to produce the final tier:
 *   - downgrade / resolve → "Handled by operator" tier (VISIBLE + auditable —
 *     never a silent vanish; the note records WHY).
 *   - escalate / confirm  → Decision tier (escalate promotes; confirm vets).
 *
 * Surface-first invariant (D-006): triage is a PASS, not a gate — an
 * agent-surfaced need_human is user-visible immediately and only LATER triaged.
 * There is no operator-gated intermediate state.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { TRIAGE_ACTIONS, triageActionToState } from '../../attention/types';
import { upsertTriage } from '../../attention/triage-store';

function jsonText(v: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(v) }] };
}

export default defineTool({
  name: 'inbox:triage',
  description:
    'Triage one attention item (the operator inbox PASS): downgrade a false positive or resolve it → the auditable "Handled by operator" tier; escalate an under-flagged item or confirm a real one → the Decisions tier. Record WHY in `note` (required on downgrade/resolve). The downgrade is always visible + auditable, never a silent vanish.',
  guidance: {
    when: 'Managing the inbox at a wake — re-tiering an attention item after reading it: downgrade noise, escalate something a worker under-flagged, or confirm/resolve a real decision.',
    notWhen:
      'Acting on the item itself (resolve an escalation → coord:resolve; mark a plan item done → plans:set-status). Messaging the owning agent → coord:message-agent.',
    byRole: {
      operator:
        'Run this FIRST each wake over the Decisions tier (downgrade false positives, escalate under-flagged) and leave the inbox clean before sleeping; always record the why in `note`.',
    },
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      /** The AttentionItem id (`<kind>:<…>`, e.g. `coord-escalation:<msgId>`). */
      itemId: z.string().min(1),
      action: z.enum(TRIAGE_ACTIONS as unknown as [string, ...string[]]),
      /** What the operator did + why — the audit note (and the operator's own
       *  learning signal). Required when downgrading/resolving. */
      note: z.string().max(2000).optional(),
    })
    .refine((d) => !(d.action === 'downgrade' || d.action === 'resolve') || !!d.note?.trim(), {
      message: 'note (the why) is required when downgrading or resolving',
      path: ['note'],
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const action = args.action as (typeof TRIAGE_ACTIONS)[number];
    await upsertTriage({
      itemId: args.itemId,
      action,
      note: args.note?.trim() ?? null,
      triagedBy: identity.ownerId,
    });
    const triageState = triageActionToState(action);
    const tier =
      triageState === 'downgraded' || triageState === 'resolved' ? 'handled' : 'decision';
    return jsonText({ ok: true, itemId: args.itemId, action, triageState, tier });
  },
});

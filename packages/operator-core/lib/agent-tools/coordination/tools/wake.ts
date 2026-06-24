/**
 * coord:wake — the discoverable "wake a parked agent NOW" verb
 * (fleet-dispatch-wake-clarity-2026-06-22 P-006).
 *
 * Before this, waking a parked agent meant reverse-engineering `events:emit` on the
 * `coord:inbox-wake:<ownerId>` key — and coordinators kept reaching for `coord:wake` /
 * `coord:nudge` / `fleet:wake` and getting a 404. This is the alias that closes that
 * gap: a BARE wake (re-invoke the target's turn so it re-orients) with an OPTIONAL
 * one-line nudge, NO durable inbox row required.
 *
 * Distinct from its siblings:
 *   - coord:dispatch — assign a LANE + deliver a note + wake + confirm pickup (the rich
 *     "hand off work" primitive). Use it when you are giving the agent something to do.
 *   - coord:send {wake:'required'} — deliver a contextual MESSAGE and wake.
 *   - coord:wake — JUST wake (the target re-orients on its own claimed lane). Use it when
 *     the work is already assigned (plan_items:assign / a prior dispatch) and you only need
 *     the agent to start a turn and pick it up.
 *
 * Composes the shipped wake substrate (`wakeRecipients` fires the per-owner inbox-wake key;
 * `reportIdleRecipients` classifies a miss) — it builds NO second wake pump, and reports an
 * `ended`/dead target LOUDLY (a wake that reached nobody is a relaunch signal, never a silent
 * woken:0).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { wakeRecipients, reportIdleRecipients } from '../inbox-wake';
import { resolveRecipients, isSelectorOrWildcard } from '../recipient-resolve';

export default defineTool({
  name: 'coord:wake',
  description:
    "Wake a PARKED agent NOW so it starts a turn and re-orients on its already-claimed lane — the discoverable alias for the events:emit coord:inbox-wake:<id> key (which agents kept 404ing on as coord:wake/coord:nudge). Single-target (never '*'). Optional `note` is a one-line nudge; omit for a bare wake. Returns { ok, to, woken, recipient_dead?, warning? }. A wake that reaches no live session is a LOUD miss (the target is `ended` → relaunch it), never a silent woken:0. To ALSO hand off a lane, use coord:dispatch; to deliver a contextual message, coord:send {wake:'required'}.",
  guidance: {
    when: 'The work is ALREADY assigned to the target (plan_items:assign or a prior dispatch) and you just need it to start a turn and pick it up — a re-orient nudge. Pick a `parked` target (coord:presence → sessionState:parked).',
    notWhen: 'You are assigning a NEW lane — use coord:dispatch (assign+wake+confirm). You have a contextual message to deliver — use coord:send {wake:\'required\'}. The target is `ended` (coord:presence) — it needs a relaunch/resume, not a wake.',
    chaining: 'coord:presence (find a parked target) → coord:wake { to } → check `woken`/`warning`. The woken target: coord:orient → claim + work its lane.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    to: z
      .string()
      .min(1)
      .describe('The target agent — its ownerId or the short handle from [coord+N]/coord:presence. Single-target only (never "*").'),
    note: z
      .string()
      .max(2000)
      .optional()
      .describe('Optional one-line reason the target sees on waking (e.g. "your lane is ready — pick it up"). Omit for a bare wake.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? undefined;

    // Never wake a wildcard/human/selector — coord:wake is single-target by contract.
    if (isSelectorOrWildcard(args.to)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'not_a_single_target',
              message:
                'coord:wake is single-target — it cannot wake "*"/"human"/an audience selector (that would thunder-herd the fleet). Name one agent.',
            }),
          },
        ],
      };
    }

    // Resolve a short handle/prefix to the full ownerId so the exact inbox-wake key
    // matches (a short prefix would fire a key nobody watches). A miss is a loud error.
    let to = args.to;
    try {
      const r = await resolveRecipients([args.to], workspaceId);
      if (r.unknown.length || r.ambiguous.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'unknown_recipient',
                message:
                  'coord:wake addressed an agent not in the roster — nothing was woken. Use the short handle from [coord+N]/coord:presence, the su- prefix, or the full ownerId.',
                ...(r.unknown.length ? { unknown_recipients: r.unknown } : {}),
                ...(r.ambiguous.length ? { ambiguous_recipients: r.ambiguous } : {}),
              }),
            },
          ],
        };
      }
      to = r.resolved[0] ?? args.to;
    } catch {
      // fail-soft: a roster hiccup degrades to the raw id (the wake key may still match).
    }

    // Fire the target's inbox-wake key (reuse the shipped fan — no second pump).
    const fan = await wakeRecipients([to], {
      summary: args.note ?? 'coord:wake — re-orient and continue your lane',
      source: identity.ownerId,
      workspaceId,
    });
    const woken = fan.woken;

    // A wake that woke nobody: classify whether the target is genuinely dead (no live
    // session watching its key) so the miss is a LOUD relaunch signal, not a silent 0.
    let recipient_dead: string[] | undefined;
    let warning: string | undefined;
    if (woken === 0 && fan.staged === 0) {
      try {
        const report = await reportIdleRecipients([to], { workspaceId });
        if (report.idle.length > 0) {
          recipient_dead = report.idle;
          warning =
            `coord:wake reached no live session for ${to} — it is NOT running (sessionState=ended), so the ` +
            'wake black-holes. This target needs a RELAUNCH/resume, not a wake (coord:presence → wakeable:true ' +
            'for a valid target).';
        } else {
          warning =
            `coord:wake woke nobody for ${to} (it may be live-but-paused or mid-turn). Confirm it is running ` +
            '(coord:presence) before assuming it picked up.';
        }
      } catch {
        /* fail-soft: keep woken:0 without a dead classification */
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            to,
            woken,
            ...(fan.staged > 0 ? { staged: fan.staged } : {}),
            ...(recipient_dead ? { recipient_dead } : {}),
            ...(warning ? { warning } : {}),
          }),
        },
      ],
    };
  },
});

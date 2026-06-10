/**
 * coord:declare-intent — set what this agent is currently working on.
 *
 * Upserts the caller's liveness row in harness_shared.coord_presence
 * and bumps its heartbeat. This is the explicit-declaration path; the
 * OMP hook also writes presence automatically on session_start /
 * turn_start. agent-coordination-architecture-v2 §4.2 / §4.3.
 *
 * Semantics: this declares the caller's *whole* current work state —
 * omitted `current_plan_slug` / `current_files` reset to empty. Pass
 * them if they should persist.
 *
 * `items` (claim-discipline-enforcement-2026-06-10): the declared LANE.
 * When passed with `current_plan_slug`, each P-NNN is auto-claimed
 * (plan_item_claims lease) and the caller's other claims in that plan
 * are released — one call = presence + structured claims, replacing the
 * prose-lane pattern ("X holds P-001..P-005") that nothing could read.
 * Omitting `items` leaves existing claims untouched (so a bare
 * re-declare never drops a lane claimed via plans:set-status wip).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { writePresence, getPresence } from '../presence';
import { COORD_ROLES } from '../roles';
import { resolvePlanScope } from '../../plans/source';
import { reconcileDeclaredClaims } from '../../../plan-items/claim-discipline';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../../plan-items/agent-names';

export default defineTool({
  name: 'coord:declare-intent',
  description:
    'Declare what you are working on right now — a one-line intent, optionally the plan slug, the plan items you are taking (auto-claimed as your lane), and the files in scope. Other agents see this via coord:presence / fleet:assignments. Declares your whole current state; omitted fields reset (except claims — omitted `items` leaves claims untouched).',
  guidance: {
    when: 'Starting a distinct piece of work, so other agents see what you have taken on. When the work is plan items, pass them as `items` — that claims your lane structurally instead of describing it in prose.',
    notWhen: 'Every turn — the OMP hook heartbeats automatically; call this when your intent changes.',
    chaining:
      'coord:declare-intent { intent, current_plan_slug, items: ["P-001", "P-002"] } → work → plans:set-status done releases each as you finish. A reported conflict means a live peer holds that item — coordinate or re-lane.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    intent: z
      .string()
      .min(1)
      .describe('One line: what you are working on right now.'),
    current_plan_slug: z
      .string()
      .optional()
      .describe('Plan slug this work belongs to, if any.'),
    items: z
      .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
      .max(40)
      .optional()
      .describe(
        'Plan items you are taking (your LANE) — each is auto-claimed; your other claims in this plan are released. Requires current_plan_slug. Pass [] to release your whole lane in the plan. Omit to leave claims untouched.',
      ),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness the plan lives in, for the item claims (default: papercup / operator scope).'),
    current_files: z
      .array(z.string())
      .optional()
      .describe('Repo-relative files currently in scope.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (args.items && !args.current_plan_slug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'items requires current_plan_slug — the lane is claimed within one plan',
            }),
          },
        ],
        isError: true,
      };
    }
    await writePresence(identity, {
      intent: args.intent,
      currentPlanSlug: args.current_plan_slug ?? null,
      currentFiles: args.current_files ?? [],
    });

    // Reconcile the declared lane → claims (claim-discipline). Per-item
    // conflicts are reported, never thrown: declaring intent must succeed even
    // when part of the lane is contested.
    let claims = null;
    if (args.items && args.current_plan_slug) {
      const scope = await resolvePlanScope(args.harness ? { harnessSlug: args.harness } : {});
      const ownerName = await resolveAdoptedName(scope.workspaceId, identity.ownerId).catch(() => null);
      claims = await reconcileDeclaredClaims({
        workspaceId: scope.workspaceId,
        harnessSlug: scope.harnessSlug,
        planSlug: args.current_plan_slug,
        items: args.items,
        owner: identity.ownerId,
        ownerLabel: identity.ownerLabel,
        ownerName,
        ownerUser: bestEffortOwnerUser(ctx),
        intent: args.intent,
      });
    }

    const record = await getPresence(identity.ownerId);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, presence: record, ...(claims ? { claims } : {}) }),
        },
      ],
    };
  },
});

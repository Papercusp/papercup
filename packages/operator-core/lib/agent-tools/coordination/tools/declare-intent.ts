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
 *
 * Lane ids are validated against the plan's parsed items (EI-356) so the
 * claim surface agrees with plans:items / plans:set-status — see the
 * handler comment for the unknown-id semantics.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { resolveActorIdentity, actorMailboxKeys } from '../actor-identity';
import { drainAndDeliverUserMailbox } from '../messages';
import { writePresence, getPresence } from '../presence';
import { fetchPresenceFleet, type FleetMembership } from '../presence-fleet';
import { COORD_ROLES } from '../roles';
import { resolvePlanScope, getPlanRow, planItemsForRow } from '../../plans/source';
import { reconcileDeclaredClaims } from '../../../plan-items/claim-discipline';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../../plan-items/agent-names';
import { convertPlanItem } from '../../../plan-items/convert';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { withBoundedTimeout } from '../../../bounded-timeout';

/**
 * EI-9484 — "coord:declare-intent timing out repeatedly": the watchdog observed
 * the tool exceed the 60s MCP tool timeout on ~2% of calls under fleet load
 * ("handler returned but signal had aborted"). The declaration itself is one
 * upsert (`writePresence`), but the handler then AWAITS several best-effort
 * ENRICHMENT legs in the critical request path:
 *   • the `@user:` mailbox drain — a drain query + a SERIAL `appendLine` loop
 *     whose cost scales with the returning member's parked-message count,
 *   • the `getPresence` re-read and `fetchPresenceFleet` label lookup that only
 *     shape the RETURN payload.
 * Under event-loop / DB-pool saturation any one of these can stall, and because
 * they are un-bounded they hold the whole call past the 60s timeout even though
 * the essential presence write already succeeded. Bounding each enrichment leg
 * (the WI-3818 `withBoundedTimeout` pattern already used in coord:orient /
 * fleet:status) caps the blast radius of a slow leg to its own budget: the
 * declaration still lands, the enrichment degrades to a fallback. The mailbox
 * drain is claim-once, so a skipped drain is simply redelivered on the next
 * declare-intent / inbox read — degrading it changes nothing.
 */
const DECLARE_INTENT_LEG_TIMEOUT_MS = 8_000;

/**
 * EI-5873 — "broad AUTO directives cause fleet over-coverage": observed twice
 * in one session, multiple fleet members each independently declared
 * "working ALL remaining items" in free-text `intent` (no structured `items`)
 * and raced for the same set. The structural claim path (`items` + P-NNN)
 * already prevents a double-EDIT via `reconcileDeclaredClaims`'s conflict
 * check — the gap is double-INTENT: a broad prose declaration that never
 * enumerates items bypasses that check entirely, so two agents can each
 * believe they own "everything" with no structural signal either sees.
 *
 * This is a CHEAP, PURELY-ADVISORY nudge (never blocks or alters behavior):
 * when `intent` reads like a broad "take everything remaining" scope AND no
 * structured `items` were declared alongside it, surface a hint recommending
 * the caller enumerate its lane instead — so the next declare-intent naturally
 * produces the conflict signal this class of collision needs. False positives
 * cost nothing (the caller still declared successfully); false negatives just
 * mean the pattern wasn't broad-sounding enough to catch, same as today.
 */
const BROAD_INTENT_RE =
  /\ball\b[\s\S]{0,40}\b(remaining|items?|work|todos?|the\s+backlog|left)\b|\beverything\b|\bwhatever'?s?\s+left\b/i;

function broadIntentHint(intent: string, hasStructuredItems: boolean): string | null {
  if (hasStructuredItems) return null;
  if (!BROAD_INTENT_RE.test(intent)) return null;
  return (
    'EI-5873: this reads like a broad "take everything remaining" intent with no structured `items` — ' +
    'a peer declaring the same broad scope has no structural signal to see the overlap (the claim check ' +
    'only runs on declared `items`). If this work has enumerable plan items (P-NNN) or work-items, pass ' +
    'them as `items` (or claim the specific ones via work_items:claim / scheduler:get_next) so a colliding ' +
    'peer sees a real conflict instead of both of you discovering it after the fact.'
  );
}

export default defineTool({
  name: 'coord:declare-intent',
  description:
    'Declare what you are working on right now — a one-line intent, optionally the plan slug, the plan items you are taking (auto-claimed as your lane), and the files in scope. Other agents see this via coord:presence / fleet:assignments. Declares your whole current state; omitted fields reset (except claims — omitted `items` leaves claims untouched). A broad "all remaining items" intent declared with no structured `items` gets an advisory `overCoverageHint` back (EI-5873) — a peer declaring the same broad scope has no structural signal to catch the overlap otherwise.',
  guidance: {
    when: 'Starting a distinct piece of work, so other agents see what you have taken on. When the work is plan items, pass them as `items` — that claims your lane structurally instead of describing it in prose. Especially for a broad "take everything remaining" directive: enumerate the items so a colliding peer sees a real conflict instead of two agents each independently claiming to own the whole set (EI-5873).',
    notWhen: 'Every turn — the OMP hook heartbeats automatically; call this when your intent changes.',
    chaining:
      'coord:declare-intent { intent, current_plan_slug, items: ["P-001", "P-002"] } → work → plans:set-status done releases each as you finish. A reported conflict means a live peer holds that item — coordinate or re-lane. Items in `claims.unknown` did not parse as plan items and were NOT claimed — fix the plan format or the ids.',
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
    await writePresence(
      identity,
      {
        intent: args.intent,
        currentPlanSlug: args.current_plan_slug ?? null,
        currentFiles: args.current_files ?? [],
      },
      // harness the work is in → resolves the agent's home hive_slug (D-004).
      args.harness ?? null,
    );

    // Offline-member mailbox (shared-hive-collaboration P-016): declaring intent is
    // the explicit ARRIVAL signal (the OMP hook calls it at session start), so a
    // returning member's parked `@user:` assignments are delivered into their inbox
    // here — surfacing in their [coord+N] injection right away. claim-once makes
    // this a safe no-op alongside the coord:inbox-read hook. Best-effort.
    //
    // EI-9484: BOUNDED — this drains a `@user:` mailbox via a SERIAL `appendLine`
    // loop whose cost scales with the parked-message count, so a large mailbox
    // (or DB-pool starvation under fleet load) could stall it past the 60s MCP
    // tool timeout and abort the whole call. Bounded so a slow drain degrades to
    // a no-op instead; claim-once means the un-drained batch is redelivered on
    // the next declare-intent / inbox read. withBoundedTimeout never throws.
    await withBoundedTimeout<void>(
      resolveActorIdentity(ctx).then(async (actor) => {
        await drainAndDeliverUserMailbox(actorMailboxKeys(actor), actor.ownerId);
      }),
      { fallback: undefined, timeoutMs: DECLARE_INTENT_LEG_TIMEOUT_MS, label: 'declare-intent:mailbox-drain' },
    );

    // Reconcile the declared lane → claims (claim-discipline). Per-item
    // conflicts are reported, never thrown: declaring intent must succeed even
    // when part of the lane is contested.
    //
    // EI-356: the lane is validated against the SAME parsed-item set that
    // plans:items / plans:set-status see (planItemsForRow) — an id those
    // surfaces reject with item_not_found is never claimed here either.
    // Unknown ids come back in `claims.unknown` with `hint`; a lane that is
    // ENTIRELY unknown (or a missing plan) skips reconcile so a typo'd
    // declaration can't release the caller's real claims. An explicit `[]`
    // still releases the whole lane.
    let claims = null;
    if (args.items && args.current_plan_slug) {
      const scope = await resolvePlanScope(args.harness ? { harnessSlug: args.harness } : {});
      const scopeOpts = args.harness ? { harnessSlug: args.harness } : {};
      const row = await getPlanRow(args.current_plan_slug, scopeOpts);
      const knownIds = row ? new Set(planItemsForRow(row).map((i) => i.id)) : new Set<string>();
      const known = args.items.filter((i) => knownIds.has(i));
      const unknown = args.items.filter((i) => !knownIds.has(i));
      if (args.items.length > 0 && known.length === 0) {
        claims = {
          claimed: [],
          alreadyHeld: [],
          conflicts: [],
          released: [],
          unknown,
          hint: row
            ? 'none of the declared items parse as items of this plan (plans:items would not list them — legacy/checkbox lines are invisible); nothing was claimed or released. Fix the plan format (plans:lint) or declare real P-NNN ids.'
            : `plan '${args.current_plan_slug}' not found in ${scope.harnessSlug} — nothing was claimed or released. Check the slug (plans:list) or pass the right harness.`,
        };
      } else {
        const ownerName = await resolveAdoptedName(scope.workspaceId, identity.ownerId).catch(() => null);
        const reconciled = await reconcileDeclaredClaims({
          workspaceId: scope.workspaceId,
          harnessSlug: scope.harnessSlug,
          planSlug: args.current_plan_slug,
          items: known,
          owner: identity.ownerId,
          ownerLabel: identity.ownerLabel,
          ownerName,
          ownerUser: bestEffortOwnerUser(ctx),
          intent: args.intent,
        });

        // work-queue-completeness Phase A (ENFORCEMENT): when the auto-convert flag is ON,
        // each item the caller now HOLDS (just-claimed or already-held) gets a tracked
        // work_item via convertPlanItem — so an auto-claimed declare-intent lane never
        // leaves untracked work. Idempotent (resumes an existing record), so re-declaring
        // is a harmless no-op. BEST-EFFORT: wrapped per-item AND as a whole so a convert
        // failure (or a flag-IO error) NEVER breaks declare-intent — the lane stays
        // claimed regardless. Fail-safe to OFF on a flag-read error.
        const autoConvert = await getFlag(FLAGS.PLAN_ITEM_CLAIM_AUTO_CONVERT, 'system').catch(() => false);
        if (autoConvert) {
          const held = [...reconciled.claimed, ...reconciled.alreadyHeld];
          for (const itemId of held) {
            await convertPlanItem({
              workspaceId: scope.workspaceId,
              harnessSlug: scope.harnessSlug,
              planSlug: args.current_plan_slug,
              itemId,
              owner: identity.ownerId,
              ownerLabel: identity.ownerLabel,
              ownerName,
              ownerUser: bestEffortOwnerUser(ctx),
              intent: args.intent,
            }).catch((e) =>
              console.warn(
                `[coord:declare-intent] auto-convert ${args.current_plan_slug}#${itemId} failed:`,
                (e as Error)?.message ?? e,
              ),
            );
          }
        }

        claims =
          unknown.length > 0
            ? {
                ...reconciled,
                unknown,
                hint: 'unknown items do not parse as items of this plan (plans:set-status would return item_not_found) and were not claimed — fix the plan format or the ids.',
              }
            : reconciled;
      }
    }

    // EI-9484: these two reads only shape the RETURN payload (the declaration
    // already landed via writePresence). Bound each so a slow read under load
    // degrades the echoed-back presence/fleet label instead of holding the whole
    // call past the 60s MCP tool timeout.
    const record = (
      await withBoundedTimeout(getPresence(identity.ownerId), {
        fallback: null,
        timeoutMs: DECLARE_INTENT_LEG_TIMEOUT_MS,
        label: 'declare-intent:getPresence',
      })
    ).value;
    // Surface the agent's named-fleet membership (P-005) alongside its presence row —
    // fleet_slug/fleet_role are a SOFT coord_presence label that does NOT ride the base
    // PresenceRecord, so join the STORED value (reflects a leader role a handoff may have
    // promoted this row to, not just the launch env). Absent ⇒ no fleet.
    const fleet = record
      ? (
          await withBoundedTimeout(fetchPresenceFleet([identity.ownerId]), {
            fallback: new Map<string, FleetMembership>(),
            timeoutMs: DECLARE_INTENT_LEG_TIMEOUT_MS,
            label: 'declare-intent:fetchPresenceFleet',
          })
        ).value.get(identity.ownerId)
      : undefined;
    const presence = record
      ? { ...record, fleetSlug: fleet?.fleetSlug ?? null, fleetRole: fleet?.fleetRole ?? null }
      : record;
    const overCoverageHint = broadIntentHint(args.intent, !!(args.items && args.items.length > 0));
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            presence,
            ...(claims ? { claims } : {}),
            ...(overCoverageHint ? { overCoverageHint } : {}),
          }),
        },
      ],
    };
  },
});

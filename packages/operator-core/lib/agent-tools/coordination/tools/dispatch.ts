/**
 * coord:dispatch — the ONE primitive a coordinator/Queen uses to hand a lane to a
 * peer (fleet-dispatch-wake-clarity-2026-06-22 P-002 / D-002).
 *
 * Before this, dispatching meant hand-composing THREE steps in the right order:
 *   1. plan_items:assign  (claim the lane for the target — the durable intent)
 *   2. coord:send         (deliver the directed note to its inbox)
 *   3. events:emit coord:inbox-wake:<id>  (re-invoke the sleeping target NOW)
 * …and then reverse-engineering the `coord:inbox-wake:<id>` key format and reading
 * `wakeable` to know whether the wake could even land. D-002: that whole
 * reverse-engineering step is the bug. coord:dispatch collapses it into one call:
 *
 *   assign the lane  +  deliver+wake the note  +  report queued delivery ({ queued, pickupConfirmed, delivered })
 *
 * and FLAGS the target's sessionState so a dispatch to an `ended` (not-wakeable)
 * session is a LOUD miss (the lane is still assigned durably, but no live process
 * will pick it up until it is relaunched — never a silent woken:0).
 *
 * COMPOSITION (the in-process re-dispatch pattern, like coord:orient): each sub-step
 * routes through the SAME dispatcher every MCP tools/call uses (gates + telemetry +
 * audit), so dispatch is just another caller of coord:presence / plan_items:assign /
 * coord:send — it builds NO second wake pump (it reuses coord:send's deliver-and-wake,
 * which already owns the recipient_absent/recipient_dead honesty signal). The pure
 * `composeDispatch(args, call)` is unit-tested with a mock `call`.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import { inProcessCall, type InnerCall } from '../../_compound-dispatch';
import { hardText } from '../../limits';
import type { HydratableRef } from '../ref-hydrate';
import { renderHydratedRefs } from '../ref-hydrate';
import { hydrateRefs, makePlanItemResolver } from '../ref-hydrate-resolve';

export interface DispatchArgs {
  to: string;
  note: string;
  planSlug?: string;
  items?: string[];
  body?: string;
  harness?: string;
}

/** The lane-assignment leg's outcome (plan_items:assign envelope, distilled). */
export interface DispatchAssigned {
  planSlug: string;
  items: string[];
  /** True only when every requested item was assigned successfully. */
  ok: boolean;
  /** Number of items sent to the assignment leg. */
  requested: number;
  /** Number of per-item assignment results that succeeded. */
  assigned: number;
  /** Number of per-item assignment results that were refused or errored. */
  failed: number;
  /** A real partial assignment: at least one item landed and at least one did not. */
  partial: boolean;
  /** Per-item assign results (assignment | refused | error) when the call ran. */
  results?: unknown[];
  /** Set when the whole assign leg threw (the lane was NOT assigned). */
  error?: string;
}

/** EI-2292: an item the pre-assign guard excluded from this dispatch's lane —
 *  either it is live-claimed by someone OTHER than the target (a re-dispatch
 *  would collide with an in-flight peer instead of pooling), or it is flagged
 *  needs-human/blocked (owner-gated — a dispatcher pushing it is exactly the
 *  "wakes/spams multiple sessions on parked work" pattern this guards against). */
export interface DispatchSkippedItem {
  item: string;
  reason: string;
}

export interface DispatchResult {
  ok: boolean;
  /** The RESOLVED target ownerId (coord:send resolves a short handle/prefix). */
  to: string;
  /** The target's session state at dispatch time (P-001): live | parked | ended |
   *  recorded | null (federated/unknown row, or the presence read degraded). An
   *  `ended` target is NOT wakeable — see `warning`. */
  sessionState: string | null;
  /** A live inbox-wake await exists → the wake can land (null = couldn't derive). */
  wakeable: boolean | null;
  /** The durable lane assignment outcome (null when no planSlug+items were given —
   *  a pure directed wake). */
  assigned: DispatchAssigned | null;
  /** The directed note's inbox msg_id (the "delivered" half). */
  delivered: string | null;
  /** WI-4165: count of assigned plan-items whose body was successfully
   *  inlined into the delivered note (deref-at-delivery, ref-hydrate.ts) —
   *  so the receiver reads what to do without re-fetching the plan. 0/absent
   *  when no items were assigned or none resolved. */
  itemsHydrated?: number;
  /** Execution-confirmed turn pickups. The current wake substrate does not provide that handshake, so this stays 0. */
  woken: number;
  /** Durable wake deliveries matched/queued. Queueing is not proof a turn executed. */
  queued?: number;
  /** False until a later checkpoint/activity observation proves the target took a turn. */
  pickupConfirmed?: boolean;
  /** EI-5957: >0 when the wake STAGED (target in MANUAL wake-mode — the hive
   *  pause/edit gate) instead of delivering. The lane is assigned durably but the
   *  directed note was queued for owner review, NOT delivered — see `warning`. */
  staged?: number;
  /** A REQUIRED wake that reached a live target but woke nobody (paused/just-ended). */
  recipient_absent?: boolean;
  /** The subset of targets with NO live session watching their inbox-wake key —
   *  genuinely dead; the dispatch black-holes until they are relaunched. */
  recipient_dead?: string[];
  /** EI-2292: requested items the pre-assign guard excluded (live-claimed by
   *  someone else, or needs-human/blocked) — present only when non-empty. The
   *  note still delivers (it may legitimately be about other, kept items), but
   *  these were NOT added to the target's durable lane, so re-dispatching a
   *  parked/claimed item every cycle no longer collides or spams. */
  skippedItems?: DispatchSkippedItem[];
  /** A loud, human-readable miss note when the target is not pickup-able right now. */
  warning?: string;
}

/** Find the roster row for `to` in a coord:presence snapshot (exact ownerId, else a
 *  best-effort handle/prefix/suffix match — the same fuzziness coord:send resolves). */
function findPresenceRow(
  snapshot: unknown,
  to: string,
): { ownerId: string; sessionState: string | null; wakeable: boolean | null } | null {
  const snap = snapshot as { active?: Record<string, unknown>[]; stale?: Record<string, unknown>[] } | undefined;
  const rows = [...(snap?.active ?? []), ...(snap?.stale ?? [])];
  const idOf = (r: Record<string, unknown>) => (typeof r.ownerId === 'string' ? r.ownerId : '');
  const exact = rows.find((r) => idOf(r) === to);
  const fuzzy =
    exact ?? rows.find((r) => idOf(r) && (idOf(r).includes(to) || to.includes(idOf(r))));
  if (!fuzzy) return null;
  return {
    ownerId: idOf(fuzzy),
    sessionState: (fuzzy.sessionState as string | null | undefined) ?? null,
    wakeable: (fuzzy.wakeable as boolean | null | undefined) ?? null,
  };
}

/**
 * PURE composition over an injected `call` (run SEQUENTIALLY so the sub-reads never
 * contend on the caller's single ctx connection). Order: presence (pre-state) →
 * assign lane (durable, best-effort) → deliver+wake (the critical path). The
 * presence + assign legs are BEST-EFFORT (a failure degrades a field, never the
 * dispatch); the coord:send leg is the one that must run.
 */
export interface ComposeDispatchDeps {
  /** Injectable for tests (default: the real hydrateRefs — DB-backed, fail-soft). */
  hydrateRefs?: typeof hydrateRefs;
}

export async function composeDispatch(
  args: DispatchArgs,
  call: InnerCall,
  deps: ComposeDispatchDeps = {},
): Promise<DispatchResult> {
  const hydrate = deps.hydrateRefs ?? hydrateRefs;
  // 1. Pre-state: the target's wakeability (P-001). Best-effort — a presence read
  //    hiccup degrades sessionState/wakeable to null but never blocks the dispatch.
  let sessionState: string | null = null;
  let wakeable: boolean | null = null;
  let presenceOwnerId: string | null = null;
  try {
    // Targeted `owner` lookup: the default roster now omits `ended` rows, but a
    // dispatch target may well be dead — pass `owner` so an `ended`/parked target is
    // still resolved (for the wakeable/recipient_dead pre-state) instead of missed.
    const snapshot = await call('coord:presence', { scope: 'workspace', owner: args.to });
    const row = findPresenceRow(snapshot, args.to);
    if (row) {
      sessionState = row.sessionState;
      wakeable = row.wakeable;
      presenceOwnerId = row.ownerId || null;
    }
  } catch {
    /* degrade: sessionState/wakeable stay null */
  }

  // 1.5. EI-2292 pre-assign guard: a naive re-dispatch cycle (the su-aede8
  //      incident) re-assigned the SAME plan items every wake with no check for
  //      an existing live claim or an owner-gated park, pushing fresh agents
  //      into head-on collisions on items another peer had deliberately parked
  //      (needs-human) or was actively holding. Read the plan's merged
  //      assignment+claim view ONCE and drop any requested item that is (a)
  //      live-claimed by someone OTHER than this dispatch's target, or (b)
  //      flagged needs-human/blocked — before it ever reaches plan_items:assign.
  //      BEST-EFFORT + fail-open: a status-read hiccup degrades to "no guard"
  //      (today's unfiltered behavior) rather than blocking the dispatch.
  const skippedItems: DispatchSkippedItem[] = [];
  let itemsToAssign = args.items;
  if (args.planSlug && args.items && args.items.length > 0) {
    try {
      const statusEnv = (await call('plan_items:status', {
        plan: args.planSlug,
        ...(args.harness ? { harness: args.harness } : {}),
      })) as {
        items?: Array<{
          itemId: string;
          itemStatus: string | null;
          claim: { owner?: string; ownerName?: string | null } | null;
        }>;
      } | undefined;
      const byId = new Map((statusEnv?.items ?? []).map((it) => [it.itemId, it]));
      const targetOwnerId = presenceOwnerId || args.to;
      const kept: string[] = [];
      for (const item of args.items) {
        const st = byId.get(item);
        if (st?.itemStatus === 'needs-human' || st?.itemStatus === 'blocked') {
          skippedItems.push({ item, reason: `item is ${st.itemStatus} (owner-gated) — not re-assigned` });
          continue;
        }
        if (st?.claim?.owner && st.claim.owner !== targetOwnerId) {
          skippedItems.push({
            item,
            reason: `live-claimed by ${st.claim.ownerName ?? st.claim.owner} — not re-assigned to avoid a collision`,
          });
          continue;
        }
        kept.push(item);
      }
      itemsToAssign = kept;
    } catch {
      /* fail-open: guard degrades, assign proceeds unfiltered (today's behavior) */
    }
  }

  // 2. Assign the lane (durable intent) — only for items that survived the guard.
  //    BEST-EFFORT: a cross-user refusal / bad item must not swallow the wake (the
  //    lane assignment is the backstop; the directed note+wake is what gets pickup).
  let assigned: DispatchAssigned | null = null;
  if (args.planSlug && itemsToAssign && itemsToAssign.length > 0) {
    try {
      const env = (await call('plan_items:assign', {
        plan: args.planSlug,
        itemIds: itemsToAssign,
        assignee: args.to,
        ...(args.harness ? { harness: args.harness } : {}),
      })) as {
        ok?: boolean;
        results?: unknown[];
        counts?: { ok?: number; failed?: number };
      } | undefined;
      const requested = itemsToAssign.length;
      const results = Array.isArray(env?.results) ? env.results : [];
      const resultAssigned = results.filter(
        (result) =>
          typeof result === 'object' &&
          result !== null &&
          (result as { ok?: unknown }).ok === true,
      ).length;
      const resultFailed = results.length - resultAssigned;
      // plan_items:assign uses the shared bulk contract: its top-level ok means
      // only that the batch ran. The per-item counts are the assignment truth.
      // Keep a result-derived fallback for older/partial envelopes so dispatch
      // never reconstructs success from the execution-level `ok` alone.
      const assignedCount =
        typeof env?.counts?.ok === 'number' ? env.counts.ok : resultAssigned;
      const failedCount =
        typeof env?.counts?.failed === 'number'
          ? env.counts.failed
          : resultFailed + Math.max(requested - results.length, 0);
      const allAssigned = assignedCount === requested && failedCount === 0;
      assigned = {
        planSlug: args.planSlug,
        items: itemsToAssign,
        ok: env?.ok === true && allAssigned,
        requested,
        assigned: assignedCount,
        failed: failedCount,
        partial: assignedCount > 0 && failedCount > 0,
        ...(results.length > 0 ? { results } : {}),
      };
    } catch (e) {
      assigned = {
        planSlug: args.planSlug,
        items: itemsToAssign,
        requested: itemsToAssign.length,
        assigned: 0,
        failed: itemsToAssign.length,
        partial: false,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // 2b. WI-4165: deref-at-delivery for the assigned lane itself — inline each
  //     assigned plan-item's own body into the delivered note (ref-hydrate.ts,
  //     coord-authority-hardening-2026-07-11 P-001) so the receiver reads WHAT
  //     to do without re-fetching the plan. Budget-bounded (DEFAULT_REF_BUDGET:
  //     ~200 chars/item, ≤3 items) and fail-soft BY CONTRACT — a resolve hiccup
  //     degrades to the plain note, never blocks delivery (the critical leg is
  //     coord:send below, unaffected either way).
  let hydratedBody = args.body;
  let itemsHydrated = 0;
  if (args.planSlug && itemsToAssign && itemsToAssign.length > 0) {
    try {
      const refs: HydratableRef[] = itemsToAssign.map((item) => ({
        kind: 'plan-item' as const,
        slug: args.planSlug as string,
        item,
      }));
      const hydrated = await hydrate(refs, {
        resolvers: { 'plan-item': makePlanItemResolver(args.harness) },
      });
      itemsHydrated = hydrated.filter((h) => h.ok).length;
      const block = renderHydratedRefs(hydrated);
      if (block) hydratedBody = [args.body, block].filter(Boolean).join('\n\n');
    } catch {
      /* fail-soft: dispatch still delivers the plain note */
    }
  }

  // 3. Deliver the directed note AND wake the target NOW (coord:send wake:'required').
  //    This is the critical leg: it persists the inbox row (durable) AND fires the
  //    target's own coord:inbox-wake key, returning the authoritative queued-delivery
  //    signal (queued / recipient_absent / recipient_dead). It does not confirm a turn.
  const sendEnv = (await call('coord:send', {
    to: [args.to],
    summary: args.note,
    // The structured-body gate refuses a plain string, and expects:'action' below makes a
    // body mandatory — so dispatch always sends one. `forYouBecause` is satisfiable here in
    // the strongest possible way: dispatch is a targeted hand-off, so the recipient IS the
    // assignee, and that is a structural relation rather than a note we have to invent.
    body: [
      {
        text: hydratedBody || args.note,
        forYouBecause: {
          relation: 'owns' as const,
          ...(args.planSlug ? { ref: args.planSlug } : {}),
          note: 'dispatched to you — this work is yours to carry from here',
        },
      },
    ],
    ...(args.planSlug ? { plan_slug: args.planSlug } : {}),
    wake: 'required',
    // D-048: `expects` is required and never defaulted. Dispatch hands the target WORK
    // and wakes it to start now, so the expectation is 'action' — not 'ack' (we are not
    // asking it to confirm receipt; pickup must be verified separately) and never
    // 'none' (a dispatch nobody is obliged to act on is not a dispatch).
    expects: 'action',
  })) as { results?: Array<Record<string, unknown>> } | undefined;

  const r0 = (sendEnv?.results?.[0] ?? {}) as {
    ok?: boolean;
    to?: string[];
    msg_id?: string;
    wake?: {
      queued?: number;
      woken?: number;
      staged?: number;
      recipient_absent?: boolean;
      recipient_dead?: string[];
      note?: string;
    };
    error?: string;
  };
  // coord:send resolves a short handle/prefix to the full ownerId — prefer that as
  // the authoritative resolved target; fall back to the presence row, then the input.
  const resolvedTo =
    (Array.isArray(r0.to) ? r0.to.find((t) => t !== '*' && t !== 'human') : undefined) ||
    presenceOwnerId ||
    args.to;

  const wake = r0.wake ?? {};
  // coord:send's wake.queued is the event engine's matched/queued count; the
  // detached wake pump has not yet proved that the target executed a turn. The
  // woken fallback keeps dispatch compatible with older coord:send responses.
  const queued = typeof wake.queued === 'number' ? wake.queued : typeof wake.woken === 'number' ? wake.woken : 0;
  const woken = 0;
  // EI-5957: a wake STAGES (never delivers) when the target is in MANUAL wake-mode.
  const staged = typeof wake.staged === 'number' ? wake.staged : 0;

  // `plan_items:assign` is a bulk endpoint whose execution envelope is `ok:true`
  // even when every per-item assignment was refused. A dispatch that delivered a
  // note and woke the target still needs to report that no lane landed: the wake
  // evidence remains authoritative, but the dispatch disposition must not read as
  // a successful assignment.
  const allRequestedAssignmentsFailed =
    assigned !== null &&
    assigned.requested > 0 &&
    assigned.assigned === 0 &&
    assigned.failed === assigned.requested;

  const result: DispatchResult = {
    ok: r0.ok !== false && !allRequestedAssignmentsFailed,
    to: resolvedTo,
    sessionState,
    wakeable,
    assigned,
    delivered: typeof r0.msg_id === 'string' ? r0.msg_id : null,
    woken,
    queued,
    pickupConfirmed: false,
    ...(itemsHydrated > 0 ? { itemsHydrated } : {}),
    ...(staged > 0 ? { staged } : {}),
    ...(wake.recipient_absent ? { recipient_absent: true } : {}),
    ...(Array.isArray(wake.recipient_dead) && wake.recipient_dead.length > 0
      ? { recipient_dead: wake.recipient_dead }
      : {}),
    ...(skippedItems.length > 0 ? { skippedItems } : {}),
  };

  // 3b. EI-2292: surface the guard's own skips as a loud warning too (in addition to
  //     the structured `skippedItems` field) — don't silently let a caller miss that
  //     some of its requested items were NOT added to the lane. Composed with (never
  //     overwriting) the dead/absent/staged warnings below, which take priority when
  //     the target itself is unreachable.
  if (skippedItems.length > 0 && !result.warning) {
    result.warning =
      `coord:dispatch skipped ${skippedItems.length} of ${args.items?.length ?? 0} requested item(s) ` +
      `(not added to ${resolvedTo}'s lane): ${skippedItems.map((s) => `${s.item} (${s.reason})`).join('; ')}`;
  }

  if (allRequestedAssignmentsFailed && !result.warning) {
    result.warning =
      `coord:dispatch assigned 0 of ${assigned?.requested ?? 0} requested item(s) to ${resolvedTo}` +
      ` (${assigned?.failed ?? 0} refused or errored); the note and wake still landed, but ` +
      'the target has no durable lane from this dispatch.';
  }

  // 4. The loud miss (D-002 / the #1 confusion this plan fixes): a dispatch to a
  //    non-pickup-able target. `ended` sessionState OR a recipient_dead/absent wake
  //    means the lane was assigned durably but NO live process will pick it up until
  //    the target is relaunched/resumed — surface it instead of a silent woken:0.
  const dead = Array.isArray(wake.recipient_dead) ? wake.recipient_dead : [];
  if (sessionState === 'ended' || sessionState === 'suspect' || sessionState === 'draining' || dead.length > 0) {
    result.warning =
      `coord:dispatch reached no LIVE session for ${resolvedTo} (sessionState=${sessionState ?? 'unknown'})` +
      `${assigned?.ok ? ' — the lane was assigned durably (survives), but' : ' —'} the wake landed nowhere: ` +
      'this target needs claim/session reconciliation and then a RELAUNCH/resume, not a wake. Re-dispatch to a `parked`/`live` agent ' +
      '(coord:presence → wakeable:true) or respawn this one.';
  } else if (staged > 0 && queued === 0) {
    // EI-5957: the target is ALIVE but in MANUAL wake-mode, so the directed note
    // STAGED for owner review instead of delivering — the #1 leader-steering trap
    // (a quiet staged:1 read as delivered while the member ran off-mandate). The
    // lane is assigned durably; the wake just needs releasing or the target on auto.
    result.warning =
      `coord:dispatch STAGED (did NOT deliver) to ${resolvedTo}: it is in MANUAL wake-mode (the hive ` +
      `pause/edit gate), so the note was queued for owner review, not delivered` +
      `${assigned?.ok ? ' (the lane was still assigned durably)' : ''} — the target will NOT pick up ` +
      `this directive until the staged wake is RELEASED (coord:wake-queue { action: "release_all", agent: "${resolvedTo}" }) ` +
      `or it is flipped to auto (coord:wake-mode { agent: "${resolvedTo}", mode: "auto" }). A fleet leader ` +
      'steering its own members almost always wants them on auto.';
  } else if (wake.recipient_absent && queued === 0) {
    result.warning =
      `coord:dispatch woke nobody for ${resolvedTo} (it is live-but-paused or just ended its turn) — the ` +
      'note was injected to its inbox and the lane assigned, but confirm pickup (coord:presence) before ' +
      'assuming it is being worked.';
  } else if (queued > 0) {
    const pickupWarning =
      `coord:dispatch queued ${queued} durable wake delivery for ${resolvedTo}, but pickup is NOT confirmed — ` +
      'verify a fresh work-item checkpoint or activity timestamp before treating the assigned lane as active.';
    result.warning = result.warning ? `${result.warning} ${pickupWarning}` : pickupWarning;
  }

  return result;
}

export default defineTool({
  name: 'coord:dispatch',
  description:
    'One call assigns plan items to `to`, inlines their bodies, delivers `note`, queues a wake, and reports ({ assigned, queued, pickupConfirmed:false, delivered, sessionState, itemsHydrated }). Queueing is not proof a turn executed: verify a fresh checkpoint/activity timestamp. All-refused assignment is `ok:false`; ended/dead targets are loud misses requiring relaunch.',
  guidance: {
    when: 'You are a coordinator/Mug handing a specific lane to ANOTHER agent and want it picked up NOW — "su-7a2a, take fleet-dispatch P-001..P-004". One call assigns + delivers + queues a wake; verify pickup separately. Target a `parked` agent (coord:presence → sessionState:parked is the ideal); a `live` agent already running sees the note mid-turn.',
    notWhen: 'Just sharing context / asking a question (coord:send). Claiming work for YOURSELF (plan_items:claim). A broadcast — dispatch is single-target, never "*". The target is `ended` — a wake cannot land on it; bring it back with capability:launch-agent { resume: { agentId } }, then dispatch.',
    chaining:
      'coord:presence (find a `parked`/wakeable target) → coord:dispatch { to, planSlug, items, note } → check `assigned` plus `queued`/`warning`, then verify pickup from a fresh checkpoint/activity timestamp. An all-refused lane is `ok:false` even when the note/wake queued.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // Composite marker (tool-call-batching-wrappers P-010): the primitives this bundles.
  replaces: ['coord:presence', 'plan_items:assign', 'coord:send', 'events:emit'],
  args: z.object({
    to: z
      .string()
      .min(1)
      .describe('The target agent — its ownerId or the short handle from [coord+N]/coord:presence. Single-target only (never "*").'),
    note: z
      .string()
      .min(1)
      .describe('The directed instruction the target reads in its inbox on waking — what to pick up and do. Name the plan + items explicitly.'),
    planSlug: z.string().max(120).optional().describe('Plan slug whose items form the lane to assign (with `items`).'),
    items: z
      .array(z.string().max(20))
      .max(40)
      .optional()
      .describe('Plan-item ids (P-NNN) to push-assign to `to` as its durable lane. Omit for a pure directed wake.'),
    body: hardText(8000).optional().describe('Optional longer body for the inbox note.'),
    harness: z.string().max(120).optional().describe('Harness scope for the lane assignment (default: the plan\'s harness).'),
  }),
  async handler(args, ctx) {
    const result = await composeDispatch(args as DispatchArgs, inProcessCall(ctx));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});

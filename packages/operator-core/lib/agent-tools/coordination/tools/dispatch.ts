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
 *   assign the lane  +  deliver+wake the note  +  report pickup ({ woken, delivered })
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
  ok: boolean;
  /** Per-item assign results (assignment | refused | error) when the call ran. */
  results?: unknown[];
  /** Set when the whole assign leg threw (the lane was NOT assigned). */
  error?: string;
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
  /** How many of the target's wake awaits actually fired (0 = nobody was listening). */
  woken: number;
  /** EI-5957: >0 when the wake STAGED (target in MANUAL wake-mode — the hive
   *  pause/edit gate) instead of delivering. The lane is assigned durably but the
   *  directed note was queued for owner review, NOT delivered — see `warning`. */
  staged?: number;
  /** A REQUIRED wake that reached a live target but woke nobody (paused/just-ended). */
  recipient_absent?: boolean;
  /** The subset of targets with NO live session watching their inbox-wake key —
   *  genuinely dead; the dispatch black-holes until they are relaunched. */
  recipient_dead?: string[];
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
export async function composeDispatch(args: DispatchArgs, call: InnerCall): Promise<DispatchResult> {
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

  // 2. Assign the lane (durable intent) — only when planSlug + items are given.
  //    BEST-EFFORT: a cross-user refusal / bad item must not swallow the wake (the
  //    lane assignment is the backstop; the directed note+wake is what gets pickup).
  let assigned: DispatchAssigned | null = null;
  if (args.planSlug && args.items && args.items.length > 0) {
    try {
      const env = (await call('plan_items:assign', {
        plan: args.planSlug,
        itemIds: args.items,
        assignee: args.to,
        ...(args.harness ? { harness: args.harness } : {}),
      })) as { ok?: boolean; results?: unknown[] } | undefined;
      assigned = {
        planSlug: args.planSlug,
        items: args.items,
        ok: env?.ok === true,
        ...(Array.isArray(env?.results) ? { results: env!.results } : {}),
      };
    } catch (e) {
      assigned = {
        planSlug: args.planSlug,
        items: args.items,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // 3. Deliver the directed note AND wake the target NOW (coord:send wake:'required').
  //    This is the critical leg: it persists the inbox row (durable) AND fires the
  //    target's own coord:inbox-wake key, returning the authoritative pickup signal
  //    (woken / recipient_absent / recipient_dead). We do NOT re-implement any of it.
  const sendEnv = (await call('coord:send', {
    to: [args.to],
    summary: args.note,
    ...(args.body ? { body: args.body } : {}),
    ...(args.planSlug ? { plan_slug: args.planSlug } : {}),
    wake: 'required',
  })) as { results?: Array<Record<string, unknown>> } | undefined;

  const r0 = (sendEnv?.results?.[0] ?? {}) as {
    ok?: boolean;
    to?: string[];
    msg_id?: string;
    wake?: {
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
  const woken = typeof wake.woken === 'number' ? wake.woken : 0;
  // EI-5957: a wake STAGES (never delivers) when the target is in MANUAL wake-mode.
  const staged = typeof wake.staged === 'number' ? wake.staged : 0;

  const result: DispatchResult = {
    ok: r0.ok !== false,
    to: resolvedTo,
    sessionState,
    wakeable,
    assigned,
    delivered: typeof r0.msg_id === 'string' ? r0.msg_id : null,
    woken,
    ...(staged > 0 ? { staged } : {}),
    ...(wake.recipient_absent ? { recipient_absent: true } : {}),
    ...(Array.isArray(wake.recipient_dead) && wake.recipient_dead.length > 0
      ? { recipient_dead: wake.recipient_dead }
      : {}),
  };

  // 4. The loud miss (D-002 / the #1 confusion this plan fixes): a dispatch to a
  //    non-pickup-able target. `ended` sessionState OR a recipient_dead/absent wake
  //    means the lane was assigned durably but NO live process will pick it up until
  //    the target is relaunched/resumed — surface it instead of a silent woken:0.
  const dead = Array.isArray(wake.recipient_dead) ? wake.recipient_dead : [];
  if (sessionState === 'ended' || dead.length > 0) {
    result.warning =
      `coord:dispatch reached no LIVE session for ${resolvedTo} (sessionState=${sessionState ?? 'unknown'})` +
      `${assigned?.ok ? ' — the lane was assigned durably (survives), but' : ' —'} the wake landed nowhere: ` +
      'this target needs a RELAUNCH/resume, not a wake. Re-dispatch to a `parked`/`live` agent ' +
      '(coord:presence → wakeable:true) or respawn this one.';
  } else if (staged > 0 && woken === 0) {
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
  } else if (wake.recipient_absent && woken === 0) {
    result.warning =
      `coord:dispatch woke nobody for ${resolvedTo} (it is live-but-paused or just ended its turn) — the ` +
      'note was injected to its inbox and the lane assigned, but confirm pickup (coord:presence) before ' +
      'assuming it is being worked.';
  }

  return result;
}

export default defineTool({
  name: 'coord:dispatch',
  description:
    'Hand a lane to a peer in ONE call: assign the plan items to `to` (durable lane) + deliver the `note` to its inbox + WAKE it now, then report pickup ({ woken, delivered, sessionState }). Replaces hand-composing plan_items:assign + coord:send + events:emit + the coord:inbox-wake:<id> key. FLAGS a non-wakeable target: an `ended` sessionState (or recipient_dead) means the lane was assigned but no live process will pick it up until a relaunch — a loud miss, never a silent woken:0. `planSlug`+`items` are optional (omit for a pure directed wake — "resume what I sent you").',
  guidance: {
    when: 'You are a coordinator/Mug handing a specific lane to ANOTHER agent and want it picked up NOW — "su-7a2a, take fleet-dispatch P-001..P-004". One call assigns + wakes + confirms. Target a `parked` agent (coord:presence → sessionState:parked is the ideal); a `live` agent already running sees the note mid-turn.',
    notWhen: 'Just sharing context / asking a question (coord:send). Claiming work for YOURSELF (plan_items:claim / coord:declare-intent items). A broadcast — dispatch is single-target + wake, never "*". The target is `ended` (coord:presence) — it needs a relaunch/resume, not a dispatch (the wake cannot land).',
    chaining:
      'coord:presence (find a `parked`/wakeable target) → coord:dispatch { to, planSlug, items, note } → check `woken`/`warning`. A woken target then: coord:orient → plan_items:my_items → claim + work the dispatched lane.',
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

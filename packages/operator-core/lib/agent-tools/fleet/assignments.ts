/**
 * fleet:assignments — query the canonical fleet-assignment state (state-not-chat-
 * fleet-state-2026-06-05, D-002 / P-003).
 *
 * THE state query for "who's running / what is X doing / is anyone on plan P".
 * Reads harness_shared.fleet_assignment (presence + plan-item claims/assignments +
 * work-item claims, claim-primary with holder liveness joined in) — one query, no
 * message-replay. Want to be NOTIFIED of changes instead? Subscribe the
 * 'fleet_assignment' PG NOTIFY channel (lib/fleet-assignment-bus). The coord inbox
 * is for messages addressed to you — not for deriving fleet state (D-001).
 */
import { z } from 'zod';
import { defineTool, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveSelfRef, markSelfRows } from '../coordination/self-marker';
import { COORD_ROLES } from '../coordination/roles';
import {
  fetchWakeability,
  deriveSessionState,
  isHardStale,
  type SessionState,
  type WakeabilitySignals,
} from '../coordination/presence-wakeability';
import { recordedLiveOwnerIds } from '../../adv-sessions';
import {
  groupByAgent,
  lastToolCallAtByOwner,
  listFleetAssignments,
  orphanedClaims,
  stalledClaims,
  summarizeOrphan,
  type AgentAssignment,
} from '../../fleet/assignments';
import {
  getAllWakeModeOverrides,
  getDefaultWakeMode,
  resolveWakeModeFrom,
  type WakeMode,
} from '../coordination/wake-mode';
import {
  getAllPlanItemCoverage,
  compactCoverage,
  coverageCollisions,
  type CoverageCollision,
  type PlanItemCoverage,
} from '../../plan-item-coverage';
import { listParkedAwaitsForSubscribers } from '../../events/await/store';
import { fetchContextPressure, type ContextPressureBucket } from '../coordination/context-pressure';
import { boundRowField, boundListField, trimToByteBudget } from '../_bound-output';
import { shapeFleetAssignments } from './assignments-shape';
import { getPlanRow, planItemsForRow } from '../plans/source';
import { resolveEffectiveStatusForItems } from '../plans/effective-status';
import { shapeDagFrontier, claimsFromCoverage, type DagFrontierView } from '../../fleet-dag-view';

/** Coverage levels most-covered → least, for sorting the rollup. */
const COVERAGE_ORDER = ['complete', 'full', 'partial', 'unclaimed', 'none'];

/** A 'complete' coverage entry stays in the DEFAULT rollup only while its newest
 *  linked work-item update is this recent (EI-9015). */
export const COVERAGE_ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000;

/**
 * EI-9015: the ACTIVE-scope coverage default. coord_links edges never expire, so the
 * unfiltered rollup replayed 60+ long-complete, unrelated plan entries on EVERY
 * mandated orient wake (the caller with no resolvable {agent} gets no inScope
 * narrowing at all). Default: keep everything still in motion (level !== 'complete'),
 * and keep 'complete' entries only when they are the caller's own lane
 * (`lanePlans`) or recently touched (~7d). An explicit `{plan}` query or
 * `fullCoverage:true` returns the untrimmed ledger. Pure — unit-tested directly.
 */
export function filterActiveCoverage(
  entries: PlanItemCoverage[],
  opts: {
    explicitPlan?: string | null;
    lanePlans?: Set<string> | null;
    fullCoverage?: boolean;
    now?: number;
  },
): PlanItemCoverage[] {
  if (opts.fullCoverage || opts.explicitPlan) return entries;
  const now = opts.now ?? Date.now();
  return entries.filter((c) => {
    if (c.level !== 'complete') return true;
    const hash = c.ref.indexOf('#');
    const plan = hash > 0 ? c.ref.slice(0, hash) : null;
    if (plan && opts.lanePlans?.has(plan)) return true;
    const ts = c.lastActivityAt?.getTime();
    return ts != null && now - ts <= COVERAGE_ACTIVE_WINDOW_MS;
  });
}

/**
 * EI-6077 (detector gap): `AgentAssignment.alive` is heartbeat-freshness only
 * (the `fleet_assignment` view's `holder_alive`) — EI-6374 already downgrades it
 * for a CONFIRMED-ended session (adv_sessions.ended_at set), but a session that
 * is simply not coord-wakeable — no live `coord:inbox-wake:<id>` await, e.g. it
 * never registered one — still read `alive:true` here while coord:dispatch /
 * coord:send could not actually reach it. That mismatch is exactly what left the
 * Queen unable to tell "really runnable" from "just looks alive" without a
 * separate coord:presence call (the EI's filed evidence).
 *
 * Ports the SAME reconciliation fleet:status already applies (EI-5858,
 * fleet/fleet-roster.ts `foldFleetRoster`): derive `sessionState` from
 * coord:presence's own wakeability signal (P-001) and gate `alive` on it, so the
 * two "who's running" tools agree instead of leaving callers to cross-check both.
 *
 * Exported (not inlined in the handler) so it unit-tests with an injected
 * wakeability fetcher — no PG needed. Mutates `agents` in place and returns them;
 * a `fetchWakeabilityFn` rejection propagates — the caller decides best-effort.
 */
export async function reconcileWakeability<T extends AgentAssignment & { sessionState?: SessionState | null }>(
  agents: T[],
  fetchWakeabilityFn: (ownerIds: string[]) => Promise<Map<string, WakeabilitySignals>> = fetchWakeability,
  fetchRecordedLiveFn: (ownerIds: string[]) => Promise<Set<string>> = recordedLiveOwnerIds,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const ownerIds = agents.map((a) => a.agentId);
  const [wakeability, recordedLive] = await Promise.all([fetchWakeabilityFn(ownerIds), fetchRecordedLiveFn(ownerIds)]);
  const nowMs = Date.now();
  for (const a of agents) {
    const w = wakeability.get(a.agentId);
    if (!w) continue; // no signal (e.g. a federated peer) — leave heartbeat-only alive, sessionState unset.
    // fleet-liveness-zombie-await-2026-07-07: force an hour-cold holder to `ended`
    // even if its wake-await outlived an abrupt death (reboot/SIGKILL skips
    // cancelInboxWakeAwaits) — else it stays `parked` and reads as a live member.
    const hardStale = isHardStale(a.heartbeatAt ? Date.parse(a.heartbeatAt) : null, nowMs);
    const sessionState =
      !w.wakeable && recordedLive.has(a.agentId)
        ? 'recorded'
        : deriveSessionState({ stale: !a.alive, wakeable: w.wakeable, liveTurn: w.liveTurn, hardStale });
    a.sessionState = sessionState;
    if (sessionState === 'recorded') a.alive = true;
    if (sessionState === 'ended') a.alive = false;
  }
  return agents;
}

/**
 * EI-8995 (one liveness verdict instead of three half-truths): the SINGLE derived
 * per-member lifecycle state a leader makes relaunch/re-steer decisions on. Fuses
 * the three signals that previously took a three-query join — heartbeat liveness
 * (`alive`), session state (`sessionState`, EI-6077), and REAL-work freshness
 * (last recorded tool invocation — the canary-first protocol's "a join event is
 * NOT liveness; verify a first turn" check, now a field):
 *
 *   dead            — session authoritatively ended, or no liveness evidence.
 *   stalled         — alive but not producing: a claim not advancing (the per-claim
 *                     stall signal) or holding work with no tool call in the window.
 *   speaking        — a tool call within the fresh window: REALLY working right now.
 *                     Outranks `stalled`: a speaking member with one stalled ITEM is a
 *                     re-steer (the item is in stalled[]), not a relaunch.
 *   first-turn-done — has completed real work (≥1 recorded tool call) but is not
 *                     currently fresh — between wakes / drained.
 *   joined          — coord presence registered, ZERO tool calls yet (boot window;
 *                     a join event is NOT liveness — this state names that
 *                     explicitly instead of leaving it to protocol memory).
 *   booted          — a live session that has not yet registered coord presence
 *                     (the bootstrap gap before `joined`).
 */
export type MemberVerdict = 'booted' | 'joined' | 'first-turn-done' | 'speaking' | 'stalled' | 'dead';

/** A tool call within this window ⇒ `speaking` (really working right now). */
export const VERDICT_SPEAKING_FRESH_MS = 5 * 60_000;
/** Holding work-items with no tool call for this long ⇒ `stalled` (member-level). */
export const VERDICT_STALL_MS = 15 * 60_000;

/** Pure derivation — unit-tests without PG (the DI seam is decorateMemberVerdicts). */
export function deriveMemberVerdict(
  a: {
    present: boolean;
    alive: boolean;
    sessionState?: SessionState | null;
    /** The per-claim progress-stall rollup (AgentAssignment.stalled). */
    stalled: boolean;
    /** Work-item claims held (AgentAssignment.load). */
    load: number;
    /** Last recorded tool invocation (epoch ms), or null = none ever. */
    lastToolCallAtMs: number | null;
  },
  nowMs: number = Date.now(),
): MemberVerdict {
  if (a.sessionState === 'ended' || !a.alive) return 'dead';
  const last = a.lastToolCallAtMs;
  if (last != null && nowMs - last <= VERDICT_SPEAKING_FRESH_MS) return 'speaking';
  // Member-level stall: not speaking AND (an item isn't advancing, or it holds work
  // and went quiet). `last == null` with load is NOT stalled — it has never taken a
  // turn, so it is still in the boot window (joined), not wedged mid-work.
  if (a.stalled || (a.load > 0 && last != null && nowMs - last > VERDICT_STALL_MS)) return 'stalled';
  if (last != null) return 'first-turn-done';
  if (a.sessionState === 'recorded' || !a.present) return 'booted';
  return 'joined';
}

/**
 * Stamp each agent row with the derived `verdict`, its `wakeMode` (auto|manual —
 * a MANUAL member silently STAGES directed wakes for owner release, which a
 * leader cannot see anywhere else on this surface), and `lastToolCallAt`.
 * Batch reads: ONE tool-invocations top-1-per-owner query + ONE wake-mode
 * overrides read for the whole fleet. Exported with injectable fetchers so it
 * unit-tests without PG (the reconcileWakeability pattern). Mutates in place;
 * call AFTER reconcileWakeability so `sessionState` is already settled.
 */
export async function decorateMemberVerdicts<
  T extends AgentAssignment & {
    sessionState?: SessionState | null;
    verdict?: MemberVerdict;
    wakeMode?: WakeMode;
    lastToolCallAt?: string | null;
  },
>(
  agents: T[],
  fetchLastToolCalls: (ownerIds: string[]) => Promise<Map<string, string>> = lastToolCallAtByOwner,
  fetchWakeModeOverrides: () => Promise<Map<string, WakeMode>> = getAllWakeModeOverrides,
  fetchDefaultWakeMode: () => Promise<WakeMode> = getDefaultWakeMode,
  nowMs: number = Date.now(),
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const [lastCalls, overrides, defaultMode] = await Promise.all([
    fetchLastToolCalls(agents.map((a) => a.agentId)),
    fetchWakeModeOverrides(),
    fetchDefaultWakeMode(),
  ]);
  for (const a of agents) {
    const iso = lastCalls.get(a.agentId) ?? null;
    const lastMs = iso ? Date.parse(iso) : null;
    a.lastToolCallAt = iso;
    a.verdict = deriveMemberVerdict(
      {
        present: a.present,
        alive: a.alive,
        sessionState: a.sessionState,
        stalled: a.stalled,
        load: a.load,
        lastToolCallAtMs: Number.isFinite(lastMs as number) ? lastMs : null,
      },
      nowMs,
    );
    a.wakeMode = resolveWakeModeFrom(overrides.get(a.agentId) ?? null, defaultMode);
  }
  return agents;
}

/**
 * P-001 (fleet-member-dx-improvements-2026-07-10, EI-9014): stamp each agent row
 * with `parkedOn` — the event keys of its ACTIVE non-inbox-wake events:await
 * registrations. An agent parked on a real key is DELIBERATELY idle (benched
 * awaiting a pushed event — typically a leader's "I'll emit when X greens"),
 * not abandoned: a leader sees who is parked on what without tracking benches
 * from memory, and the claim-discipline watch suppresses its nag (P-002).
 * DERIVED from the await store — no new state; the always-armed
 * `coord:inbox-wake:<id>` self-await never counts (every live agent holds one).
 * Exported with an injectable fetcher so it unit-tests without PG (the
 * decorateMemberVerdicts pattern). Mutates in place; best-effort at the call site.
 */
export async function decorateParkedOn<T extends AgentAssignment & { parkedOn?: string[] }>(
  agents: T[],
  fetchParkedAwaits: (
    ids: string[],
  ) => Promise<Array<{ subscriberId: string; eventKey: string }>> = listParkedAwaitsForSubscribers,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const rows = await fetchParkedAwaits(agents.map((a) => a.agentId));
  if (rows.length === 0) return agents;
  const byId = buildParkedOnMap(rows);
  for (const a of agents) {
    const keys = byId.get(a.agentId);
    if (keys && keys.length > 0) a.parkedOn = keys;
  }
  return agents;
}

/**
 * WI-3715 (fleet-leader-frictions-six-improvements-2026-07-10, P-001): the
 * `subscriberId → capped/deduped event-key list` grouping `decorateParkedOn`
 * above needs — pulled out so `coord:presence`'s own parkedOn overlay (the
 * item's other required surface) derives from the SAME cap/dedup rule
 * instead of re-implementing it, rather than forking a second copy.
 */
export function buildParkedOnMap(
  rows: ReadonlyArray<{ subscriberId: string; eventKey: string }>,
): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const r of rows) {
    const list = byId.get(r.subscriberId) ?? [];
    // Cap per-agent keys (a standing-watch hoarder shouldn't bloat every read).
    if (list.length < 6 && !list.includes(r.eventKey)) list.push(r.eventKey);
    byId.set(r.subscriberId, list);
  }
  return byId;
}

/**
 * P-007 (fleet-deltas-leader-primitives-2026-07-10): stamp each agent row with
 * `contextPressure` (ok|high|critical|null) — the fleet-health read of the SAME
 * watchdog-cached context signal the ambient gauge bands on (context-pressure.ts),
 * so a leader scanning fleet:assignments sees who is about to compact WITHOUT a
 * separate per-member coord:presence call. Exported with an injectable fetcher so
 * it unit-tests without PG (the decorateParkedOn pattern). Mutates in place;
 * best-effort at the call site.
 */
export async function decorateContextPressure<
  T extends AgentAssignment & { contextPressure?: ContextPressureBucket | null },
>(
  agents: T[],
  fetchPressure: (ownerIds: string[]) => Promise<Map<string, ContextPressureBucket>> = fetchContextPressure,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const pressure = await fetchPressure(agents.map((a) => a.agentId));
  for (const a of agents) {
    a.contextPressure = pressure.get(a.agentId) ?? null;
  }
  return agents;
}

export default defineTool({
  name: 'fleet:assignments',
  profile: 'engineer',
  description:
    'The canonical "who\'s on what" query: per-agent presence + plan-item + work-item claims unified (claim-primary, holder liveness AND progress joined). Top-level `self` = your ownerId; your own row is stamped `isSelf:true`. Each live agent carries its ordered work-list — `doing`, `queued`, `load` — the placement read. Surfaces `orphaned` (live lease, DEAD holder) AND `stalled` (live holder, NO progress in window) claims — both reclaimable, neither "covered" — plus per-claim `activity` (free|reserved|alive|progressing|stalled|dead) and declared-but-unclaimed intents. Each row carries the derived lifecycle `verdict` (booted|joined|first-turn-done|speaking|stalled|dead — THE relaunch/re-steer field, EI-8995) and `wakeMode` (auto|manual — manual STAGES directed wakes for owner release). Read this, not a stale coord broadcast.',
  guidance: {
    when: 'Answering "who\'s running / what is agent X doing / X\'s ordered work-list / how loaded is X / is anyone on plan P". The state query AND the placement-decision read — use it instead of scanning coord:inbox or replaying lifecycle messages.',
    notWhen:
      'You want to be notified of future changes (subscribe the fleet_assignment change-feed) or you need full message history (coord:inbox).',
    chaining:
      'fleet:assignments { plan } → an orphaned/stalled claim → work_items:release / plan_items:release, or pick it up yourself; never assume "someone\'s on it" from a coord message. fleet:assignments { agent } before messaging an agent about its work.',
    // Result-aware (D-003): the work_items:release pointer surfaces with a REAL
    // count ONLY when there are orphaned/stalled claims to reclaim — dynamically
    // gated so a clean fleet pays no "See also:" bloat. The two adjacent-lens
    // pointers are always relevant, so they stay static in the returned list.
    seeAlso: (result) => {
      const j = readJsonResult<{
        summary?: { orphaned_claims?: number; stalled_claims?: number };
      }>(result);
      // seeAlso runs on the SERIALIZED result — the {data} envelope may be TOON
      // on the MCP transport (readJsonResult → undefined). TOON renders nested
      // scalars as `orphaned_claims: N` lines, so a cheap regex keeps the
      // conditional reclaim pointer alive on compact responses (fail-open to 0).
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const num = (key: string): number => Number(new RegExp(`\\b${key}\\b["']?\\s*:\\s*(\\d+)`).exec(text)?.[1] ?? 0);
      const reclaimable = j?.summary
        ? (j.summary.orphaned_claims ?? 0) + (j.summary.stalled_claims ?? 0)
        : num('orphaned_claims') + num('stalled_claims');
      const out: SeeAlsoEntry[] = [
        'coord:roster { view:"claims" } (the unified who-on-what-item lens)',
        "fleet:status (the fleet's leader + live members)",
      ];
      if (reclaimable > 0) {
        out.unshift({
          tool: 'work_items:release',
          reason: `free ${reclaimable} orphaned/stalled claim${reclaimable === 1 ? '' : 's'}`,
        });
      }
      return out;
    },
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z
      .string()
      .max(120)
      .optional()
      .describe('Filter to one agent (ownerId or adopted agent-name) — "what is X doing".'),
    plan: z.string().max(200).optional().describe('Filter to one plan slug — "who\'s on P".'),
    harness: z.string().max(80).optional(),
    workspace: z.string().max(120).optional(),
    include_stale: z
      .boolean()
      .optional()
      .describe(
        'Also list stale idle agents (no claims, old heartbeat). Default false. Orphaned claims always show regardless.',
      ),
    include_lapsed: z
      .boolean()
      .optional()
      .describe('Include lapsed (expired, unreclaimed) plan-item leases. Default false.'),
    fullCoverage: z
      .boolean()
      .optional()
      .describe(
        "Include long-complete historical coverage entries (the full ledger). Default false: 'complete' entries are kept only for your lane plans or with recent (~7d) activity (EI-9015).",
      ),
    includeDag: z
      .boolean()
      .optional()
      .describe(
        "Also return the plan's DAG-filter frontier (EI-6949): every item the fleet's dependency DAG selects, with per-item status (ready|blocked|claimed|wip|done|dropped) + blockedBy/unresolvedBlockers/claimedBy/files + counts. Reuses the SAME plan-item DAG state the spawner admits from, so `ready` = what would be placed next. Requires `plan`; off by default (the frontier is fleet-level, kept off the per-agent presence path). Opt-in so the default read stays lean.",
      ),
  }),
  // context-trimming-tiers P-022: trimmed/standard sessions get the placement
  // decision core (summary + reclaimables + compact agent rows — see
  // assignments-shape.ts). The pui bee-dossier reads this over HTTP (no
  // ctx_tier) → always full.
  shape: {
    standard: (data) => shapeFleetAssignments(data, 'standard'),
    trimmed: (data) => shapeFleetAssignments(data, 'trimmed'),
  },
  async handler(args, ctx) {
    // A READ — identity is used only to default the optional workspace filter
    // (null = all workspaces). Resolve it SOFTLY so a bare loopback caller (the
    // pui bee-dossier pane, the IPC sys:http bridge) can read the state without
    // an attributable coord identity — this is not a coordination write.
    let actorWorkspace: string | null = null;
    try {
      actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
    } catch {
      actorWorkspace = null;
    }
    // F-M1 (workspace-data-isolation-leaks): when neither an explicit workspace nor
    // a resolved identity is present, default to the ACTIVE workspace rather than
    // null (= ALL workspaces), so a bare loopback caller no longer reads every
    // workspace's fleet state. The data layer still ORs in GLOBAL + the plan-store
    // DEFAULT_WORKSPACE_ID scope (EI-295), so claim rows are preserved.
    const workspaceId = args.workspace ?? actorWorkspace ?? activeWorkspaceId();
    const rows = await listFleetAssignments({
      workspaceId,
      agent: args.agent,
      plan: args.plan,
      harness: args.harness,
      activeOnly: !args.include_lapsed,
    });
    const agents: (AgentAssignment & {
      sessionState?: SessionState | null;
      contextPressure?: ContextPressureBucket | null;
    })[] = groupByAgent(rows).filter((g) => args.include_stale || g.claims.length > 0 || g.alive);
    // EI-6077: reconcile `alive` against coord:presence's own wakeability signal
    // (see reconcileWakeability above) — best-effort, a query failure just leaves
    // today's heartbeat-only `alive` and an absent `sessionState` (state unknown).
    await reconcileWakeability(agents).catch(() => {});
    // EI-8995: stamp the single derived per-member `verdict` (+ wakeMode +
    // lastToolCallAt) — AFTER reconcileWakeability so sessionState is settled.
    // Best-effort: a failure leaves the rows verdict-less, never breaks the read.
    await decorateMemberVerdicts(agents).catch(() => {});
    // P-001 (fleet-member-dx): stamp `parkedOn` — active non-inbox-wake events:await
    // keys — so a deliberately-benched member reads as parked, not abandoned.
    // Best-effort: a failure just omits the field.
    await decorateParkedOn(agents).catch(() => {});
    // P-007: stamp `contextPressure` (ok|high|critical|null) — best-effort, never
    // breaks the read. Independent of the joins above (its own batch query).
    await decorateContextPressure(agents).catch(() => {});
    const orphans = orphanedClaims(rows);
    // agent-activity-liveness-truth P-002/P-005: a live-but-not-progressing holder
    // is NOT "covered" — surface stalled claims as reclaimable alongside orphans, so
    // no reader concludes "someone's on it" from a claim that isn't advancing.
    const stalled = stalledClaims(rows);
    // Plan-item COVERAGE rollup: which plan items are being worked via a LINKED
    // work-item (or a direct claim) even when no plan-item lease names them — the
    // blind spot that makes plans:items show an actively-worked item as unworked.
    // Fuses work→plan_item edges + the work-item's liveness + any direct plan-item
    // claim. Filtered to the queried plan when `plan` is set; bounded for output.
    // Non-fatal — a coverage outage just omits the section.
    //
    // The SAME fused map also yields COVERAGE COLLISIONS (EI-6074): a plan item
    // directly claimed by one principal while a linked live work-item covering the
    // same deliverable is held by a DIFFERENT principal — the cross-claim-table
    // duplicate the per-type dedup floor can't see (orphaned/stalled both read 0
    // while two live bees run the same work). Surfaced as a reclaimable-grade
    // coordination smell so the Queen sees it without eyeballing intents.
    const COVERAGE_CAP = 60;
    let coverageOut: {
      plan: string;
      item: string;
      level: string;
      workers?: string[];
      links?: { id: string; rel: string; activity: string; terminal: boolean }[];
    }[] = [];
    let coverageTruncated = false;
    let collisions: CoverageCollision[] = [];
    // Hoisted so the DAG-frontier block (includeDag) reuses the SAME fused
    // coverage map for its claims — one getAllPlanItemCoverage() call, not two.
    let covMap: Awaited<ReturnType<typeof getAllPlanItemCoverage>> | null = null;
    try {
      covMap = await getAllPlanItemCoverage();
      // Scope to the queried plan (when set) the same way coverage is, so a
      // { plan } filter narrows both the coverage rollup AND the collision list.
      // P-003 (fleet-member-dx, EI-9017): an {agent}-scoped read (e.g. coord:orient's
      // `me` sub-read on every wake) previously still returned the WHOLE workspace
      // coverage table (~60 rows of other agents' plans) — coverage was plan-scoped
      // but never agent-scoped. When `agent` is set and `plan` is not, restrict the
      // rollup to the plans that agent actually touches (its claim rows + declared
      // plan). An agent touching no plans gets an empty rollup (correct — nothing
      // it works is covered elsewhere); an explicit {plan} still wins.
      const agentPlans: Set<string> | null =
        args.agent && !args.plan
          ? new Set(
              [
                ...rows.map((r) => r.planSlug),
                ...agents.map((a) => a.declaredPlanSlug),
              ].filter((s): s is string => typeof s === 'string' && s.length > 0),
            )
          : null;
      const inScope = (ref: string): boolean => {
        const hash = ref.indexOf('#');
        const plan = hash > 0 ? ref.slice(0, hash) : null;
        if (args.plan) return plan === args.plan;
        if (agentPlans) return plan != null && agentPlans.has(plan);
        return true;
      };
      const scoped = [...covMap.values()].filter((c) => inScope(c.ref));
      // Collisions are computed over the UNTRIMMED scope — the active-coverage
      // default below is a payload filter, never a correctness filter.
      collisions = coverageCollisions(scoped);
      const entries = filterActiveCoverage(scoped, {
        explicitPlan: args.plan ?? null,
        lanePlans: agentPlans,
        fullCoverage: args.fullCoverage,
      })
        // 'none' carries no signal worth surfacing here (it's the absence of coverage).
        .filter((c) => c.level !== 'none')
        // Most-covered first: complete/full/partial/unclaimed.
        .sort((a, b) => COVERAGE_ORDER.indexOf(a.level) - COVERAGE_ORDER.indexOf(b.level));
      coverageTruncated = entries.length > COVERAGE_CAP;
      coverageOut = entries.slice(0, COVERAGE_CAP).map((c) => {
        const hash = c.ref.indexOf('#');
        const compact = compactCoverage(c);
        return {
          plan: hash > 0 ? c.ref.slice(0, hash) : c.ref,
          item: hash > 0 ? c.ref.slice(hash + 1) : c.ref,
          level: compact.level,
          ...(compact.workers ? { workers: compact.workers } : {}),
          ...(compact.links ? { links: compact.links } : {}),
        };
      });
    } catch {
      // Non-fatal — omit the coverage section.
    }
    // DAG-filter frontier (EI-6949, includeDag): the whole set of items the plan's
    // dependency DAG selects, each with its disposition — a FLEET-level work-graph
    // view surfaced ONLY on request (never on the per-agent presence path, which
    // would duplicate this list across every agent's row). Reuses the SAME plan-item
    // DAG state the spawner admits from (effectiveStatus + unresolvedBlockers) + the
    // coverage map for claims, so `ready` is exactly what would be placed next.
    // Requires a plan; non-fatal (a read hiccup just omits the section).
    let dagView: DagFrontierView | null = null;
    if (args.includeDag && args.plan) {
      try {
        const row = await getPlanRow(args.plan, { workspaceId });
        if (row) {
          const items = resolveEffectiveStatusForItems(planItemsForRow(row)).items;
          const claims = covMap ? claimsFromCoverage(covMap.values(), args.plan) : {};
          dagView = shapeDagFrontier(items, claims);
        }
      } catch {
        // Non-fatal — omit the dag section.
      }
    }
    // Summary is computed over the FULL agent set so the counts stay accurate even
    // when the returned `agents` array is bounded below.
    const summary = {
      agents: agents.length,
      alive: agents.filter((a) => a.alive).length,
      claims: rows.filter((r) => r.source !== 'presence').length,
      orphaned_claims: orphans.length,
      stalled_claims: stalled.length,
      // EI-6074: distinct plan-item deliverables held by >1 principal via the
      // work-item↔plan-item coverage edge — the silent cross-table duplicate.
      coverage_collisions: collisions.length,
      declared_unclaimed: agents.filter((a) => a.declaredUnclaimed).length,
      // P-001 (fleet-member-dx): members deliberately parked on an events:await —
      // idle-by-design, not stalled/abandoned.
      parked: agents.filter((a) => ((a as { parkedOn?: string[] }).parkedOn?.length ?? 0) > 0).length,
      // P-021: total work-item load across live agents (the warm-inject signal).
      work_item_load: agents.reduce((n, a) => n + a.load, 0),
      // P-007: fleet-health headline — members whose context-pressure bucket is
      // high/critical right now (silent when 0, mirroring the ambient gauge's
      // quiet-below-LOUD philosophy).
      high_context: agents.filter((a) => a.contextPressure === 'high').length,
      critical_context: agents.filter((a) => a.contextPressure === 'critical').length,
    };
    // EI-1597: bound the agent-facing output so a large fleet (esp. include_stale)
    // can't overflow the agent result cap. `agents` is already sorted live-first, so
    // the byte-budget trim drops the least-relevant tail. Excerpt the long `intent`
    // text + cap each agent's `queued` work-list (head + `load` are what placement
    // reads; the full tail is reachable via a narrower { agent }/{ plan } query).
    // Internal callers + the UI read the data layer (groupByAgent) directly — unaffected.
    let agentsOut = boundRowField(agents, 'intent', 280, 14_000);
    agentsOut = boundListField(agentsOut, 'queued', 8);
    const { kept: boundedAgents, truncated: agentsTruncated } = trimToByteBudget(agentsOut, 22_000);
    // Self-identification overlay: top-level `self` names the caller's own
    // ownerId, and the caller's own agent row (keyed by `agentId`) is stamped
    // `isSelf:true`, so a reader of "who's on what" can tell which agent is
    // itself. Best-effort — an unattributable caller just gets no marker.
    const self = resolveSelfRef(ctx);
    const selfMarkedAgents = markSelfRows(boundedAgents, self, 'agentId');
    // {data} envelope so the payload-tier shapers apply; HTTP consumers (the
    // pui bee-dossier pane) still read identical lossless JSON text.
    return {
      data: {
        ok: true,
        ...(self ? { self } : {}),
        summary,
        // Abandoned work first — the reason this view is claim-primary.
        orphaned: orphans.map(summarizeOrphan),
        // Stalled work (live holder, no progress) — also reclaimable, also "not covered".
        stalled: stalled.map(summarizeOrphan),
        // Coverage collisions (EI-6074): two distinct principals resolving to the
        // same deliverable via the work-item↔plan-item coverage edge. Omitted when clean.
        ...(collisions.length ? { coverage_collisions: collisions } : {}),
        // Plan-item coverage: items being worked via a linked work-item / direct
        // claim (even with no plan-item lease). 'none' is omitted (no signal).
        ...(coverageOut.length
          ? {
              coverage: coverageOut,
              ...(coverageTruncated
                ? {
                    coverage_truncated: true,
                    coverage_hint: `Coverage list trimmed to ${COVERAGE_CAP}; narrow with { plan }, or pass fullCoverage:true for the untrimmed historical ledger.`,
                  }
                : {}),
            }
          : {}),
        // DAG-filter frontier (includeDag) — omitted unless requested (+ a plan).
        ...(dagView ? { dag: dagView } : {}),
        agents: selfMarkedAgents,
        ...(agentsTruncated
          ? {
              agents_truncated: true,
              agents_returned: selfMarkedAgents.length,
              agents_hint:
                'Agent list trimmed to fit the result cap (sorted live-first). Narrow with { agent }/{ plan }/{ harness }; summary.agents has the true total.',
            }
          : {}),
      },
    };
  },
});

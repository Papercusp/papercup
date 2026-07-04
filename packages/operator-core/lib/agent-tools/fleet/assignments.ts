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
  type SessionState,
  type WakeabilitySignals,
} from '../coordination/presence-wakeability';
import {
  groupByAgent,
  listFleetAssignments,
  orphanedClaims,
  stalledClaims,
  summarizeOrphan,
  type AgentAssignment,
} from '../../fleet/assignments';
import {
  getAllPlanItemCoverage,
  compactCoverage,
  coverageCollisions,
  type CoverageCollision,
} from '../../plan-item-coverage';
import { boundRowField, boundListField, trimToByteBudget } from '../_bound-output';
import { shapeFleetAssignments } from './assignments-shape';
import { getPlanRow, planItemsForRow } from '../plans/source';
import { resolveEffectiveStatusForItems } from '../plans/effective-status';
import { shapeDagFrontier, claimsFromCoverage, type DagFrontierView } from '../../fleet-dag-view';

/** Coverage levels most-covered → least, for sorting the rollup. */
const COVERAGE_ORDER = ['complete', 'full', 'partial', 'unclaimed', 'none'];

export default defineTool({
  name: 'fleet:assignments',
  profile: 'engineer',
  description:
    'The canonical "who\'s on what" query: per-agent presence + plan-item + work-item claims unified (claim-primary, holder liveness AND progress joined). The result\'s top-level `self` is YOUR own ownerId and your own agent row is stamped `isSelf:true`, so you can tell which agent in the list is THIS session. Each live agent carries its ordered work-list — `doing` (head-of-line), `queued`, `load` — the externalized per-bee TodoWrite the Queen reads for placement. The single LIVE source for "is X really being worked": surfaces `orphaned` (live lease, DEAD holder) AND `stalled` (live holder, NO progress in window) claims — both reclaimable, neither "covered" — plus per-claim `activity` (free|reserved|alive|progressing|stalled|dead) and declared-but-unclaimed intents. Read this, not a stale coord broadcast.',
  guidance: {
    when: 'Answering "who\'s running / what is agent X doing / X\'s ordered work-list / how loaded is X / is anyone on plan P". The state query AND the placement-decision read — use it instead of scanning coord:inbox or replaying lifecycle messages.',
    notWhen:
      'You want to be notified of future changes (subscribe the fleet_assignment change-feed) or you need full message history (coord:inbox).',
    chaining:
      'fleet:assignments { plan } → an orphaned/stalled claim (dead/not-progressing holder = NOT covered) → work_items:release / plan_items:release, or pick it up yourself; never assume "someone\'s on it" from a coord message. fleet:assignments { agent } before messaging an agent about its work.',
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
      const num = (key: string): number =>
        Number(new RegExp(`\\b${key}\\b["']?\\s*:\\s*(\\d+)`).exec(text)?.[1] ?? 0);
      const reclaimable = j?.summary
        ? (j.summary.orphaned_claims ?? 0) + (j.summary.stalled_claims ?? 0)
        : num('orphaned_claims') + num('stalled_claims');
      const out: SeeAlsoEntry[] = [
        'coord:roster { view:"claims" } (the unified who-on-what-item lens)',
        'fleet:status (the fleet\'s leader + live members)',
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
      .describe('Also list stale idle agents (no claims, old heartbeat). Default false. Orphaned claims always show regardless.'),
    include_lapsed: z
      .boolean()
      .optional()
      .describe('Include lapsed (expired, unreclaimed) plan-item leases. Default false.'),
    includeDag: z
      .boolean()
      .optional()
      .describe(
        'Also return the plan\'s DAG-filter frontier (EI-6949): every item the fleet\'s dependency DAG selects, with per-item status (ready|blocked|claimed|wip|done|dropped) + blockedBy/unresolvedBlockers/claimedBy/files + counts. Reuses the SAME plan-item DAG state the spawner admits from, so `ready` = what would be placed next. Requires `plan`; off by default (the frontier is fleet-level, kept off the per-agent presence path). Opt-in so the default read stays lean.',
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
    const agentsRaw: (AgentAssignment & { sessionState?: SessionState | null })[] =
      groupByAgent(rows).filter((g) => args.include_stale || g.claims.length > 0 || g.alive);
    // EI-6077: `alive` above is heartbeat-freshness only (EI-6374 already downgrades
    // it for a CONFIRMED-ended session, but a session that is simply not
    // coord-wakeable — no live `coord:inbox-wake:<id>` await, e.g. it never
    // registered one — still read `alive:true` here while coord:dispatch/coord:send
    // could not actually reach it). Port the SAME reconciliation fleet:status
    // already applies (EI-5858, fleet/fleet-roster.ts foldFleetRoster): derive
    // `sessionState` from wakeability and gate `alive` on it, so the two "who's
    // running" tools agree instead of leaving the Queen to notice the mismatch by
    // cross-calling both. Best-effort — a query failure just leaves today's
    // heartbeat-only `alive` and an absent `sessionState` (state unknown).
    try {
      const wakeability = await fetchWakeability(agentsRaw.map((a) => a.agentId));
      for (const a of agentsRaw) {
        const w: WakeabilitySignals | undefined = wakeability.get(a.agentId);
        if (!w) continue;
        const sessionState = deriveSessionState({ stale: !a.alive, wakeable: w.wakeable, liveTurn: w.liveTurn });
        a.sessionState = sessionState;
        if (sessionState === 'ended') a.alive = false;
      }
    } catch {
      // Non-fatal — omit sessionState, keep heartbeat-only alive (today's behavior).
    }
    const agents = agentsRaw;
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
      const inScope = (ref: string): boolean => {
        if (!args.plan) return true;
        const hash = ref.indexOf('#');
        return hash > 0 && ref.slice(0, hash) === args.plan;
      };
      const scoped = [...covMap.values()].filter((c) => inScope(c.ref));
      collisions = coverageCollisions(scoped);
      const entries = scoped
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
      // P-021: total work-item load across live agents (the warm-inject signal).
      work_item_load: agents.reduce((n, a) => n + a.load, 0),
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
                ? { coverage_truncated: true, coverage_hint: `Coverage list trimmed to ${COVERAGE_CAP}; narrow with { plan }.` }
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

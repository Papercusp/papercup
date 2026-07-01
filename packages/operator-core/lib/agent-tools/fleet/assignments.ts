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
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveSelfRef, markSelfRows } from '../coordination/self-marker';
import { COORD_ROLES } from '../coordination/roles';
import {
  groupByAgent,
  listFleetAssignments,
  orphanedClaims,
  stalledClaims,
  summarizeOrphan,
} from '../../fleet/assignments';
import { getAllPlanItemCoverage, compactCoverage } from '../../plan-item-coverage';
import { boundRowField, boundListField, trimToByteBudget } from '../_bound-output';

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
    seeAlso: [
      'coord:roster { view:"claims" } (the unified who-on-what-item lens)',
      'work_items:release (free an orphaned/stalled claim you find)',
      'fleet:status (the fleet\'s leader + live members)',
    ],
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
  }),
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
    const agents = groupByAgent(rows).filter(
      (g) => args.include_stale || g.claims.length > 0 || g.alive,
    );
    const orphans = orphanedClaims(rows);
    // agent-activity-liveness-truth P-002/P-005: a live-but-not-progressing holder
    // is NOT "covered" — surface stalled claims as reclaimable alongside orphans, so
    // no reader concludes "someone's on it" from a claim that isn't advancing.
    const stalled = stalledClaims(rows);
    // Summary is computed over the FULL agent set so the counts stay accurate even
    // when the returned `agents` array is bounded below.
    const summary = {
      agents: agents.length,
      alive: agents.filter((a) => a.alive).length,
      claims: rows.filter((r) => r.source !== 'presence').length,
      orphaned_claims: orphans.length,
      stalled_claims: stalled.length,
      declared_unclaimed: agents.filter((a) => a.declaredUnclaimed).length,
      // P-021: total work-item load across live agents (the warm-inject signal).
      work_item_load: agents.reduce((n, a) => n + a.load, 0),
    };
    // Plan-item COVERAGE rollup: which plan items are being worked via a LINKED
    // work-item (or a direct claim) even when no plan-item lease names them — the
    // blind spot that makes plans:items show an actively-worked item as unworked.
    // Fuses work→plan_item edges + the work-item's liveness + any direct plan-item
    // claim. Filtered to the queried plan when `plan` is set; bounded for output.
    // Non-fatal — a coverage outage just omits the section.
    const COVERAGE_CAP = 60;
    let coverageOut: {
      plan: string;
      item: string;
      level: string;
      workers?: string[];
      links?: { id: string; rel: string; activity: string; terminal: boolean }[];
    }[] = [];
    let coverageTruncated = false;
    try {
      const covMap = await getAllPlanItemCoverage();
      const entries = [...covMap.values()]
        // 'none' carries no signal worth surfacing here (it's the absence of coverage).
        .filter((c) => c.level !== 'none')
        .filter((c) => {
          if (!args.plan) return true;
          const hash = c.ref.indexOf('#');
          return hash > 0 && c.ref.slice(0, hash) === args.plan;
        })
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
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ...(self ? { self } : {}),
            summary,
            // Abandoned work first — the reason this view is claim-primary.
            orphaned: orphans.map(summarizeOrphan),
            // Stalled work (live holder, no progress) — also reclaimable, also "not covered".
            stalled: stalled.map(summarizeOrphan),
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
            agents: selfMarkedAgents,
            ...(agentsTruncated
              ? {
                  agents_truncated: true,
                  agents_returned: selfMarkedAgents.length,
                  agents_hint:
                    'Agent list trimmed to fit the result cap (sorted live-first). Narrow with { agent }/{ plan }/{ harness }; summary.agents has the true total.',
                }
              : {}),
          }),
        },
      ],
    };
  },
});

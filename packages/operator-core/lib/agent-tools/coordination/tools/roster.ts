/**
 * coord:roster { scope, view } — unified presence/roster reader with explicit lenses.
 *
 * ONE read door answering "who's in this hive/fleet and what are they doing", with
 * four view lenses:
 *   - view=live (DEFAULT) — in-a-turn presence state (same underlying model as
 *     coord:presence, fleet:assignments, coord:glance; just one tool instead of three)
 *   - view=members — fleet/hive membership (who joined what, when)
 *   - view=claims — work-item + plan-item claims (who's on what work/plan)
 *   - view=history — historical who-was-ever-here (append-only coord log filtered by
 *     audience, requires coord:catch-up infrastructure)
 *
 * Scope defaults to 'hive' (caller's home hive); accepts 'workspace' or 'all' for admin/Queen.
 *
 * The singular interface kills "which of 5 tools do I call" — coord:presence /
 * fleet:status / fleet:assignments / coord:glance become thin aliases (or deprecate).
 * Presence-coord-unification P-001 / D-001.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  resolvePresenceScope,
  assemblePresenceSnapshot,
  projectRosterRows,
  filterRosterRowsByState,
} from '../presence-snapshot';
import { resolveSelfRef, markSelfRows } from '../self-marker';
import { readIdentity } from '../../locks/identity';
import { COORD_ROLES } from '../roles';
import { listFleetAssignments, groupByAgent, orphanedClaims, stalledClaims } from '../../../fleet/assignments';
import { reconcileWakeability } from '../../fleet/assignments';
import { resolveConcreteWorkspaceId } from '../../../workspace-registry';
import { resolveAgentIdentity } from '../identity';

export default defineTool({
  name: 'coord:roster',
  description:
    'ONE read door with an explicit lens: view=live (in-a-turn presence), members (fleet/hive membership), claims (who-on-what-item), history (who-was-ever-here). Same underlying model; coord:presence / fleet:status / fleet:assignments / coord:glance become thin aliases (or deprecate). Kills "which of 5 tools do I call".',
  guidance: {
    when: 'Before dispatch/handoff/routing: who can take work (view=live)? Who joined what fleet (view=members)? Who\'s on plan P (view=claims)? Historical who-was-ever-here (view=history). Just need live ownerIds? { view:"live", project:"liveness", states:["live"] } — ~99% smaller than the default read, and the only form that reliably fits one result.',
    notWhen: 'Being notified of future changes (subscribe fleet_assignment change-feed). Full message history (coord:inbox). Rate-limit telemetry (dev:rate_governor_status). NEVER hand-query coord_presence for liveness — sessionState is derived from six legs, two of which are not in Postgres, so no column holds it; use project/states here instead.',
    chaining: 'coord:roster { view } → read ONCE per turn; tail [coord+N] deltas for transitions. For history, use coord:catch-up after to refine by topic/plan.',
    seeAlso: [
      'coord:presence (view=live · members)',
      'fleet:assignments (view=claims)',
      'coord:catch-up { audience } (view=history)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    view: z
      .enum(['live', 'members', 'claims', 'history'])
      .optional()
      .describe(
        'Lens type: live (DEFAULT) = in-a-turn presence state; members = fleet/hive membership; claims = work/plan-item claims; history = append-only who-was-ever-here.',
      ),
    scope: z
      .enum(['hive', 'workspace', 'all'])
      .optional()
      .describe(
        'hive (DEFAULT) = your Hive\'s agents + federated peers; workspace = the whole workspace; all = every workspace (admin/Mug). Caller with no Hive (SU/operator) falls back to workspace.',
      ),
    pot: z
      .string()
      .optional()
      .describe('Explicit Hive slug to scope to (overrides caller-hive resolution; implies scope=hive).'),
    workspace: z
      .string()
      .optional()
      .describe('Workspace id for workspace/hive scope; omit to use the caller\'s.'),
    owner: z
      .string()
      .optional()
      .describe(
        'TARGETED lookup (view=live,members only): return ONLY the row(s) matching this agent id/label (exact, else substring). Include even if ended.',
      ),
    plan: z
      .string()
      .max(200)
      .optional()
      .describe('Filter to one plan slug (view=claims only) — "who\'s on P".'),
    agent: z
      .string()
      .max(120)
      .optional()
      .describe('Filter to one agent (view=claims only) — "what is X doing".'),
    include_detail: z
      .boolean()
      .optional()
      .describe('view=live,members: add each agent\'s heldFiles (cross-DB lock detail, opt-in). Default false.'),
    include_stale: z
      .boolean()
      .optional()
      .describe('view=live,claims: also list stale idle agents (no claims, old heartbeat). Default false.'),
    project: z
      .enum(['ids', 'liveness', 'full'])
      .optional()
      .describe(
        'view=live,members: how much of each row to emit. full (DEFAULT) = every field, unchanged. liveness = { ownerId, sessionState } only (~92% smaller). ids = ownerIds only (~96% smaller). The SAME oracle verdict either way — fewer fields, never a cheaper derivation.',
      ),
    states: z
      .array(z.enum(['live', 'parked', 'draining', 'suspect', 'ended', 'recorded']))
      .max(6)
      .optional()
      .describe(
        'view=live,members: return only rows in these sessionStates — e.g. ["live"]. summary/byState still describe the WHOLE roster, so you can see what you filtered out. A federated peer with no derivable state matches nothing and is reported as projection.unknownStateExcluded, never silently dropped.',
      ),
  }),
  async handler(args, ctx) {
    const view = args.view ?? 'live';
    const scope = args.scope ?? 'hive';

    // Shared identity context for both presence and claims views
    const c = (ctx ?? {}) as { workspaceId?: string | null; harnessSlug?: string | null; isSuperuser?: boolean };
    const effScope = args.scope === 'all' && !c.isSuperuser ? 'workspace' : scope;

    // For claims view, resolve identity softly (can fail without breaking the read)
    let actorWorkspace: string | null = null;
    if (view === 'claims') {
      try {
        actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
      } catch {
        actorWorkspace = null;
      }
    }

    if (view === 'live' || view === 'members') {
      // Live and members views: use presence-snapshot infrastructure
      const resolved = await resolvePresenceScope(c, {
        scope: effScope,
        hive: args.pot,
        workspace: args.workspace,
        // EI-18653888556683414: a targeted owner lookup defaults to workspace-wide
        // (not hive-narrowed) so a live peer outside the caller's own Hive is
        // still found instead of reading as "no such agent".
        targetedOwner: !!args.owner,
      });

      let detail: { coordinationDomain: string } | undefined;
      if (args.include_detail) {
        try {
          detail = { coordinationDomain: readIdentity(ctx).coordinationDomain };
        } catch {
          detail = undefined;
        }
      }

      const snapshot = await assemblePresenceSnapshot(resolved, {
        ...(args.owner ? { owner: args.owner } : {}),
        ...(detail ? { detail } : {}),
      });

      const self = resolveSelfRef(ctx);

      // WI-6658: the state filter + field projection run on the ASSEMBLED rows,
      // so every emitted `sessionState` is the same oracle verdict the full read
      // would have given — this lens changes what is EMITTED, never how it is
      // derived. `summary` (incl. byState) is deliberately left describing the
      // WHOLE roster: a filtered read that also narrowed its own summary would
      // be unable to tell you what it hid from you.
      const projection = args.project ?? 'full';
      const marked = markSelfRows(snapshot.active, self);
      const { rows: filtered, unknownStateExcluded } = filterRosterRowsByState(marked, args.states);
      const projected = projectRosterRows(filtered, projection);
      const lensed = projection !== 'full' || (args.states?.length ?? 0) > 0;

      const output = {
        ...snapshot,
        view: view === 'live' ? 'live' : 'members',
        ...(self ? { self } : {}),
        active: projected,
        ...(lensed
          ? {
              projection: {
                project: projection,
                ...(args.states?.length ? { states: args.states } : {}),
                returned: projected.length,
                ofActive: snapshot.active.length,
                ...(unknownStateExcluded ? { unknownStateExcluded } : {}),
              },
            }
          : {}),
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(output),
          },
        ],
      };
    }

    if (view === 'claims') {
      // Claims view: use fleet:assignments infrastructure
      // EI-13820: ctx.workspaceId is the literal '*' sentinel for an unscoped su
      // session (EI-9013) — normalize through resolveConcreteWorkspaceId so '*'
      // never leaks into the workspace filter as if it were a real workspace id
      // (see fleet:assignments' handler for the full incident writeup).
      const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
      const rows = await listFleetAssignments({
        workspaceId,
        agent: args.agent,
        plan: args.plan,
        harness: args.pot,
        activeOnly: !args.include_stale,
      });

      // Unification F1/P-003: the claims lens used to serve the fleet_assignment
      // view's heartbeat-only `alive` while view=live served the full oracle
      // model — ONE tool, two truths (a dead-but-warm session read alive here).
      // Reconcile through the same oracle-backed path fleet:assignments uses
      // (best-effort, like that tool), BEFORE the alive-filter so a dead-warm
      // claimless agent is excluded rather than shown as alive.
      const grouped = groupByAgent(rows);
      await reconcileWakeability(grouped).catch(() => {});
      const agents = grouped.filter(
        (g) => args.include_stale || g.claims.length > 0 || g.alive,
      );

      const orphans = orphanedClaims(rows);
      const stalled = stalledClaims(rows);

      const summary = {
        agents: agents.length,
        alive: agents.filter((a) => a.alive).length,
        claims: rows.filter((r) => r.source !== 'presence').length,
        orphaned_claims: orphans.length,
        stalled_claims: stalled.length,
        declared_unclaimed: agents.filter((a) => a.declaredUnclaimed).length,
        work_item_load: agents.reduce((n, a) => n + a.load, 0),
      };

      const self = resolveSelfRef(ctx);
      const output = {
        view: 'claims',
        as_of: new Date().toISOString(),
        summary,
        agents: markSelfRows(agents, self),
        orphaned: orphans,
        stalled: stalled,
        ...(self ? { self } : {}),
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(output),
          },
        ],
      };
    }

    if (view === 'history') {
      // History view: placeholder for append-only coord log integration (WI-1346)
      // For now, return a structure that points to coord:catch-up
      const output = {
        view: 'history',
        as_of: new Date().toISOString(),
        note: 'History read via coord:catch-up with audience filtering (depends on WI-1346: make coord:catch-up the blessed history read)',
        scope: effScope,
        suggestion: 'Use coord:catch-up { audience: "@fleet:<slug>" } to read historical who-was-ever-here for a fleet',
        data: null, // placeholder until WI-1346 lands
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(output),
          },
        ],
      };
    }

    // Should never reach here due to zod enum validation, but be defensive
    throw new Error(`Unknown view: ${view}`);
  },
});

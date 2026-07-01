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
import { resolvePresenceScope, assemblePresenceSnapshot } from '../presence-snapshot';
import { resolveSelfRef, markSelfRows } from '../self-marker';
import { readIdentity } from '../../locks/identity';
import { COORD_ROLES } from '../roles';
import { listFleetAssignments, groupByAgent, orphanedClaims, stalledClaims } from '../../../fleet/assignments';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolveAgentIdentity } from '../identity';

export default defineTool({
  name: 'coord:roster',
  description:
    'ONE read door with an explicit lens: view=live (in-a-turn presence), members (fleet/hive membership), claims (who-on-what-item), history (who-was-ever-here). Same underlying model; coord:presence / fleet:status / fleet:assignments / coord:glance become thin aliases (or deprecate). Kills "which of 5 tools do I call".',
  guidance: {
    when: 'Before dispatch/handoff/routing: who can take work (view=live)? Who joined what fleet (view=members)? Who\'s on plan P (view=claims)? Historical who-was-ever-here (view=history).',
    notWhen: 'Being notified of future changes (subscribe fleet_assignment change-feed). Full message history (coord:inbox). Rate-limit telemetry (dev:rate_governor_status).',
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
        'hive (DEFAULT) = your Hive\'s agents + federated peers; workspace = the whole workspace; all = every workspace (admin/Queen). Caller with no Hive (SU/operator) falls back to workspace.',
      ),
    hive: z
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
        hive: args.hive,
        workspace: args.workspace,
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

      // For members view, highlight fleet membership
      let output = {
        ...snapshot,
        view: 'members',
        ...(self ? { self } : {}),
        active: markSelfRows(snapshot.active, self),
      };

      // For live view, add presence summary
      if (view === 'live') {
        output = {
          ...output,
          view: 'live',
        };
      }

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
      const workspaceId = args.workspace ?? actorWorkspace ?? activeWorkspaceId();
      const rows = await listFleetAssignments({
        workspaceId,
        agent: args.agent,
        plan: args.plan,
        harness: args.hive,
        activeOnly: !args.include_stale,
      });

      const agents = groupByAgent(rows).filter(
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

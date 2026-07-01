/**
 * routines:list — read the scheduled system routines (live-configurability-audit P-002).
 *
 * The git-sync / green-checkpoint / release-trigger / improvement-watchdog (…) rows live in
 * harness_shared.routines; today the only way to see their cadence/active state is raw SQL. This
 * is the read half (the write half is routines:set).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'routines:list',
  profile: 'engineer',
  description:
    'List the scheduled system routines in this workspace (git-sync, green-checkpoint, release-trigger, improvement-watchdog, …): name, install slug, cron, target role, active flag, next/last fire. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'See the system routines and their cadence/active state before retuning or pausing one (e.g. inspect the git-sync / green-checkpoint / release-trigger schedule).',
    notWhen: 'To CHANGE a routine, use routines:set. For a harness blueprint autoloop, use autoloop:status.',
    chaining: 'routines:set to retune or pause a routine you find here (use its exact name + installSlug).',
    seeAlso: [
      'routines:set (retune / pause a routine)',
      'autoloop:status (a harness blueprint autoloop instead)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 60 } },
  args: z.object({
    installSlug: z.string().max(120).optional().describe('Filter to one install slug.'),
    name: z.string().max(200).optional().describe('Filter to one routine name.'),
  }),
  async handler(args) {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const slug = args.installSlug ?? null;
    const name = args.name ?? null;
    const rows = await sql<
      Array<{
        install_slug: string;
        name: string;
        trigger_kind: string;
        trigger_config: Record<string, unknown> | null;
        target_role: string;
        active: boolean;
        next_fire_at: Date | null;
        last_fired_at: Date | null;
      }>
    >`
      SELECT install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, last_fired_at
        FROM harness_shared.routines
       WHERE workspace_id = ${ws}
         AND (${slug}::text IS NULL OR install_slug = ${slug})
         AND (${name}::text IS NULL OR name = ${name})
       ORDER BY install_slug, name`;
    const iso = (d: Date | null): string | null =>
      d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString() : null;
    const routines = rows.map((r) => ({
      installSlug: r.install_slug,
      name: r.name,
      triggerKind: r.trigger_kind,
      cron: (r.trigger_config as { cron?: string } | null)?.cron ?? null,
      targetRole: r.target_role,
      active: r.active,
      nextFireAt: iso(r.next_fire_at),
      lastFiredAt: iso(r.last_fired_at),
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ count: routines.length, routines }) }] };
  },
});

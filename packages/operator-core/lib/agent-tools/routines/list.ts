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
    'List the scheduled system routines in this workspace (git-sync, green-checkpoint, release-trigger, improvement-watchdog, …): name, install slug, cron, target role, active flag, next/last fire, group. Read-only. Pass `group` to filter to one routine group, or `rollup:true` for a per-group aggregate view instead of raw rows (WI-5018 — the routines table is unbounded, so a flat list stops scaling; group first).',
  capability: 'operator:read',
  guidance: {
    when: 'See the system routines and their cadence/active state before retuning or pausing one (e.g. inspect the git-sync / green-checkpoint / release-trigger schedule). Pass rollup:true for a per-group count/active/last-fire summary instead of scrolling hundreds of raw rows.',
    notWhen: 'To CHANGE a routine, use routines:set. For a harness blueprint autoloop, use autoloop:status. To manage group metadata or bulk pause/resume a group, use routines:group-set (also routines:list { rollup:true } for the group view).',
    chaining: 'routines:set to retune or pause a routine you find here (use its exact name + installSlug). routines:list { rollup:true } for group metadata + review-due status.',
    seeAlso: [
      'routines:set (retune / pause a routine)',
      'routines:list (rollup:true — group metadata + review-due rollup)',
      'routines:group-set (bulk pause/resume a whole group)',
      'autoloop:status (a harness blueprint autoloop instead)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 60 } },
  args: z.object({
    installSlug: z.string().max(120).optional().describe('Filter to one install slug.'),
    name: z.string().max(200).optional().describe('Filter to one routine name.'),
    q: z
      .string()
      .max(200)
      .optional()
      .describe('Free-text filter — case-insensitive substring match against name OR install slug.'),
    group: z
      .string()
      .max(120)
      .optional()
      .describe('Filter to one routine group slug (WI-5018). Pass "" (empty string) to see UNGROUPED routines only.'),
    rollup: z
      .boolean()
      .optional()
      .describe('Return a per-group aggregate (count, active/inactive, most-recent last-fire) instead of raw rows. Ignores installSlug/name/q; group still narrows to one group.'),
  }),
  // context-trimming-tiers P-023: rows are already lean scalars — trimmed just
  // drops the two rarely-read columns and caps rows with a loud notice row
  // (count keeps the true total). standard falls through to full.
  shape: {
    trimmed: (data) => {
      const d = data as { count?: number; routines?: unknown[]; rollup?: unknown[] } | null;
      if (!d) return data;
      if (Array.isArray(d.rollup)) return data; // rollup output is already a small aggregate — no trimming needed
      if (!Array.isArray(d.routines)) return data;
      const CAP = 60;
      const rows = d.routines.slice(0, CAP).map((row) => {
        const r = (row ?? {}) as Record<string, unknown>;
        return {
          installSlug: r.installSlug ?? null,
          name: r.name ?? null,
          cron: r.cron ?? null,
          active: r.active === true,
          nextFireAt: r.nextFireAt ?? null,
          group: r.group ?? null,
        };
      });
      if (d.routines.length > CAP) {
        rows.push({
          installSlug: '(truncated)',
          name: `showing ${CAP} of ${d.routines.length} — narrow with installSlug/name/group, rollup:true, or payloadTier:"full"`,
          cron: null,
          active: false,
          nextFireAt: null,
          group: null,
        });
      }
      return { count: d.count ?? d.routines.length, routines: rows };
    },
  },
  async handler(args) {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const iso = (d: Date | null): string | null =>
      d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString() : null;

    // group:"" means "ungrouped only" (group_slug IS NULL); group:undefined means "no filter".
    const groupFilterActive = args.group !== undefined;
    const groupIsNull = args.group === '';
    const groupVal = groupIsNull ? null : (args.group ?? null);

    if (args.rollup) {
      const rows = await sql<
        Array<{
          group_slug: string | null;
          description: string | null;
          steward: string | null;
          review_cadence: string | null;
          last_reviewed_at: Date | null;
          count: string;
          active_count: string;
          most_recent_fire: Date | null;
        }>
      >`
        SELECT r.group_slug,
               g.description,
               g.steward,
               g.review_cadence,
               g.last_reviewed_at,
               count(*)::text AS count,
               count(*) FILTER (WHERE r.active)::text AS active_count,
               max(r.last_fired_at) AS most_recent_fire
          FROM harness_shared.routines r
          LEFT JOIN harness_shared.routine_groups g
            ON g.workspace_id = r.workspace_id AND g.slug = r.group_slug
         WHERE r.workspace_id = ${ws}
           AND (NOT ${groupFilterActive}::boolean OR (${groupIsNull}::boolean AND r.group_slug IS NULL) OR r.group_slug = ${groupVal})
         GROUP BY r.group_slug, g.description, g.steward, g.review_cadence, g.last_reviewed_at
         ORDER BY r.group_slug NULLS LAST`;
      const rollup = rows.map((r) => {
        const reviewDue = (() => {
          if (!r.review_cadence || !r.last_reviewed_at) return null;
          const m = /^(\d+)d$/.exec(r.review_cadence.trim());
          if (!m) return null;
          const dueAt = new Date(r.last_reviewed_at).getTime() + Number(m[1]) * 86_400_000;
          return dueAt < Date.now();
        })();
        return {
          group: r.group_slug,
          description: r.description,
          steward: r.steward,
          reviewCadence: r.review_cadence,
          lastReviewedAt: iso(r.last_reviewed_at),
          reviewDue,
          count: Number(r.count),
          activeCount: Number(r.active_count),
          inactiveCount: Number(r.count) - Number(r.active_count),
          mostRecentFire: iso(r.most_recent_fire),
        };
      });
      return { data: { count: rollup.length, rollup } };
    }

    const slug = args.installSlug ?? null;
    const name = args.name ?? null;
    const q = args.q ?? null;
    const qLike = q ? `%${q}%` : null;
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
        group_slug: string | null;
      }>
    >`
      SELECT install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, last_fired_at, group_slug
        FROM harness_shared.routines
       WHERE workspace_id = ${ws}
         AND (${slug}::text IS NULL OR install_slug = ${slug})
         AND (${name}::text IS NULL OR name = ${name})
         AND (${qLike}::text IS NULL OR name ILIKE ${qLike} OR install_slug ILIKE ${qLike})
         AND (NOT ${groupFilterActive}::boolean OR (${groupIsNull}::boolean AND group_slug IS NULL) OR group_slug = ${groupVal})
       ORDER BY install_slug, name`;
    const routines = rows.map((r) => ({
      installSlug: r.install_slug,
      name: r.name,
      triggerKind: r.trigger_kind,
      cron: (r.trigger_config as { cron?: string } | null)?.cron ?? null,
      targetRole: r.target_role,
      active: r.active,
      nextFireAt: iso(r.next_fire_at),
      lastFiredAt: iso(r.last_fired_at),
      group: r.group_slug,
    }));
    // {data} envelope so the payload-tier shaper applies.
    return { data: { count: routines.length, routines } };
  },
});

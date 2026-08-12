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

/**
 * The DELIBERATE-PAUSE record, read back out of `routines.metadata.pause`.
 *
 * EI-19336000265007219. `routines:set` has recorded { reason, pausedBy, pausedAtMs }
 * on every pause since EI-18654017982759582 — which existed precisely because "a
 * routine paused during an incident with no reason/owner recorded has TWICE stayed
 * silently paused for days ... nothing durable said WHO paused it or WHY, so a
 * responder could not tell a stuck bug from a deliberate hold".
 *
 * The write side landed. The READ side never did: this tool selected `active` and not
 * `metadata`, so the responder the record was written FOR still saw a bare
 * `active:false` — indistinguishable from a stall. It happened a third time
 * (improvement-implement, paused 2026-07-28T03:40Z via the Agents pane, noticed 5 days
 * later and filed as a suspected stall by an agent who correctly hedged "may be an
 * intentional pause ... not obviously documented anywhere I found"). The answer was
 * sitting in the same ROW they had queried, one column over.
 *
 * A durable record nobody can read is not a fix — it is the same silence with better
 * bookkeeping. Hence: surfaced here, and in the TRIMMED projection, which is what an
 * agent sees by default.
 */
function pauseOf(
  metadata: Record<string, unknown> | null,
): { reason: string | null; by: string | null; at: string | null } | null {
  const p = metadata?.pause;
  if (!p || typeof p !== 'object') return null;
  const rec = p as Record<string, unknown>;
  const atMs = typeof rec.pausedAtMs === 'number' ? rec.pausedAtMs : null;
  return {
    reason: typeof rec.reason === 'string' ? rec.reason : null,
    by: typeof rec.pausedBy === 'string' ? rec.pausedBy : null,
    at: atMs !== null && Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
  };
}

/**
 * The OPERATIONAL half of `routines.metadata` — read back out for the same
 * reason {@link pauseOf} exists, one field family over
 * (plan `sql-escape-tool-routing-2026-08-12`, P-002).
 *
 * ⚠ THIS IS THE THIRD TIME. Read {@link pauseOf}'s comment first: it was
 * written because this tool SELECTed `metadata` and projected none of it, so a
 * responder saw a bare `active:false` and could not tell a deliberate hold from
 * a stall — "a durable record nobody can read is not a fix". That fix surfaced
 * `metadata.pause` and stopped there, and `metadata.gate_health` then reproduced
 * the identical failure at scale.
 *
 * Measured 2026-08-12 (`harness_shared.tool_invocations`, 14d, workspace
 * `papercusp-workspace`): 112 distinct agents hand-wrote
 * `SELECT metadata->'gate_health'…FROM harness_shared.routines` — 722 calls,
 * the single largest cross-agent raw-SQL cluster in the whole audit. Every one
 * of them was querying a row THIS TOOL ALREADY FETCHES. Several variants guess
 * at the column name (`next_fire_at` / `next_run_at` / `next_due_at`), which is
 * what reverse-engineering a schema looks like from the outside.
 *
 * So this projects the family, not one more single field — a per-field fix here
 * is what guarantees a fourth instance. `gate_health` is the load-bearing one
 * (green-checkpoint's live verdict: in-flight retriage, observed candidate,
 * consecutive reds); the rest are the generic routine-health signals every
 * `routines` row can carry.
 *
 * Returns null when the row carries none of them, so an ordinary routine's
 * payload is unchanged and the field stays cheap on the trimmed projection.
 */
function healthOf(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const OPERATIONAL_KEYS = [
    'gate_health',
    'last_status',
    'last_error',
    'last_errors',
    'consecutive_error_ticks',
    'consecutive_content_error_ticks',
    'fire_count',
    'armed_at',
    'fire_started_at',
    'last_synced_at',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of OPERATIONAL_KEYS) {
    if (metadata[k] !== undefined && metadata[k] !== null) out[k] = metadata[k];
  }
  return Object.keys(out).length ? out : null;
}

export default defineTool({
  name: 'routines:list',
  profile: 'engineer',
  description:
    'List the scheduled system routines in this workspace (git-sync, green-checkpoint, release-trigger, improvement-watchdog, …): name, install slug, cron, target role, active flag, next/last fire, group, and `paused` — the deliberate-pause record { reason, by, at } when one exists, so a deliberate hold is distinguishable from a stall. Read-only. Pass `group` to filter to one routine group, or `rollup:true` for a per-group aggregate (count/active/pausedCount/last-fire) instead of raw rows (WI-5018 — the routines table is unbounded, so a flat list stops scaling; group first).',
  capability: 'operator:read',
  guidance: {
    when: 'See the system routines and their cadence/active state before retuning or pausing one (e.g. inspect the git-sync / green-checkpoint / release-trigger schedule). Pass rollup:true for a per-group count/active/last-fire summary instead of scrolling hundreds of raw rows. Investigating a routine that has not fired? Read `paused` BEFORE concluding it is stalled: non-null means someone deliberately paused it and it carries { reason, by, at }. A bare active:false with paused:null is the one that warrants investigation.',
    notWhen: 'To CHANGE a routine, use routines:set. For a harness blueprint autoloop, use autoloop:status. To manage group metadata or bulk pause/resume a group, use routines:group-set (also routines:list { rollup:true } for the group view).',
    chaining: 'routines:set to retune or pause a routine you find here (use its exact name + installSlug). routines:list { rollup:true } for group metadata + review-due status.',
    // P-002: response documentation lives HERE, not in `when`/`description` —
    // those are prompt-weight budgeted and this tool is already near the cap
    // (the budget guard refused the first attempt to put it in `when`).
    returns: [
      'Each row: { installSlug, name, triggerKind, cron, targetRole, active, nextFireAt, lastFiredAt, group, paused, health }.',
      '`paused` — non-null means a DELIBERATE hold, carrying { reason, by, at }. Read it before calling a routine stalled; a bare active:false with paused:null is the one worth investigating.',
      '`health` — the operational half of the routine row, null when the row carries none of it. Includes `gate_health` on the green-checkpoint routine (the live in-flight-retriage marker, observed candidate and consecutive-red count), plus last_status / last_error / consecutive_error_ticks / fire_count / armed_at where present.',
      'THIS IS THE GATE-HEALTH READ: `health.gate_health` is what 112 agents were hand-writing `SELECT metadata->\'gate_health\' FROM harness_shared.routines` for. No raw SQL needed. For the deploy-position question ("is my change live, what is blocking it") use dev:pipeline_position instead — different question.',
    ].join(' '),
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
          // EI-19336000265007219: kept in the TRIMMED tier deliberately. A bare
          // `active:false` is exactly what makes a deliberate hold read as a stall, and
          // trimmed is the tier an agent sees by default — dropping `paused` here would
          // reinstate the whole bug for every default call.
          paused: r.paused ?? null,
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
          paused: null,
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
          paused_count: string;
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
               -- EI-19336000265007219: split the INACTIVE population. "Deliberately
               -- paused (has a metadata.pause record)" and "inactive with no pause
               -- record" (never-armed, one-shot spent, or genuinely dropped) are
               -- different conditions that a single inactiveCount fuses into one
               -- number — which is what sends a responder to raw SQL. Measured here
               -- 2026-08-02: 128 active / 19 paused / 129 inactive-no-record.
               count(*) FILTER (WHERE NOT r.active AND r.metadata ? 'pause')::text AS paused_count,
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
          /** Of `inactiveCount`, how many were DELIBERATELY paused (carry a
           *  metadata.pause record). The remainder are inactive with no recorded
           *  reason — never-armed, spent one-shots, or genuinely dropped. */
          pausedCount: Number(r.paused_count),
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
        metadata: Record<string, unknown> | null;
      }>
    >`
      SELECT install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, last_fired_at, group_slug, metadata
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
      paused: pauseOf(r.metadata),
      health: healthOf(r.metadata),
    }));
    // {data} envelope so the payload-tier shaper applies.
    return { data: { count: routines.length, routines } };
  },
});

/**
 * GET /api/harness/all/kpis
 *
 * Cross-harness KPIs: project-level + harness-level + message-bus + auditing.
 * Operator-local read; no auth (matches /api/harness/projects posture).
 *
 * Response shape:
 *   {
 *     totals: { harnesses, projects, projects_by_status, messages_24h, executed_actions_24h },
 *     parents: [ { slug, children_count, children_by_status, messages_inbound, messages_outbound, ... } ],
 *     directives: { open, completed, failed },
 *     audit: { actions_24h_by_op: { send_message: N, ... } },
 *     autoloop: { harnesses_active, last_fires: [...] }
 *   }
 *
 * Suitable as data source for any KPI dashboard UI a future spec ships.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { routeWithWorkspace } from '@/lib/route-workspace';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  // Workspace-scoped reads: only this workspace's projects + per-harness
  // schemas are visible.
  const [schemas, projTotals] = await routeWithWorkspace(async (tx) => {
    const sch = await tx<{ nspname: string }[]>`
      SELECT 'harness_' || REPLACE(slug, '-', '_') AS nspname
        FROM harness_shared.projects WHERE slug IS NOT NULL
    `;
    const pt = await tx<{ status: string; n: number }[]>`
      SELECT status, count(*)::int AS n FROM harness_shared.projects GROUP BY status
    `;
    return [sch, pt] as const;
  });

  // Admin client for per-schema scans (per-harness schemas are scoped by name).
  const { sql } = getOrgPg();
  const projectsByStatus: Record<string, number> = {};
  let projectsTotal = 0;
  for (const r of projTotals) {
    projectsByStatus[r.status] = r.n;
    projectsTotal += r.n;
  }

  let messages24h = 0;
  let executedActions24h = 0;
  const opCounts24h: Record<string, number> = {};
  let directiveOpen = 0, directiveAcked = 0;

  // ── Per-schema metrics (batched) ───────────────────────────────────
  // Was: 3N sequential queries (messages-count, executed-actions GROUP BY,
  // directives GROUP BY) inside a for-loop over every harness schema. With
  // ~10 schemas that's 30 round-trips. Diagnostic 2026-05-06 measured
  // /api/harness/all/kpis at 5.5s steady-state on dev (got worse on
  // repeat hits under paperclip contention).
  //
  // Now: 1 information_schema scan to pick surviving schemas, then 3
  // UNION ALL queries — one per metric type — regardless of N. Missing
  // tables are filtered upstream so the UNION can't trip on absent
  // relations the way the prior per-schema try-catch handled.
  if (schemas.length > 0) {
    const schemaNames = schemas.map((s) => s.nspname);
    type TablePresence = { table_schema: string; table_name: string };
    const presence = await sql<TablePresence[]>`
      SELECT table_schema, table_name
        FROM information_schema.tables
       WHERE table_schema = ANY(${schemaNames})
         AND table_name IN ('messages', 'executed_actions')
    `;
    const hasMessages = new Set(
      presence.filter((r) => r.table_name === 'messages').map((r) => r.table_schema),
    );
    const hasExecutedActions = new Set(
      presence.filter((r) => r.table_name === 'executed_actions').map((r) => r.table_schema),
    );

    // Schema names come from harness_shared.projects.slug → 'harness_'+slug,
    // and slug is constrained to [a-z0-9_-]+ (verified by harness-registry).
    // The REPLACE(slug, '-', '_') in `schemas` SELECT keeps them safe.
    // Still: assert before interpolation as belt-and-suspenders.
    const SAFE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const messagesSchemas = [...hasMessages].filter((s) => SAFE_RE.test(s));
    const executedActionsSchemas = [...hasExecutedActions].filter((s) => SAFE_RE.test(s));

    // Q1: messages-24h count, summed across all schemas.
    if (messagesSchemas.length > 0) {
      const sqlText = messagesSchemas
        .map(
          (n) =>
            `SELECT count(*)::int AS n FROM ${n}.messages WHERE created_at > now() - interval '24 hours'`,
        )
        .join(' UNION ALL ');
      try {
        const r = await sql.unsafe(`SELECT sum(n)::int AS total FROM (${sqlText}) t`);
        messages24h = (r as any)[0]?.total ?? 0;
      } catch { /* whole query failed — leave as 0 */ }
    }

    // Q2: executed_actions-24h GROUP BY op, summed across schemas.
    if (executedActionsSchemas.length > 0) {
      const sqlText = executedActionsSchemas
        .map(
          (n) =>
            `SELECT op, count(*)::int AS n FROM ${n}.executed_actions WHERE executed_at > now() - interval '24 hours' GROUP BY op`,
        )
        .join(' UNION ALL ');
      try {
        const r = await sql.unsafe(
          `SELECT op, sum(n)::int AS n FROM (${sqlText}) t GROUP BY op`,
        );
        for (const row of r as any[]) {
          executedActions24h += row.n;
          opCounts24h[row.op] = (opCounts24h[row.op] ?? 0) + row.n;
        }
      } catch { /* skip */ }
    }

    // Q3: Directive-kind messages by status, summed across schemas.
    if (messagesSchemas.length > 0) {
      const sqlText = messagesSchemas
        .map(
          (n) =>
            `SELECT status, count(*)::int AS n FROM ${n}.messages WHERE kind = 'Directive' GROUP BY status`,
        )
        .join(' UNION ALL ');
      try {
        const r = await sql.unsafe(
          `SELECT status, sum(n)::int AS n FROM (${sqlText}) t GROUP BY status`,
        );
        for (const row of r as any[]) {
          if (row.status === 'pending') directiveOpen += row.n;
          else directiveAcked += row.n;
        }
      } catch { /* skip */ }
    }
  }

  // ── Parent harnesses (those with at least one child via parent_slug) ──
  // Workspace-scoped read.
  const parents = await routeWithWorkspace(async (tx) => {
    return await tx<{ slug: string; children: number }[]>`
      SELECT parent_slug AS slug, count(*)::int AS children
        FROM harness_shared.projects
       WHERE parent_slug IS NOT NULL
       GROUP BY parent_slug
       ORDER BY children DESC
    `;
  });
  const parentsDetail = parents.map((p) => ({
    slug: p.slug,
    children_count: p.children,
  }));

  // ── AutoLoop summary ────────────────────────────────────────────────
  let autoloopActive = 0;
  let lastFires: { harness_slug: string; role: string; last_fired_at: string; last_status: string | null; consecutive_errors: number }[] = [];
  try {
    const a = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'harness_shared' AND table_name = 'autoloop_state') AS exists
    `;
    if (a[0]?.exists) {
      const rows = await sql<any[]>`
        SELECT harness_slug, role,
               to_char(last_fired_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS last_fired_at,
               last_status, consecutive_errors
        FROM harness_shared.autoloop_state
        ORDER BY last_fired_at DESC
        LIMIT 20
      `;
      lastFires = rows;
      autoloopActive = rows.filter((r) => r.last_status === 'ok' || r.last_status === 'firing').length;
    }
  } catch { /* skip */ }

  return NextResponse.json(
    {
      totals: {
        harnesses: schemas.length,
        projects: projectsTotal,
        projects_by_status: projectsByStatus,
        messages_24h: messages24h,
        executed_actions_24h: executedActions24h,
      },
      parents: parentsDetail,
      directives: { open: directiveOpen, acknowledged: directiveAcked },
      audit: { actions_24h_by_op: opCounts24h },
      autoloop: { active: autoloopActive, recent_fires: lastFires },
    },
    {
      // KPI dashboards aren't real-time; 10s of staleness is fine and
      // collapses dashboard polling traffic to one full query per window.
      headers: { 'Cache-Control': 'private, max-age=10' },
    },
  );
}

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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { sql } = getOrgPg();

  // Schemas for per-harness queries.
  const schemas = await sql<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'harness\\_%' AND nspname <> 'harness_shared'
  `;

  // ── Totals ─────────────────────────────────────────────────────────
  const projTotals = await sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n FROM harness_shared.projects GROUP BY status
  `;
  const projectsByStatus: Record<string, number> = {};
  let projectsTotal = 0;
  for (const r of projTotals) {
    projectsByStatus[r.status] = r.n;
    projectsTotal += r.n;
  }

  let messages24h = 0;
  let executedActions24h = 0;
  const opCounts24h: Record<string, number> = {};

  for (const { nspname } of schemas) {
    try {
      const r = await sql.unsafe(
        `SELECT count(*)::int AS n FROM ${nspname}.messages WHERE created_at > now() - interval '24 hours'`,
      );
      messages24h += (r as any)[0]?.n ?? 0;
    } catch { /* skip */ }

    try {
      const r = await sql.unsafe(
        `SELECT op, count(*)::int AS n FROM ${nspname}.executed_actions
         WHERE executed_at > now() - interval '24 hours' GROUP BY op`,
      );
      for (const row of r as any[]) {
        executedActions24h += row.n;
        opCounts24h[row.op] = (opCounts24h[row.op] ?? 0) + row.n;
      }
    } catch { /* skip */ }
  }

  // ── Parent harnesses (those with at least one child via parent_slug) ──
  const parents = await sql<{ slug: string; children: number }[]>`
    SELECT parent_slug AS slug, count(*)::int AS children
    FROM harness_shared.projects
    WHERE parent_slug IS NOT NULL
    GROUP BY parent_slug
    ORDER BY children DESC
  `;
  const parentsDetail = parents.map((p) => ({
    slug: p.slug,
    children_count: p.children,
  }));

  // ── Directives (best-effort: count Directive-kind messages by status) ──
  let directiveOpen = 0, directiveAcked = 0;
  for (const { nspname } of schemas) {
    try {
      const r = await sql.unsafe(
        `SELECT status, count(*)::int AS n FROM ${nspname}.messages WHERE kind = 'Directive' GROUP BY status`,
      );
      for (const row of r as any[]) {
        if (row.status === 'pending') directiveOpen += row.n;
        else directiveAcked += row.n;
      }
    } catch { /* skip */ }
  }

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

  return NextResponse.json({
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
  });
}

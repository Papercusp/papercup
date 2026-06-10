/**
 * GET /api/harness/all/kpis — cross-harness KPI dashboard data.
 *
 * Batched per-schema metrics + parent/child counts + autoloop summary.
 * Cached 10s by default (KPI dashboards aren't real-time).
 *
 * Ported from app/api/harness/all/kpis/route.ts. `auth: 'public'`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { routeWithWorkspace } from '../../../route-workspace';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/harness/all/kpis',
  auth: 'public',
  async handler() {
    // Harness totals + per-schema metrics derive from the LIVE installed-harness
    // registry (workspace PG, same source as /api/installed) — NOT the legacy
    // harness_shared.projects pots table, which only holds pre-rethink demo rows
    // and made every total render 0 (EI-220).
    const [registryProjects, projTotals] = await routeWithWorkspace(async (tx) => {
      const reg = await loadHarnessRegistry();
      const pt = await tx<{ status: string; n: number }[]>`
        SELECT status, count(*)::int AS n FROM harness_shared.projects GROUP BY status
      `;
      return [reg.projects, pt] as const;
    });
    const schemas = registryProjects
      .filter((p) => typeof p.slug === 'string' && p.slug.length > 0)
      .map((p) => ({ nspname: 'harness_' + p.slug.replace(/-/g, '_') }));

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

      const SAFE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
      const messagesSchemas = [...hasMessages].filter((s) => SAFE_RE.test(s));
      const executedActionsSchemas = [...hasExecutedActions].filter((s) => SAFE_RE.test(s));

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
        } catch { /* skip */ }
      }

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

    const body = {
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
    };
    return new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        'Cache-Control': 'private, max-age=10',
      },
    });
  },
});

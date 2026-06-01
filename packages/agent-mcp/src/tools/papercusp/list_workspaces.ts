/**
 * papercusp:list_workspaces — discovery helper for shell-launched OMP
 * agents in superuser mode.
 *
 * Returns every workspace the user has, plus its harnesses. Agents call
 * this to pick a `workspace=` arg for subsequent calls (since superuser
 * URLs don't bake in a workspace).
 *
 * Available to all roles via the standard tool surface, but most useful
 * when called from `?superuser=1` shells.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';

export default defineTool({
  name: 'papercusp:list_workspaces',
  profile: 'engineer',
  // Role-gated (not principal-gated) so crossWorkspace forwards through
  // registerRoleGatedAsProjected — defineTool routes on requirePrincipal===false.
  requirePrincipal: false,
  // P-062 Phase 4: enumerates EVERY workspace's harness_registry row — a
  // workspace-scoped RLS tx would hide all but the caller's own. Must run
  // on the admin (rolbypassrls) handle.
  crossWorkspace: true,
  guidance: {
    when: 'Discovery helper for superuser shells — list all workspaces in the installation. Used when scope-switching.',
    notWhen: 'For the CURRENT workspace details, use the operator-state APIs. papercusp:list_workspaces is the cross-workspace enumerator.',
  },
  capability: 'workspaces:read',
  args: z.object({}).strict(),
  async handler(_args, ctx) {
    const sql = ctx.tx;
    if (!sql) {
      return {
        data: { workspaces: [] as Array<{ slug: string; harnesses: string[]; lastActiveTs: number }>, defaultWorkspace: null },
        degraded: true,
        degradedReasons: ['list_workspaces requires a DB handle (admin via crossWorkspace)'],
      };
    }
    // int8/BIGINT comes back from postgres-js as a string, so last_active_ts is widened.
    interface Row { workspace_id: string; harness_slug: string | null; last_active_ts: string | number | null }
    // harness_registry is ONE JSONB-blob row per workspace
    // (workspace_id PK, payload JSONB, updated_at BIGINT — see migration 025);
    // the harnesses live in payload.projects[].slug. There is no harness_slug
    // column here (that's on harness_feature_notes), and updated_at is already
    // epoch-ms, not a timestamp. LEFT JOIN LATERAL so a workspace with zero
    // registered harnesses still shows up.
    const rows = await sql<Row[]>`
      SELECT r.workspace_id,
             p->>'slug'   AS harness_slug,
             r.updated_at AS last_active_ts
      FROM harness_shared.harness_registry r
      LEFT JOIN LATERAL jsonb_array_elements(COALESCE(r.payload->'projects', '[]'::jsonb)) AS p ON true
      ORDER BY r.workspace_id, harness_slug
    `;
    const buckets = new Map<string, { harnesses: string[]; lastActiveTs: number }>();
    for (const r of rows) {
      const b = buckets.get(r.workspace_id) ?? { harnesses: [], lastActiveTs: 0 };
      if (r.harness_slug) b.harnesses.push(r.harness_slug);
      const ts = Number(r.last_active_ts ?? 0); // int8 arrives as a string from postgres-js
      if (ts > b.lastActiveTs) b.lastActiveTs = ts;
      buckets.set(r.workspace_id, b);
    }
    const workspaces = Array.from(buckets.entries())
      .map(([slug, b]) => ({ slug, harnesses: b.harnesses, lastActiveTs: b.lastActiveTs }))
      .sort((a, b) => b.lastActiveTs - a.lastActiveTs);
    return {
      data: {
        workspaces,
        defaultWorkspace: workspaces.find((w) => w.slug === 'default')?.slug ?? workspaces[0]?.slug ?? null,
      },
    };
  },
});

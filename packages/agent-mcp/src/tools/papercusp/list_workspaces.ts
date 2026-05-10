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
import { defineTool } from '../../define-tool';

export default defineTool({
  name: 'papercusp:list_workspaces',
  capability: 'workspaces:read',
  args: z.object({}).strict(),
  async handler(_args, ctx) {
    const sql = ctx.tx;
    if (!sql) {
      return {
        ok: false,
        error: { code: 'no_tx', message: 'list_workspaces requires a workspace tx (read-only via harness_app role)' },
      };
    }
    interface Row { workspace_id: string; harness_slug: string; last_active_ts: number | null }
    const rows = await sql<Row[]>`
      SELECT workspace_id, harness_slug, EXTRACT(EPOCH FROM updated_at)::bigint * 1000 AS last_active_ts
      FROM harness_shared.harness_registry
      ORDER BY workspace_id, harness_slug
    `;
    const buckets = new Map<string, { harnesses: string[]; lastActiveTs: number }>();
    for (const r of rows) {
      const b = buckets.get(r.workspace_id) ?? { harnesses: [], lastActiveTs: 0 };
      b.harnesses.push(r.harness_slug);
      if ((r.last_active_ts ?? 0) > b.lastActiveTs) b.lastActiveTs = r.last_active_ts ?? 0;
      buckets.set(r.workspace_id, b);
    }
    const workspaces = Array.from(buckets.entries())
      .map(([slug, b]) => ({ slug, harnesses: b.harnesses, lastActiveTs: b.lastActiveTs }))
      .sort((a, b) => b.lastActiveTs - a.lastActiveTs);
    return {
      ok: true,
      response: {
        data: {
          workspaces,
          defaultWorkspace: workspaces.find((w) => w.slug === 'default')?.slug ?? workspaces[0]?.slug ?? null,
        },
      },
    };
  },
});

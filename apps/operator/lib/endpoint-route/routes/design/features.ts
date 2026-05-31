/**
 * GET /api/design/features?harness=<slug>&workspace=<id>
 *
 * Lists features with needs_design=true from harness_shared.
 * harness_features_consolidated. Bypasses Zero (the design columns
 * aren't in the publication yet) — reads PG directly.
 *
 * Ported from app/api/design/features/route.ts. `auth: 'public'` —
 * gateApiRoute(FLAGS.DESIGN) is the actual gate.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/design/features',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.DESIGN);
    if (blocked) return blocked;
    const url = new URL(req.url);
    const slug = url.searchParams.get('harness') ?? '';
    const workspace = url.searchParams.get('workspace') ?? 'default';
    if (!slug) {
      return Response.json({ ok: false, error: 'harness query param required' }, { status: 400 });
    }
    try {
      const { sql } = getOrgPg();
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspace]);
        return await tx`
          SELECT
            feature_id, title, summary, status, needs_design,
            design_status, design_spec_id, discarded_design_work, updated_ts
          FROM harness_shared.harness_features_consolidated
          WHERE harness_slug = ${slug} AND needs_design = TRUE
          ORDER BY updated_ts DESC NULLS LAST
          LIMIT 500
        `;
      });
      return Response.json({
        ok: true,
        features: rows.map((r) => ({
          featureId: r.feature_id,
          title: r.title,
          summary: r.summary,
          status: r.status,
          needsDesign: r.needs_design,
          designStatus: r.design_status,
          designSpecId: r.design_spec_id,
          discardedDesignWork: r.discarded_design_work,
          updatedTs: r.updated_ts == null ? null : Number(r.updated_ts),
        })),
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: 'pg_error', detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});

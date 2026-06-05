/**
 * PATCH /api/admin/llm-tests/findings/:id — toggle a finding's
 * `acknowledged` flag.
 *
 * Ported from app/api/admin/llm-tests/findings/[id]/route.ts.
 * `auth: 'public'`. Next `[id]` → Hono `:id` (read from `ctx.params`).
 */
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../../../embedded-pg-discovery';
import { defineTool } from '@papercusp/agent-mcp';

let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) pool = postgres(getHarnessAdminUrl(), { max: 4, prepare: false });
  return pool;
}

export default defineTool({
  method: 'PATCH',
  path: '/admin/llm-tests/findings/:id',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req, ctx) {
    const { id } = ctx.params;
    let body: { acknowledged?: boolean; acknowledgedBy?: string } = {};
    try {
      body = (await req.json()) ?? {};
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }
    if (typeof body.acknowledged !== 'boolean') {
      return Response.json({ error: 'acknowledged: boolean required' }, { status: 400 });
    }

    const sql = db();
    const rows = await sql<Array<{ id: string }>>`
      UPDATE harness_shared.llm_test_findings
      SET acknowledged = ${body.acknowledged},
          acknowledged_by = ${body.acknowledged ? (body.acknowledgedBy ?? null) : null},
          acknowledged_at = ${body.acknowledged ? sql`now()` : null}
      WHERE id = ${id}
      RETURNING id
    `;
    if (rows.length === 0) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json({ ok: true });
  },
});

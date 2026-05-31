/**
 * GET /api/operator/budget-tiers
 *
 * Preset daily-budget tiers shown in the first-run Operator picker.
 * Idempotent table-ensure + floor defaults if empty.
 *
 * Ported from app/api/operator/budget-tiers/route.ts. `auth: 'public'`.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { asc } from 'drizzle-orm';
import { defineTool } from '@papercusp/agent-mcp';

const bt = generated.operatorBudgetTiersInHarnessShared;

export default defineTool({
  method: 'GET',
  path: '/operator/budget-tiers',
  auth: 'public',
  async handler() {
    try {
      const { db, sql } = getOrgPg();
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS harness_shared.operator_budget_tiers (
          ord INT NOT NULL,
          label TEXT NOT NULL,
          cap_usd NUMERIC(10, 2) NOT NULL,
          blurb TEXT NOT NULL,
          PRIMARY KEY (ord)
        )
      `);
      const rows = await db
        .select({ ord: bt.ord, label: bt.label, cap_usd: bt.capUsd, blurb: bt.blurb })
        .from(bt)
        .orderBy(asc(bt.ord));
      const tiers = rows.map((r) => ({
        label: r.label,
        cap: Number(r.cap_usd),
        blurb: r.blurb,
      }));
      if (tiers.length === 0) {
        return Response.json({
          tiers: [
            { label: 'Light',  cap: 5,  blurb: '~50 scans/day with default model' },
            { label: 'Active', cap: 20, blurb: 'recommended for daily use' },
            { label: 'Heavy',  cap: 50, blurb: 'large workspaces or always-on background' },
          ],
        });
      }
      return Response.json({ tiers });
    } catch (e: any) {
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  },
});

/**
 * GET /api/operator/budget-tiers — list of preset daily-budget tiers shown in
 * the first-run Operator picker. Backed by harness_shared.operator_budget_tiers
 * (Migration 037). Edit rows to adjust caps without a code change.
 */
import { NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { asc } from 'drizzle-orm';

const bt = generated.operator_budget_tiersInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TierRow {
  ord: number;
  label: string;
  cap_usd: string;   // postgres-js returns NUMERIC as string
  blurb: string;
}

export async function GET() {
  try {
    const { db, sql } = getOrgPg();
    // Idempotent ensure — keeps the route working even if the migration
    // hasn't been applied to a particular environment yet.
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
      .select({ ord: bt.ord, label: bt.label, cap_usd: bt.cap_usd, blurb: bt.blurb })
      .from(bt)
      .orderBy(asc(bt.ord));
    const tiers = rows.map((r) => ({
      label: r.label,
      cap: Number(r.cap_usd),
      blurb: r.blurb,
    }));
    // Floor: if the table is empty (e.g. fresh install pre-seed), return
    // the same defaults the migration seeds. The picker should never be empty.
    if (tiers.length === 0) {
      return NextResponse.json({
        tiers: [
          { label: 'Light',  cap: 5,  blurb: '~50 scans/day with default model' },
          { label: 'Active', cap: 20, blurb: 'recommended for daily use' },
          { label: 'Heavy',  cap: 50, blurb: 'large workspaces or always-on background' },
        ],
      });
    }
    return NextResponse.json({ tiers });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

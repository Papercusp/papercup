/**
 * GET /api/operator/settings/<key> — read one operator-wide setting from
 * harness_shared.operator_settings (Migration 038). 404 if the key isn't
 * present. Response: { key, value, description? }.
 *
 * Single home for per-deployment strings (URLs, default text). Edit rows
 * with SQL or a future admin UI; no code edit needed.
 */
import { NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { eq } from 'drizzle-orm';

const os = generated.operatorSettingsInHarnessShared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SettingRow { key: string; value: string; description: string | null }

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
    return NextResponse.json({ error: 'invalid key' }, { status: 400 });
  }
  try {
    const { db, sql } = getOrgPg();
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.operator_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at BIGINT NOT NULL DEFAULT 0
      )
    `);
    const rows = await db
      .select({ key: os.key, value: os.value, description: os.description })
      .from(os)
      .where(eq(os.key, key))
      .limit(1);
    if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(rows[0]);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

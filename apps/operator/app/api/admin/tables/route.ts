/**
 * GET /api/admin/tables — list registered admin tables (Unlock 3).
 *
 * Returns the editable subset of all 129 drizzle tables — only those
 * in the allowlist managed by `lib/admin-tables.ts`. The /admin UI
 * factory renders one tab per entry; plugins extend the list at boot.
 */
import { NextResponse } from 'next/server';
import { listAdminTables } from '@/lib/admin-tables';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const out = listAdminTables().map((e) => {
    const cfg = getTableConfig(e.table as unknown as PgTable);
    return {
      exportName: e.exportName,
      label: e.label,
      schema: cfg.schema,
      name: cfg.name,
      editableColumns: e.editableColumns ?? null,
      allowDelete: e.allowDelete ?? true,
    };
  });
  return NextResponse.json({ tables: out });
}

/**
 * GET /api/dev/tables/[exportName]/rows
 *
 * Paginated rows for a drizzle table. RLS-aware: uses `getOrgPg().db`
 * (admin role, RLS bypass) by default since this is the developer
 * console; pass `?role=app` to use the workspace-scoped app role
 * (rows are filtered by the active workspace's RLS policies).
 *
 * Query params:
 *   limit  — page size, default 50, max 500
 *   offset — pagination offset, default 0
 *   role   — 'admin' | 'app' (default 'admin')
 */
import { NextResponse } from 'next/server';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { is, Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getOrgPg, getOrgPgApp, generated, withWorkspaceQuery } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tableByExportName(exportName: string): PgTable | null {
  const value = (generated as Record<string, unknown>)[exportName];
  if (!value || typeof value !== 'object') return null;
  if (!is(value as object, Table)) return null;
  return value as PgTable;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ exportName: string }> },
) {
  const { exportName } = await params;
  const table = tableByExportName(exportName);
  if (!table) return NextResponse.json({ error: 'unknown table export' }, { status: 404 });
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? '0'), 0);
  const role = url.searchParams.get('role') === 'app' ? 'app' : 'admin';

  const cfg = getTableConfig(table);
  const qualified = cfg.schema ? `${cfg.schema}.${cfg.name}` : cfg.name;

  try {
    let rows: unknown[];
    let total: number | null = null;
    if (role === 'app') {
      const ws = activeWorkspaceId();
      const result = await withWorkspaceQuery(ws, async (tx) => {
        const txDb = drizzle(tx);
        const r = await txDb.select().from(table).limit(limit).offset(offset);
        const c = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM ${tx.unsafe(qualified)}`;
        return { rows: r, n: Number(c[0]?.n ?? '0') };
      });
      rows = result.rows;
      total = result.n;
    } else {
      const { db, sql } = getOrgPg();
      rows = await db.select().from(table).limit(limit).offset(offset);
      const c = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${sql.unsafe(qualified)}`;
      total = Number(c[0]?.n ?? '0');
    }

    // Best-effort serialization: bigints come back as numbers (mode:number),
    // jsonb already parsed, dates → ISO strings.
    const safeRows = rows.map((r) => {
      const obj = r as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v instanceof Date) out[k] = v.toISOString();
        else if (typeof v === 'bigint') out[k] = Number(v);
        else out[k] = v;
      }
      return out;
    });

    return NextResponse.json({
      rows: safeRows,
      total,
      limit,
      offset,
      role,
      qualifiedName: qualified,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, qualifiedName: qualified, role }, { status: 500 });
  }
}

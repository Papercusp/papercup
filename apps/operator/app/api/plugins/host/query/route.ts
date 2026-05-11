/**
 * POST /api/plugins/host/query — read-only PG query for iframe plugin
 * surfaces (Batch H4 reactive channel).
 *
 * v1 contract: queries run as the operator's harness role (read-only
 * RLS-enforced by PG). Plugin authors write SQL against their plugin's
 * own data interface tables; the SQL is parameterized only via the
 * plugin schema namespace, never via user-controlled string concat.
 *
 * Hardening for v1 (matches the rev3 plan's data-interface model):
 *   - SELECT only — anything else is rejected
 *   - The query is prefixed with SET LOCAL search_path = plugin_<name>
 *     so a missing schema qualifier hits the plugin's own tables.
 *   - LIMIT defaults to 1000 if not present in the query.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReqBody {
  pluginName: string;
  installSlug: string;
  query: string;
}

const SELECT_ONLY = /^\s*select\b/i;

export async function POST(req: Request): Promise<Response> {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ rows: [], error: 'invalid JSON' }, { status: 400 });
  }
  if (!body.pluginName || !body.installSlug || !body.query) {
    return NextResponse.json(
      { rows: [], error: 'pluginName, installSlug, query required' },
      { status: 400 },
    );
  }
  if (!SELECT_ONLY.test(body.query)) {
    return NextResponse.json(
      { rows: [], error: 'only SELECT queries are permitted via this endpoint' },
      { status: 400 },
    );
  }

  try {
    const { getOrgPg } = await import('@restart/db-org');
    const pg = await getOrgPg();
    // Prefix search_path so unqualified table refs hit the plugin's
    // own schema (sanitized to a strict identifier).
    const schema = `plugin_${body.pluginName.replace(/[^a-z0-9_]/gi, '_')}`;
    const limited = /\blimit\b/i.test(body.query) ? body.query : `${body.query.replace(/;\s*$/, '')} LIMIT 1000`;
    await pg.query(`SET LOCAL search_path = ${schema}, public`);
    const result = await pg.query(limited);
    return NextResponse.json({ rows: result.rows ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { rows: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

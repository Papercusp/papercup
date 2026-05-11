/**
 * POST /api/plugins/host/query — read-only PG query for iframe plugin
 * surfaces (Batch H4 reactive channel).
 *
 * v1 contract:
 *   - SELECT only (regex + statement-count check; multi-statement
 *     queries are rejected so attackers can't smuggle DELETEs).
 *   - search_path scoped to the plugin's schema inside a single
 *     transaction so SET LOCAL actually applies.
 *   - LIMIT auto-appended (default 1000) when missing.
 *
 * Future hardening (deferred): replace the regex/statement-count
 * gate with a real PG read-only role + cost-limited statement timeout.
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
/** Reject any unquoted `;` (anywhere except as a final terminator).
 * This is conservative — it'll reject string-literal semicolons too,
 * but plugin authors should `CHR(59)` if they truly need one in a
 * literal. The point is closing the multi-statement smuggling vector. */
function isMultiStatement(q: string): boolean {
  const stripped = q.trim().replace(/;\s*$/, '');
  return stripped.includes(';');
}
/** Identifier sanitizer for the plugin schema name (used in SET
 *  LOCAL search_path). Strict: only [a-z0-9_], lower-cased, plugin_
 *  prefix to avoid clashes with system schemas. */
function pluginSchema(pluginName: string): string {
  const safe = pluginName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
  return `plugin_${safe}`;
}

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
  if (isMultiStatement(body.query)) {
    return NextResponse.json(
      { rows: [], error: 'multi-statement queries are not permitted (semicolon found mid-query)' },
      { status: 400 },
    );
  }

  try {
    const { getOrgPg } = await import('@restart/db-org');
    const { sql } = getOrgPg();
    const schema = pluginSchema(body.pluginName);
    const limited = /\blimit\b/i.test(body.query)
      ? body.query.replace(/;\s*$/, '')
      : `${body.query.replace(/;\s*$/, '')} LIMIT 1000`;
    // Wrap SET LOCAL + SELECT in a single transaction so search_path
    // sticks. sql.unsafe() executes raw SQL; both calls go to the same
    // connection inside the tx callback.
    const rows = await sql.begin(async (tx: { unsafe: (q: string) => Promise<unknown[]> }) => {
      await tx.unsafe(`SET LOCAL search_path = ${schema}, public`);
      return tx.unsafe(limited);
    });
    return NextResponse.json({ rows: Array.isArray(rows) ? rows : [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { rows: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * REST query endpoint for the harness Zero. The polling transport in
 * @restart/sync calls this when zero-cache (WebSocket) isn't available —
 * notably in the desktop bundle, where pglite-server stands in for a real
 * Postgres but doesn't expose logical replication, so zero-cache can't
 * subscribe.
 *
 * Mirrors apps/shop-api/src/zero/zero.controller.ts `restQuery`: resolves
 * the named query through @restart/zero-harness's registry, feeds it to
 * Zero's postgres-js adapter (which compiles ZQL → SQL in-process), and
 * returns the rows directly. No replica file, no zero-cache, no WAL.
 *
 * GET /api/zero-harness/rest-query?name=<name>&args=<json>
 *  → { rows, version }
 *
 * `version` is currently a wall-clock millisecond stamp. Polling clients
 * may eventually use it to skip rendering when the response is identical
 * to the last; today it's just a freshness marker.
 */
import { NextResponse } from 'next/server';
import postgres from 'postgres';

import { schema, queries } from '@restart/zero-harness';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mustGetQuery } = require('@rocicorp/zero') as {
  mustGetQuery: (registry: any, name: string) => { fn: (ctx: any) => any };
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { zeroPostgresJS } = require('@rocicorp/zero/server/adapters/postgresjs') as {
  zeroPostgresJS: (schema: any, client: any) => { run: (q: any) => Promise<any[]> };
};

// Single shared client. postgres-js manages its own pool internally; reusing
// the client across requests avoids socket churn against pglite. The host
// override (PAPERCUSP_PGLITE_SOCKET_DIR) is read by libs/db/src/connection.ts
// already, but this route bypasses that helper because zeroPostgresJS wants
// the postgres-js client directly.
let _client: ReturnType<typeof postgres> | null = null;
let _provider: { run: (q: any) => Promise<any[]> } | null = null;

function getProvider() {
  if (_provider) return _provider;
  const url = process.env.HARNESS_ADMIN_DATABASE_URL
    ?? 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
  const sock = process.env.PAPERCUSP_PGLITE_SOCKET_DIR;
  _client = postgres(url, {
    max: Math.max(1, Number(process.env.PAPERCUSP_DB_POOL_MAX) || 4),
    idle_timeout: 30,
    onnotice: () => {},
    ...(sock ? { host: sock } : {}),
  });
  _provider = zeroPostgresJS(schema, _client);
  return _provider;
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const name = u.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'missing name' }, { status: 400 });
  }
  const argsJson = u.searchParams.get('args') ?? '{}';
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return NextResponse.json({ error: 'invalid args (not JSON)' }, { status: 400 });
  }
  try {
    const query = mustGetQuery(queries, name);
    const expr = query.fn({ args, ctx: {} });
    const provider = getProvider();
    const rows = await provider.run(expr);
    return NextResponse.json({ rows: Array.isArray(rows) ? rows : [], version: String(Date.now()) });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return NextResponse.json({ error: msg, name }, { status: 500 });
  }
}

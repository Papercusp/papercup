/**
 * REST query endpoint for the harness sync layer.
 *
 * Two callers:
 *   1. SSEAdapter — when a push event arrives as `event: invalidate`
 *      (no payload), the client refetches via this endpoint to populate
 *      the cache. Payload-on-invalidate (`event: update`) skips this
 *      round-trip; this endpoint is the fallback path for queries the
 *      server can't or won't push payload for.
 *   2. PollingAdapter — degraded-mode safety net when SSE has repeated
 *      failures and useTransportFallback drops to POLLING.
 *
 * Resolves the named query through @restart/zero-harness's registry,
 * feeds it to Zero's postgres-js adapter (which compiles ZQL → SQL
 * in-process), and returns the rows directly. The `@restart/zero-harness`
 * registry is kept solely to power this resolution path; zero-cache itself
 * was retired in the Level 1 + Phase 1 SSE cutover (2026-05-07).
 *
 * GET /api/zero-harness/rest-query?name=<name>&args=<json>
 *  → { rows, version }
 *
 * `version` is a wall-clock millisecond stamp; clients use it as a
 * freshness marker.
 */
import { NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';
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
// the client across requests avoids socket churn. The connection URL points
// at the workspace's PG (embedded-postgres TCP port by default, or system
// PG via HARNESS_ADMIN_DATABASE_URL); the legacy unix-socket override
// (PAPERCUSP_PGLITE_SOCKET_DIR) is honored when desktop runs in pglite mode.
// libs/db/src/connection.ts has the shared host-override logic, but this
// route bypasses that helper because zeroPostgresJS wants the postgres-js
// client directly.
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
  // Early-out when the client already gave up. The polling adapter aborts
  // in-flight queries on WS-takeover; without this check the server still
  // walks the registry and runs the SQL even though no one is listening.
  // Note: this catches early aborts but doesn't cancel mid-SQL — postgres-js
  // doesn't take an AbortSignal. Acceptable for now; the win is the bulk of
  // the probe window where the abort fires before SQL even starts.
  if (req.signal.aborted) {
    return new Response(null, { status: 499 });
  }
  try {
    const query = mustGetQuery(queries, name);
    const expr = query.fn({ args, ctx: {} });
    const provider = getProvider();
    const result = await provider.run(expr);
    if (req.signal.aborted) {
      // SQL already ran (postgres-js can't cancel mid-flight here), but at
      // least we skip the gzip + JSON.stringify of a result no one wants.
      return new Response(null, { status: 499 });
    }
    // .one() queries return a single row (or null); .many() return an array.
    // Normalize to a row array for the wire format the client expects.
    let rows: unknown[];
    if (Array.isArray(result)) {
      rows = result;
    } else if (result == null) {
      rows = [];
    } else {
      rows = [result];
    }
    const body = JSON.stringify({ rows, version: String(Date.now()) });
    // Gzip when the client accepts it. The Hono catch-all has compress
    // middleware; this route bypasses Hono (it's a regular Next handler),
    // so we apply compression inline. Measured 2026-05-05: rows for
    // agentRunsSheets.all are 85 KB raw vs ~12 KB gzipped (7.3x).
    // Threshold mirrors Hono's: skip small bodies where gzip overhead
    // exceeds the win.
    const acceptsGzip = (req.headers.get('accept-encoding') ?? '').toLowerCase().includes('gzip');
    if (acceptsGzip && body.length >= 1024) {
      const gz = gzipSync(body);
      return new Response(gz, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-encoding': 'gzip',
          'vary': 'accept-encoding',
        },
      });
    }
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return NextResponse.json({ error: msg, name }, { status: 500 });
  }
}

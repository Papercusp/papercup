/**
 * Shared resolver for the harness sync layer's REST query endpoints.
 *
 * Both `/api/zero-harness/rest-query` (single) and
 * `/api/zero-harness/rest-query-batch` (many) resolve named queries the
 * same way: look the name up in `@restart/zero-harness`'s registry,
 * compile the ZQL → SQL via Zero's postgres-js adapter, run it. Keeping
 * the postgres-js client + provider as a single module-level singleton
 * here means both routes share ONE connection pool instead of opening
 * two.
 *
 * zero-cache itself was retired in the Level 1 + Phase 1 SSE cutover
 * (2026-05-07); this registry-resolution path is what replaced it.
 */
import postgres from 'postgres';

import { schema, queries } from '@restart/zero-harness';
import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';

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
let _client: ReturnType<typeof postgres> | null = null;
let _provider: { run: (q: any) => Promise<any[]> } | null = null;

function getProvider() {
  if (_provider) return _provider;
  const url = getHarnessAdminUrl();
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

/** One resolved query result: a row array. `.one()` queries normalize to 0/1-element arrays. */
export async function resolveNamedQuery(name: string, args: unknown): Promise<unknown[]> {
  const query = mustGetQuery(queries, name);
  const expr = query.fn({ args, ctx: {} });
  const provider = getProvider();
  const result = await provider.run(expr);
  if (Array.isArray(result)) return result;
  if (result == null) return [];
  return [result];
}

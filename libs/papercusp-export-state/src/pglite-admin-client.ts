/**
 * Tiny client for pglite-server's `/admin/pg-dump` HTTP endpoint.
 *
 * Why this exists: `@electric-sql/pglite-tools.pgDump` requires an in-process
 * `PGlite` instance, but pglite-server runs in a separate Node process
 * (exposing only a unix socket for the wire protocol). The admin endpoint —
 * added in `packages/pglite-server/src/index.js` — wraps `pgDump({ pg })` so
 * any caller that knows the admin URL can fetch a SQL dump without a system
 * `pg_dump` binary.
 *
 * Activation: set `PGLITE_ADMIN_URL=http://127.0.0.1:<port>` (or pass a URL
 * explicitly). When set, the snapshot capture path uses this in place of
 * shelling out to `pg_dump`. When unset, callers fall back to the system
 * binary (the dev/Hetzner case).
 */

export function pgliteAdminUrl(override?: string): string | undefined {
  return override ?? process.env.PGLITE_ADMIN_URL ?? undefined;
}

/**
 * Build the postgres-js options overlay for desktop pglite mode. When
 * `PAPERCUSP_PGLITE_SOCKET_DIR` is set the URL's host is ignored and the
 * connection is made via the unix socket dir. Mirrors the pattern in
 * `libs/db/src/connection.ts:buildClient`. Returns an empty object on
 * non-pglite environments so callers can spread it unconditionally.
 */
export function pgliteSocketOpts(): { host?: string } {
  const sock = process.env.PAPERCUSP_PGLITE_SOCKET_DIR;
  return sock ? { host: sock } : {};
}

export async function pgliteAdminPgDump(
  baseUrl: string,
  args: string[],
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/admin/pg-dump`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`pglite admin pg-dump failed (${res.status}): ${body.trim()}`);
  }
  return res.text();
}

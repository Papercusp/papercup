/**
 * TEMPORARY DIAGNOSTIC — EI-16087/EI-15862. Delete after reading.
 * Asks each connection WHICH SERVER it is actually on, inside a real vitest
 * process (so setup-hermetic-env.ts scrubs apply). Writes to a file rather than
 * console (vitest-fail-on-console turns warns into failures).
 */
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';

describe('EI-16087 diagnostic', () => {
  it('asks reader and writer which server they are on', async () => {
    const out: Record<string, unknown> = {
      PAPERCUSP_PGBOUNCER: process.env.PAPERCUSP_PGBOUNCER,
      PAPERCUSP_SKIP_PG_DISCOVERY: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
      HARNESS_ADMIN_DATABASE_URL: process.env.HARNESS_ADMIN_DATABASE_URL?.replace(/:[^:@/]*@/, ':***@') ?? null,
      DATABASE_URL: process.env.DATABASE_URL?.replace(/:[^:@/]*@/, ':***@') ?? null,
    };

    try {
      const { pgClientFields } = await import('./memory/mem0-connection');
      const f = (await pgClientFields()) as Record<string, unknown>;
      out.READER_FIELDS = { host: f?.host, port: f?.port, database: f?.database };
      const { Client } = await import('pg');
      const c = new Client(f as never);
      await c.connect();
      const r = await c.query('SELECT inet_server_port() AS port, current_database() AS db');
      out.READER_ACTUAL = r.rows[0];
      await c.end();
    } catch (e) {
      out.READER_ERR = (e as Error).message;
    }

    try {
      const conn = (await import('@papercusp/db-org')) as Record<string, unknown>;
      const h = (conn.getOrgPg as () => { sql: (s: TemplateStringsArray) => Promise<unknown[]> })();
      const rows = await h.sql`SELECT inet_server_port() AS port, current_database() AS db`;
      out.WRITER_ACTUAL = rows[0];
    } catch (e) {
      out.WRITER_ERR = (e as Error).message;
    }

    writeFileSync('/tmp/pgtarget-result.json', JSON.stringify(out, null, 2));
  });
});

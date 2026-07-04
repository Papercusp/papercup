/**
 * P-050 dual-impl proof for PresenceStore: run the SHARED conformance
 * suite (the one the in-mem double passes in
 * packages/coordination/src/presence/presence.test.ts) against the
 * PRODUCTION `PgPresenceStore` over a real Postgres handle. Both impls
 * passing the SAME assertions is what makes the swappability claim real
 * (before this, only the in-mem double was asserted).
 *
 * Connects via `connectionString()` (the same env→discovery→fallback
 * resolver `pgClientFields` uses — `getOrgPg()` needs an operator bootstrap
 * a standalone vitest run doesn't have). Creates the two tables it needs
 * idempotently (`CREATE … IF NOT EXISTS`, mirroring lib/ensure-schema.ts)
 * so the suite genuinely RUNS wherever PG is reachable — live operator or
 * CI testcontainer — rather than silently skipping. Soft-skips only when
 * no PG is reachable at all.
 */
import { afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { PgPresenceStore } from '@papercusp/coordination/presence';
import { describePresenceConformance } from '@papercusp/coordination/presence/conformance';
import { connectionString } from '../../../memory/mem0-connection';

let sql: Sql | null = null;

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describePresenceConformance(
  'PgPresenceStore (live PG)',
  () => new PgPresenceStore({ getSql: () => sql!, ensureSchema: async () => {} }),
  {
    ready: async () => {
      try {
        const url = await connectionString();
        // Mirror getOrgPg()'s postgres-js options (libs/papercusp/libs/db
        // connection.ts) so this handle reproduces PRODUCTION behavior
        // exactly — esp. `prepare: false`, which governs how jsonb params
        // (current_files) round-trip. A default handle silently dropped
        // current_files to [], which is precisely the kind of config-skew
        // bug a faithful conformance run must NOT mask.
        sql = postgres(url, {
          onnotice: () => {},
          connection: { search_path: 'harness_shared, public' },
          prepare: false,
          max: 4,
        });
        await sql`SELECT 1`;
        // Canonical schema, mirrored from lib/ensure-schema.ts. IF NOT
        // EXISTS → no-op against the operator's already-created tables;
        // creates them in a bare CI DB so the proof still runs.
        await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
        await sql.unsafe(`
          CREATE TABLE IF NOT EXISTS harness_shared.power_user_sessions (
            auth_session_id TEXT PRIMARY KEY,
            workspace_id    TEXT NOT NULL,
            user_id         TEXT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            revoked_at      TIMESTAMPTZ
          )`);
        await sql.unsafe(`
          CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
            owner_id          TEXT PRIMARY KEY,
            owner_label       TEXT NOT NULL DEFAULT '',
            workspace_id      TEXT NOT NULL DEFAULT 'default',
            source            TEXT NOT NULL DEFAULT '',
            intent            TEXT NOT NULL DEFAULT '',
            current_plan_slug TEXT,
            current_files     JSONB NOT NULL DEFAULT '[]'::jsonb,
            host              TEXT NOT NULL DEFAULT '',
            pid               INTEGER,
            started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT now()
          )`);
        return true;
      } catch (e) {
         
        console.error('[presence-conformance] PG not reachable, skipping:', (e as Error)?.message);
        return false;
      }
    },
  },
);

/**
 * Integration test for migration 359 — canonicalize harness_slug at the
 * substrate-outbox capture boundary (real Postgres).
 *
 * Plan: infra-fail-fast-build-integrity-2026-06-19, item C1/P-009. Proves that
 * a federated write tagged with a RETIRED harness slug (papercup / papercup-hive)
 * enqueues a substrate_outbox row under the CANONICAL slug (papercusp), so a
 * stale-ctx writer self-heals instead of accreting undrained dead-slug backlog —
 * and that the migration's one-time cleanup drains the already-stuck rows.
 *
 * Owns its schema: the 000-baseline coord_event_log + the real archived 102
 * outbox/capture fn + migration 150 (coord federation triggers) + the bridge
 * columns later migrations add (op_hlc / hlc_now / fed_hlc), then migration 359
 * verbatim on top. Does not touch the dev DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');
const OUTBOX_MIGRATION = resolve(SQL_DIR, 'archive/102-substrate-outbox.sql');
const FED_MIGRATION = resolve(SQL_DIR, '150-coord-event-log-federation.sql');
const CANON_MIGRATION = resolve(SQL_DIR, '359-canonicalize-federation-harness-slug.sql');

/** Drop psql metacommands + standalone BEGIN/COMMIT so a migration body applies as
 *  one postgres.js simple-query batch (dollar-quoted fn bodies pass through intact). */
function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_canon';

interface OutboxDbRow {
  table_name: string;
  op: string;
  key: string;
  harness_slug: string;
  drained_at: number | null;
}

function envelope(msgId: string, extra: Record<string, unknown> = {}) {
  return { ts: '2026-06-22T00:00:00Z', msg_id: msgId, from: 'su-A', to: ['su-B'], kind: 'message', summary: 's', ...extra };
}

describe('federation harness_slug canonicalization (migration 359, real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('fed_canon');
    await db.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
      END $r$;
    `);

    // 000-baseline coord_event_log (pre-150 — no harness_slug/origin yet).
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.coord_event_log (
        id           bigserial   PRIMARY KEY,
        workspace_id text        NOT NULL DEFAULT 'default',
        surface      text        NOT NULL,
        writer_key   text,
        msg_id       text        NOT NULL,
        body         jsonb       NOT NULL,
        ts           timestamptz NOT NULL DEFAULT now()
      );
    `);

    // 102 attaches triggers to the consolidated tables → they must exist first.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        feature_id TEXT NOT NULL, author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, feature_id));
      CREATE TABLE harness_shared.harness_issues_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        issue_id TEXT NOT NULL, author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, issue_id));
    `);

    // Real archived 102 (outbox table + base capture fn + consolidated-table triggers).
    await db.sql.unsafe(readFileSync(OUTBOX_MIGRATION, 'utf8'));

    // Bridge to the CURRENT schema that migration 359's capture fn targets:
    //   • op_hlc column on the outbox (added by mig 314 / D-001 HLC ordering).
    //   • hlc_now() — stubbed (only invoked on DELETE; real one returns an HLC).
    await db.sql.unsafe(`ALTER TABLE harness_shared.substrate_outbox ADD COLUMN IF NOT EXISTS op_hlc text`);
    await db.sql.unsafe(`CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text LANGUAGE sql AS $f$ SELECT 'hlc-test' $f$`);

    // Migration 150 (coord_event_log federation triggers) + its LWW-guard columns.
    await db.sql.unsafe(stripMeta(readFileSync(FED_MIGRATION, 'utf8')));
    await db.sql.unsafe(`ALTER TABLE harness_shared.coord_event_log ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.coord_event_log ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);

    // Seed a STUCK dead-slug backlog row BEFORE 359 applies, so the migration's
    // one-time cleanup has something to drain.
    await db.sql`
      INSERT INTO harness_shared.substrate_outbox (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
      VALUES (${WS}, 'papercup', 'coord_event_log', 'put', 'STUCK-PRE-359', '{}'::jsonb, 1, NULL)`;

    // Migration 359 verbatim (canonical fn + CREATE OR REPLACE capture + drain).
    await db.sql.unsafe(stripMeta(readFileSync(CANON_MIGRATION, 'utf8')));
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function insertMsg(msgId: string, harness: string | null) {
    await db.sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
      VALUES (${WS}, 'messages', 'su-A', ${msgId}, ${JSON.stringify(envelope(msgId))}::text::jsonb, ${harness}, 'local')`;
  }
  async function latestOutbox(key: string): Promise<OutboxDbRow | undefined> {
    const [r] = await db.sql<OutboxDbRow[]>`
      SELECT table_name, op, key, harness_slug, drained_at FROM harness_shared.substrate_outbox WHERE key=${key} ORDER BY id DESC LIMIT 1`;
    return r;
  }

  it('a coord message tagged papercup federates under the canonical papercusp slug', async () => {
    await insertMsg('m-papercup', 'papercup');
    const row = await latestOutbox('m-papercup');
    expect(row?.table_name).toBe('coord_event_log');
    expect(row?.harness_slug).toBe('papercusp');
  });

  it('the papercup-hive alias also canonicalizes to papercusp', async () => {
    await insertMsg('m-papercup-hive', 'papercup-hive');
    expect((await latestOutbox('m-papercup-hive'))?.harness_slug).toBe('papercusp');
  });

  it('a non-retired slug passes through UNCHANGED (behavior-preserving)', async () => {
    await insertMsg('m-realhive', 'real-hive');
    expect((await latestOutbox('m-realhive'))?.harness_slug).toBe('real-hive');
  });

  it('the consolidated-table capture path canonicalizes too (shared fn)', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, origin)
      VALUES (${WS}, 'papercup', 'F-canon', 'local')`;
    expect((await latestOutbox('F-canon'))?.harness_slug).toBe('papercusp');
  });

  it('canonical_harness_slug(): retired→papercusp, others→identity, NULL→NULL', async () => {
    const [r] = await db.sql<{ a: string; b: string; c: string; d: string | null }[]>`
      SELECT harness_shared.canonical_harness_slug('papercup') AS a,
             harness_shared.canonical_harness_slug('papercup-hive') AS b,
             harness_shared.canonical_harness_slug('some-other-hive') AS c,
             harness_shared.canonical_harness_slug(NULL) AS d`;
    expect(r.a).toBe('papercusp');
    expect(r.b).toBe('papercusp');
    expect(r.c).toBe('some-other-hive');
    expect(r.d).toBeNull();
  });

  it('the one-time cleanup drained the pre-existing stuck dead-slug backlog row', async () => {
    const row = await latestOutbox('STUCK-PRE-359');
    expect(row?.harness_slug).toBe('papercup'); // left as-is (not re-routed)…
    expect(row?.drained_at).not.toBeNull(); // …but marked drained so it stops blocking the backlog.
  });
});

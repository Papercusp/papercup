/**
 * work-items-outbox-operator-gap-signal.integration.test.ts — migration 454
 * (WI-1633 / WI-900 M2 follow-up).
 *
 * THE GAP THIS CLOSES
 * --------------------
 * `capture_work_items_outbox()`'s operator-scope branch silently drops an
 * operator-scoped issue write (`harness_slug LIKE 'operator:%'`) when the write's
 * workspace has 0 or >1 Hive homes: no `substrate_outbox` row is ever inserted, so
 * the existing drain-reconcile stall detector (which only ever sees rows that DID
 * reach the outbox) has structurally no way to notice the drop — it's invisible.
 * Migration 454 adds a `pg_notify('substrate_outbox_gap', ...)` right before that
 * early return so the drop is at least OBSERVABLE. This test proves, against the
 * REAL, CURRENT, full migration chain (000-baseline → HEAD, including mig 454):
 *   (a) a 0-Hive-home workspace's operator issue write fires the gap signal,
 *   (b) a >1-Hive-home workspace's operator issue write fires the gap signal,
 *   (c) the EXACT single-hive-home case is UNCHANGED (still captures + federates,
 *       no gap signal) — the fix must not regress the by-design healthy path,
 *   (d) a non-operator (harness-scoped) issue write never fires the gap signal —
 *       the notify is scoped to the operator branch only.
 *
 * WHY THE FULL-CHAIN BOOT (not a hand-assembled schema slice)
 * -------------------------------------------------------------
 * Mirrors work-items-outbox-canonical-slug.integration.test.ts (mig 452, the
 * sibling M1 fix in this same audit bundle): `createFreshTestDb` +
 * `applyPendingMigrations` runs the REAL boot-path migration runner over the REAL
 * sql/ directory, exercising the actual live `capture_work_items_outbox` function
 * post-454.
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run --config vitest.integration.config.ts \
 *     lib/sync/hyperbee/__tests__/work-items-outbox-operator-gap-signal.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors the mig-452 sibling test.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

let db: MigratedTestDb;
let sql: postgres.Sql;
let notifyConn: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'wigap',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
  // A dedicated single connection to LISTEN on — postgres-js multiplexes LISTEN
  // onto whichever connection issues it, so keep it separate from the pool used
  // for INSERTs/hive setup to avoid a race between subscribe and notify.
  notifyConn = postgres(db.url, { max: 1, onnotice: () => {}, prepare: false });
}, 240_000);

afterAll(async () => {
  await notifyConn?.end({ timeout: 5 });
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

interface OutboxRow {
  table_name: string;
  harness_slug: string;
}

async function latestOutbox(key: string): Promise<OutboxRow | undefined> {
  const [r] = await sql<OutboxRow[]>`
    SELECT table_name, harness_slug FROM harness_shared.substrate_outbox
     WHERE key = ${key} ORDER BY id DESC LIMIT 1`;
  return r;
}

/** Collects 'substrate_outbox_gap' notify payloads received during `fn()`. */
async function captureGapNotifies(fn: () => Promise<void>): Promise<string[]> {
  const payloads: string[] = [];
  const { unlisten } = await notifyConn.listen('substrate_outbox_gap', (payload) => {
    payloads.push(payload);
  });
  try {
    await fn();
    // pg_notify delivery is async over the connection; give it a beat.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await unlisten();
  }
  return payloads;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-gapsig-${seq}`;
}

async function insertHive(ws: string, homeSlug: string): Promise<void> {
  const publicKey = Buffer.from(`pk-${ws}-${homeSlug}`);
  // harness_shared.hives/home_slug renamed to pots/pot_home_slug (mig 557,
  // cup-lexicon-full-rename-2026-07-09 P-011) — this test runs against the REAL
  // full migration chain (000-baseline → HEAD), so the old names no longer exist.
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${ws}, ${homeSlug}, ${publicKey}, ${'kc-' + ws + '-' + homeSlug}, ${Date.now()})`;
}

async function insertOperatorIssue(ws: string, id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
    VALUES (${ws}, ${'operator:' + ws}, ${id}, 'gap signal test issue', 'body', 'open', 'bug', 'local')`;
}

describe('capture_work_items_outbox operator-scope gap signal (migration 454, WI-1633, real PG)', () => {
  it('0 Hive homes: fires substrate_outbox_gap and does NOT insert an outbox row', async () => {
    const ws = 'ws_gap_zero_homes';
    const id = nextId('WI');
    const payloads = await captureGapNotifies(async () => {
      await insertOperatorIssue(ws, id);
    });
    expect(payloads).toEqual([`${ws}::operator::0`]);
    expect(await latestOutbox(id)).toBeUndefined();
  });

  it('>1 Hive homes: fires substrate_outbox_gap and does NOT insert an outbox row', async () => {
    const ws = 'ws_gap_multi_homes';
    await insertHive(ws, 'home-a');
    await insertHive(ws, 'home-b');
    const id = nextId('WI');
    const payloads = await captureGapNotifies(async () => {
      await insertOperatorIssue(ws, id);
    });
    expect(payloads).toEqual([`${ws}::operator::2`]);
    expect(await latestOutbox(id)).toBeUndefined();
  });

  it('exactly 1 Hive home: unchanged — captures + federates, NO gap signal', async () => {
    const ws = 'ws_gap_one_home';
    await insertHive(ws, 'the-one-home');
    const id = nextId('WI');
    const payloads = await captureGapNotifies(async () => {
      await insertOperatorIssue(ws, id);
    });
    expect(payloads).toEqual([]);
    const row = await latestOutbox(id);
    expect(row?.table_name).toBe('engineer_issues');
    expect(row?.harness_slug).toBe('the-one-home');
  });

  it('a non-operator (harness-scoped) issue write never fires the gap signal', async () => {
    const ws = 'ws_gap_harness_scoped';
    const id = nextId('WI');
    const payloads = await captureGapNotifies(async () => {
      await sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
        VALUES (${ws}, 'some-real-hive', ${id}, 'harness scoped', 'body', 'open', 'bug', 'local')`;
    });
    expect(payloads).toEqual([]);
    expect((await latestOutbox(id))?.harness_slug).toBe('some-real-hive');
  });
});

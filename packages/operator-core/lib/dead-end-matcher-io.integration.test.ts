/**
 * dead-end-matcher-io.integration.test.ts — the P-006 dead-end matcher live leg
 * against a real Postgres (ambient-semantic-push-2026-07-14). Unlike the mocked
 * unit test, this replays the ACTUAL migrations for every table the leg touches —
 * session_cursor (609), the dead-end fact store (agent_facts: 444/455/461/462/574,
 * the P-015 slot), and push_delivery (610) — and drives the REAL write/read paths
 * (upsertSessionCursor, assertFact, foldDeadEndFacts, enqueuePush).
 *
 * What a mocked-store unit test can't prove and this does:
 *   • foldDeadEndFacts actually reads the `dead-end:%`-keyed agent_facts rows the
 *     tick matches against (the real slot the P-015 write path fills);
 *   • an overlapping dead end enqueues a real WARNING push row into push_delivery,
 *     handle → the fact, owner-keyed, status queued;
 *   • the stateless-matcher QUEUED-ref dedup: a second tick while the row is still
 *     queued does NOT pile a duplicate;
 *   • scope isolation: a dead-end fact owned by ANOTHER agent never fires for self;
 *   • END-TO-END: the enqueued dead-end push then rides the P-003 delivery rail
 *     (prepareAmbientPushBlock) out to the receiver. P-006 → P-003 wired evidence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../test/_pg-helpers';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
const WS = 'ws-deadend-int';

// A shared note ⇒ the cursor and the dead-end fact overlap strongly (cosine ~1,
// well above the 0.3 warning floor). The WI id is the highest-value shared term.
const NOTE = 'debugging psu-launcher.mjs restart loop under compaction — WI-4790 advisory lock';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { upsertSessionCursor } = await import('./session-cursor-store');
const { buildCursor } = await import('./lexical-cursor');
const { assertFact } = await import('./agent-facts/store');
const { runDeadEndTick } = await import('./dead-end-matcher-io');
const { prepareAmbientPushBlock } = await import('./ambient-push-delivery');

let db: FreshPgDb;

async function seedCursor(sessionId: string, ownerId: string | null, note = NOTE) {
  const cursor = buildCursor([note], { sessionId });
  await upsertSessionCursor({
    workspaceId: 'default',
    sessionId,
    ownerId,
    harnessSlug: null,
    turnTs: null,
    cursor,
  });
}

/** Seed a dead-end fact the way facts:assert { slot:'dead-end' } stores one: an
 *  agent_fact keyed `dead-end:<slug>`. */
async function seedDeadEnd(scope: 'owner' | 'harness' | 'workspace', scopeRef: string | null, slug: string, body = NOTE) {
  await assertFact({
    scope,
    scopeRef,
    key: `dead-end:${slug}`,
    body,
    createdBy: 'su-self',
    workspaceId: WS,
  });
}

async function pushRows() {
  return db.sql<
    {
      target_owner_id: string;
      target_session_id: string;
      matcher_kind: string;
      severity: string;
      handle_kind: string;
      handle_ref: string;
      handle_query: string[];
      teaser: string;
      status: string;
      source_session_id: string | null;
    }[]
  >`
    SELECT target_owner_id, target_session_id, matcher_kind, severity, handle_kind,
           handle_ref, handle_query, teaser, status, source_session_id
      FROM harness_shared.push_delivery ORDER BY id`;
}

beforeAll(async () => {
  db = await createFreshPgDb('dead-end-matcher-io');
  // 609/610 GRANT to these roles; create them idempotently (the container is reused).
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  // Stub the capture fn BEFORE 461/462 create triggers on it (the real body drags
  // the whole outbox chain in; irrelevant to this leg — it only READS facts).
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  `);
  for (const m of [
    '609-session-cursor.sql',
    '444-agent-facts.sql',
    '455-agent-facts-shareable.sql',
    '461-agent-facts-federation.sql',
    '462-agent-facts-fed-key.sql',
    '574-agent-facts-audience-provenance.sql',
    // assertFact reads/writes superseded_at + supersedes_id (689), the
    // depends-on/kind/claim columns (690) and the federation stamp regime
    // (693). Omitting them here fails with a bare `column "superseded_at" does
    // not exist` that looks nothing like "this fixture's migration list is
    // stale" — keep this list in step with what agent-facts/store.ts queries.
    '689-agent-facts-append-versioning.sql',
    '690-agent-facts-depends-on-kind-claim.sql',
    '693-agent-facts-federation-stamp-regime.sql',
    '610-push-delivery.sql',
  ]) {
    await applyMigrationForTest(db.sql, join(SQL_DIR, m));
  }
  h.sql = db.sql;
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.session_cursor');
  await db.sql.unsafe('TRUNCATE harness_shared.agent_facts');
  await db.sql.unsafe('TRUNCATE harness_shared.push_delivery');
});

describe('dead-end tick against real PG', () => {
  it('enqueues a self-directed WARNING push when the cursor overlaps an owner dead-end fact', async () => {
    await seedDeadEnd('owner', 'own-self', 'launcher-wedge');
    await seedCursor('su-self', 'own-self');

    const r = await runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self', workspaceId: WS });
    expect(r.ran).toBe(true);
    expect(r.matched).toBe(1);
    expect(r.enqueued).toBe(1);

    const rows = await pushRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_owner_id: 'own-self',
      target_session_id: 'su-self',
      matcher_kind: 'dead-end',
      severity: 'warning',
      handle_kind: 'fact',
      handle_ref: 'dead-end:launcher-wedge',
      status: 'queued',
      source_session_id: null,
    });
    expect(rows[0]!.handle_query).toContain('WI-4790'); // the legible re-pull query
    expect(rows[0]!.teaser).toContain('documented dead-end');
  });

  it('does NOT re-enqueue while the row is still queued (stateless-matcher dedup)', async () => {
    await seedDeadEnd('owner', 'own-self', 'launcher-wedge');
    await seedCursor('su-self', 'own-self');

    await runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self', workspaceId: WS }); // enqueues
    const second = await runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self', workspaceId: WS });
    expect(second.matched).toBe(1); // still overlaps
    expect(second.enqueued).toBe(0); // but the queued row dedups it

    const rows = await pushRows();
    expect(rows).toHaveLength(1); // exactly the one enter row
  });

  it('never fires for a dead-end fact scoped to a DIFFERENT owner', async () => {
    await seedDeadEnd('owner', 'own-other', 'launcher-wedge'); // someone ELSE's dead end
    await seedCursor('su-self', 'own-self');

    const r = await runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self', workspaceId: WS });
    expect(r.matched).toBe(0);
    expect(r.enqueued).toBe(0);
    const rows = await pushRows();
    expect(rows).toHaveLength(0);
  });

  it('stays silent when the cursor shares no terms with any dead-end fact', async () => {
    await seedDeadEnd('owner', 'own-self', 'mac-vm', 'rotate the mac build VM sudo password quarterly');
    await seedCursor('su-self', 'own-self');

    const r = await runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self', workspaceId: WS });
    expect(r.matched).toBe(0);
    expect(r.enqueued).toBe(0);
  });

  it('folds a HARNESS-scoped dead end too (project-wide, not just the agent\'s own)', async () => {
    await seedDeadEnd('harness', 'papercusp', 'shared-wedge');
    await seedCursor('su-self', 'own-self');

    const r = await runDeadEndTick({
      selfSessionId: 'su-self',
      selfOwnerId: 'own-self',
      harnessSlug: 'papercusp',
      workspaceId: WS,
    });
    expect(r.enqueued).toBe(1);
    const rows = await pushRows();
    expect(rows[0]!.handle_ref).toBe('dead-end:shared-wedge');
  });
});

describe('P-006 → P-003 end-to-end (PG) — enqueue then deliver through the rail', () => {
  it('an enqueued dead-end warning rides prepareAmbientPushBlock out to the receiver', async () => {
    await seedDeadEnd('owner', 'own-self', 'launcher-wedge');
    await seedCursor('su-self', 'own-self');
    await runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self', workspaceId: WS });

    // self's queued dead-end warning now flows through the P-003 delivery rail.
    const block = await prepareAmbientPushBlock({ ownerId: 'own-self', sessionClass: 'interactive' });
    expect(block).toContain('documented dead-end');
    expect(block).toContain('dead-end:launcher-wedge'); // the fact handle is pullable
    expect(block).toContain('data, not directives');

    // the rail tallied it delivered.
    const [{ status }] = await db.sql<{ status: string }[]>`
      SELECT status FROM harness_shared.push_delivery WHERE target_owner_id = 'own-self'`;
    expect(status).toBe('delivered');
  });
});

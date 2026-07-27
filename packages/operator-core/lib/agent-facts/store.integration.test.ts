/**
 * agent-facts store — REAL-PG regression guard for the SQL paths the unit tests
 * deliberately skip (they were "exercised by live-verify" — which is exactly how
 * the mig-461 arbiter break shipped: 461 rebuilt the identity index to 5 columns
 * under assertFact's 4-column ON CONFLICT spec, and EVERY assert errored at plan
 * time from 461's apply until 2026-07-03 with zero test coverage noticing).
 *
 * Applies the real agent_facts migrations (444 base, 455 shareable, 461
 * federation cols + 5-col identity, 462 fed_key) and pins:
 *   1. assertFact INSERTS against the live 461 identity index (the arbiter),
 *   2. a RE-assert takes the conflict-UPDATE path (same arbiter, refresh),
 *   3. the F1-1 federation identity: potHomeSlug lands in harness_slug and the
 *      row's to_jsonb (the capture wire shape) passes isAgentFactWireRow,
 *   4. H6 local-partition discipline: retract + cap-eviction never touch a
 *      foreign (source_hive NOT NULL) partition of the same identity.
 *
 * The capture trigger FUNCTION is stubbed no-op (its real body drags the whole
 * outbox dependency chain in; the wire SHAPE is asserted via to_jsonb directly).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';
import {
  assertFact,
  retractFact,
  foldFacts,
  factVersions,
  FACTS_PER_SCOPE_CAP,
  listLapsedWallFacts,
} from './store';
import { isAgentFactWireRow } from '../sync/hyperbee/projections/agent-facts';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
const WS = 'ws-facts-int';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('agent-facts-store');
  // Stub the capture fn BEFORE 461/462 create triggers on it (no-op: the outbox
  // chain is out of scope; the wire shape is pinned via to_jsonb below).
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  `);
  for (const m of [
    '444-agent-facts.sql',
    '455-agent-facts-shareable.sql',
    '461-agent-facts-federation.sql',
    '462-agent-facts-fed-key.sql',
    // ⚠ This list had DRIFTED from the real agent_facts migration set — 498,
    // 505 and 664 all touch this table and none were here, so the fixture DB
    // was a schema this store has not run against in production for months.
    // 505 is the one that bit: it adds the surrogate `id` PK, without which
    // P-008's version chain (`supersedes_id` → `id`) cannot even parse. A
    // fixture that lags the real schema is the same blind spot as a stale
    // ON CONFLICT spec — this file exists to catch exactly that.
    '498-agent-facts-replica-identity.sql',
    '505-agent-facts-surrogate-pk-replica-identity.sql',
    '574-agent-facts-audience-provenance.sql',
    '664-widen-fact-body-cap.sql',
    '671-add-agent-facts-confidence.sql',
    // P-008 (a): swaps the identity index for its PARTIAL form. This list is
    // exactly the guard that catches an ON CONFLICT spec drifting away from the
    // live index — the mig-461 break this file was written for.
    '689-agent-facts-append-versioning.sql',
  ]) {
    // EI-6887: shared strip-psql-meta-commands-and-txn-wrapper + apply helper
    // (lifted from this file's own former inline version).
    await applyMigrationForTest(db.sql, join(SQL_DIR, m));
  }
});
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.agent_facts');
});

describe('assertFact against the REAL mig-461 identity index', () => {
  it('inserts (the arbiter matches the 5-column identity — the 461 regression)', async () => {
    const fact = await assertFact(
      {
        scope: 'harness',
        scopeRef: 'papercusp',
        key: 'k1',
        body: 'b1',
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    expect(fact.key).toBe('k1');
  });

  it('a RE-assert APPENDS a version and leaves exactly ONE current (P-008 a — was: conflict-UPDATE)', async () => {
    // Was "takes the conflict-UPDATE path (refresh)" and asserted count === 1.
    // Migration 689 replaced that path: a correction no longer overwrites, so
    // the row count is now the VERSION count and "one live value per identity"
    // is carried by the partial unique index instead.
    const base = {
      scope: 'workspace' as const,
      key: 'k2',
      createdBy: 'su-int',
      workspaceId: WS,
    };
    await assertFact({ ...base, body: 'first' }, db.sql);
    const updated = await assertFact({ ...base, body: 'second' }, db.sql);
    expect(updated.body).toBe('second');
    const all = await db.sql`SELECT count(*)::int AS n FROM harness_shared.agent_facts WHERE key = 'k2'`;
    expect(all[0].n).toBe(2); // appended, not overwritten
    const live =
      await db.sql`SELECT count(*)::int AS n FROM harness_shared.agent_facts WHERE key = 'k2' AND superseded_at IS NULL`;
    expect(live[0].n).toBe(1); // exactly one CURRENT version
  });

  it('F1-1: potHomeSlug stamps harness_slug and the wire shape validates on peers', async () => {
    await assertFact(
      {
        scope: 'harness',
        scopeRef: 'member-a',
        key: 'shared-1',
        body: 'a shareable conclusion',
        createdBy: 'su-int',
        workspaceId: WS,
        shareable: true,
        potHomeSlug: 'the-hive-home',
      },
      db.sql,
    );
    const rows = await db.sql`
      SELECT harness_slug, to_jsonb(agent_facts) AS wire
        FROM harness_shared.agent_facts WHERE key = 'shared-1'`;
    expect(rows[0].harness_slug).toBe('the-hive-home');
    // The capture serializes to_jsonb(row) — the exact value peers decode.
    expect(isAgentFactWireRow(rows[0].wire)).toBe(true);
  });

  it('a later assert WITHOUT the slug keeps the stamped federation identity', async () => {
    const base = {
      scope: 'harness' as const,
      scopeRef: 'member-a',
      key: 'keep-slug',
      createdBy: 'su-int',
      workspaceId: WS,
    };
    await assertFact({ ...base, body: 'v1', shareable: true, potHomeSlug: 'home' }, db.sql);
    await assertFact({ ...base, body: 'v2', shareable: true }, db.sql);
    // P-008 (a): must name the CURRENT version explicitly — there are now two
    // rows for this identity, and an unqualified `rows[0]` would be reading an
    // arbitrary one. The carry-forward moved from the UPDATE branch's COALESCE
    // to a subquery over the superseded row, so this is the test that pins it.
    const rows = await db.sql`
      SELECT harness_slug FROM harness_shared.agent_facts
       WHERE key = 'keep-slug' AND superseded_at IS NULL`;
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('home');
  });
});

describe('P-008 (a) append-versioning — a correction APPENDS, it never destroys (D-003)', () => {
  const base = { scope: 'owner' as const, scopeRef: 'su-v', key: 'ver', createdBy: 'su-int', workspaceId: WS };
  const chain = () =>
    db.sql`SELECT id, body, superseded_at, supersedes_id, retracted_at
             FROM harness_shared.agent_facts WHERE key = 'ver' ORDER BY id`;

  it('the first version has an id, supersedes nothing, and is current', async () => {
    const v1 = await assertFact({ ...base, body: 'one' }, db.sql);
    expect(typeof v1.id).toBe('number');
    expect(v1.supersedesId).toBeNull();
    expect(v1.supersededAt).toBeNull();
  });

  it('a correction keeps the OLD row intact and chains the new one to it', async () => {
    const v1 = await assertFact({ ...base, body: 'one' }, db.sql);
    const v2 = await assertFact({ ...base, body: 'two' }, db.sql);
    expect(v2.id).not.toBe(v1.id);
    expect(v2.supersedesId).toBe(v1.id);
    const rows = await chain();
    expect(rows).toHaveLength(2);
    // THE POINT OF THE WHOLE ITEM: a pointer taken at v1 still resolves to what
    // v1 said. Before 689 this row's body had been overwritten to 'two'.
    expect(rows[0].body).toBe('one');
    expect(rows[0].superseded_at).not.toBeNull();
  });

  it('reads serve ONLY the current version — a fold never shows a value beside its own correction', async () => {
    await assertFact({ ...base, body: 'one' }, db.sql);
    await assertFact({ ...base, body: 'two' }, db.sql);
    const folded = await foldFacts([{ scope: 'owner', scopeRef: 'su-v' }], { workspaceId: WS, audiences: 'all' }, db.sql);
    const mine = folded.filter((f) => f.key === 'ver');
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toBe('two');
  });

  it('factVersions walks the chain, current first', async () => {
    await assertFact({ ...base, body: 'one' }, db.sql);
    await assertFact({ ...base, body: 'two' }, db.sql);
    await assertFact({ ...base, body: 'three' }, db.sql);
    const hist = await factVersions({ scope: 'owner', scopeRef: 'su-v', key: 'ver', workspaceId: WS }, db.sql);
    expect(hist.map((h) => h.body)).toEqual(['three', 'two', 'one']);
    expect(hist[0].supersededAt).toBeNull();
    expect(hist[1].supersededAt).not.toBeNull();
  });

  it('⚠ a retraction SURVIVES on its own version — the old code erased it on revive', async () => {
    await assertFact({ ...base, body: 'one' }, db.sql);
    await retractFact({ scope: 'owner', scopeRef: 'su-v', key: 'ver', workspaceId: WS }, db.sql);
    const retractedRows = await chain();
    expect(retractedRows[0].retracted_at).not.toBeNull();
    // Re-asserting revives the identity. Previously that was expressed as
    // `retracted_at = NULL` on the mutated row — i.e. by destroying the record
    // that it had ever been retracted. Now the retraction stays on the version
    // that carried it, and the revival is a new version.
    await assertFact({ ...base, body: 'revived' }, db.sql);
    const rows = await chain();
    expect(rows).toHaveLength(2);
    expect(rows[0].retracted_at).not.toBeNull(); // history intact
    expect(rows[1].retracted_at).toBeNull(); // the live version is not retracted
    expect(rows[1].body).toBe('revived');
  });

  it('a retract marks the CURRENT version only and never rewrites history', async () => {
    await assertFact({ ...base, body: 'one' }, db.sql);
    await assertFact({ ...base, body: 'two' }, db.sql);
    await retractFact({ scope: 'owner', scopeRef: 'su-v', key: 'ver', workspaceId: WS }, db.sql);
    const rows = await chain();
    expect(rows[0].retracted_at).toBeNull(); // the superseded version is untouched
    expect(rows[1].retracted_at).not.toBeNull();
  });

  it('the partial unique index still forbids a SECOND current version', async () => {
    await assertFact({ ...base, body: 'one' }, db.sql);
    await expect(
      db.sql`INSERT INTO harness_shared.agent_facts
               (workspace_id, scope, scope_ref, key, body, created_by, expires_at)
             VALUES (${WS}, 'owner', 'su-v', 'ver', 'illegal', 'su-int', now() + interval '1 day')`,
    ).rejects.toThrow();
  });

  it('the cap counts CURRENT versions, so a heavily-corrected fact cannot evict its neighbours', async () => {
    // One fact revised many times must not consume the (scope, ref) budget.
    for (let i = 0; i < FACTS_PER_SCOPE_CAP + 5; i++) {
      await assertFact({ ...base, body: `rev ${i}` }, db.sql);
    }
    const live = await foldFacts(
      [{ scope: 'owner', scopeRef: 'su-v' }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 100 },
      db.sql,
    );
    expect(live.filter((f) => f.key === 'ver')).toHaveLength(1);
    // …and it is the newest revision, not an evicted one.
    expect(live.find((f) => f.key === 'ver')?.body).toBe(`rev ${FACTS_PER_SCOPE_CAP + 4}`);
  });
});

describe('H6 local-partition discipline (foreign partitions untouchable locally)', () => {
  /** Seed a FOREIGN partition of an identity (what the projection writes). */
  async function seedForeign(key: string) {
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, shareable, source_hive, origin)
      VALUES (${WS}, 'harness', 'member-a', ${key}, 'a peer observation', 'peer', now() + interval '1 day', true, 'peer-log-key', 'remote')`;
  }

  it('the local assert coexists with a foreign partition of the SAME identity', async () => {
    await seedForeign('both');
    await assertFact(
      { scope: 'harness', scopeRef: 'member-a', key: 'both', body: 'local view', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const rows = await db.sql`SELECT source_hive FROM harness_shared.agent_facts WHERE key = 'both' ORDER BY source_hive NULLS FIRST`;
    expect(rows.length).toBe(2);
    expect(rows[0].source_hive).toBeNull();
    expect(rows[1].source_hive).toBe('peer-log-key');
  });

  it('retractFact retracts ONLY the local partition', async () => {
    await seedForeign('r1');
    await assertFact(
      { scope: 'harness', scopeRef: 'member-a', key: 'r1', body: 'local', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const did = await retractFact({ scope: 'harness', scopeRef: 'member-a', key: 'r1', workspaceId: WS }, db.sql);
    expect(did).toBe(true);
    const rows = await db.sql`
      SELECT source_hive, retracted_at FROM harness_shared.agent_facts WHERE key = 'r1' ORDER BY source_hive NULLS FIRST`;
    expect(rows[0].retracted_at).not.toBeNull(); // local: retracted
    expect(rows[1].retracted_at).toBeNull(); // foreign: untouched
  });

  it('cap eviction only ever retracts LOCAL rows', async () => {
    await seedForeign('cap-foreign');
    for (let i = 0; i <= FACTS_PER_SCOPE_CAP; i++) {
      await assertFact(
        { scope: 'harness', scopeRef: 'member-a', key: `cap-${i}`, body: 'x', createdBy: 'su-int', workspaceId: WS },
        db.sql,
      );
    }
    const foreign = await db.sql`
      SELECT retracted_at FROM harness_shared.agent_facts WHERE key = 'cap-foreign' AND source_hive IS NOT NULL`;
    expect(foreign[0].retracted_at).toBeNull();
  });

  it('foldFacts surfaces BOTH partitions (foreign observations inform briefs)', async () => {
    await seedForeign('fold-1');
    await assertFact(
      { scope: 'harness', scopeRef: 'member-a', key: 'fold-1', body: 'local', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const folded = await foldFacts([{ scope: 'harness', scopeRef: 'member-a' }], { workspaceId: WS }, db.sql);
    expect(folded.length).toBe(2);
  });
});

// ── coord-authority-hardening-2026-07-11 P-007 (mig 574): audience filter +
// source-provenance round-trip against the REAL columns ──
describe('P-007 audience_scope + source_provenance (mig 574)', () => {
  const SEL = [{ scope: 'harness' as const, scopeRef: 'papercusp' }];
  const base = {
    scope: 'harness' as const,
    scopeRef: 'papercusp',
    body: 'a conclusion',
    createdBy: 'su-int',
    workspaceId: WS,
  };
  const STAMP = {
    kind: 'msg' as const,
    verified: true,
    quote: 'the verbatim origin',
    label: 'msg m-1 (15179 → 4c85f, 2026-07-11T09:01Z)',
    verifiedAt: '2026-07-11T00:00:01.000Z',
  };

  it('audienceScope + sourceProvenance round-trip through assert → fold', async () => {
    await assertFact({ ...base, key: 'aud-rt', audienceScope: 'fleet:backend', sourceProvenance: STAMP }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS, audiences: ['fleet:backend'] }, db.sql);
    expect(f.audienceScope).toBe('fleet:backend');
    expect(f.sourceProvenance).toEqual(STAMP);
  });

  it('fold default excludes audience-scoped facts; only the MATCHING audience (or "all") includes them', async () => {
    await assertFact({ ...base, key: 'aud-only', body: 'fleet-only', audienceScope: 'fleet:backend' }, db.sql);
    await assertFact({ ...base, key: 'open', body: 'for everyone' }, db.sql);

    const noAudience = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(noAudience.map((f) => f.key)).toEqual(['open']);

    const otherFleet = await foldFacts(SEL, { workspaceId: WS, audiences: ['fleet:frontend'] }, db.sql);
    expect(otherFleet.map((f) => f.key)).toEqual(['open']);

    const matching = await foldFacts(SEL, { workspaceId: WS, audiences: ['fleet:backend'] }, db.sql);
    expect(matching.map((f) => f.key).sort()).toEqual(['aud-only', 'open']);

    // facts:list's escape hatch — audience-scoped facts stay listable/retractable.
    const all = await foldFacts(SEL, { workspaceId: WS, audiences: 'all' }, db.sql);
    expect(all.map((f) => f.key).sort()).toEqual(['aud-only', 'open']);
  });

  it('a re-assert REPLACES audience + provenance (omitting them clears — fresh assert wins)', async () => {
    await assertFact({ ...base, key: 'swap', audienceScope: 'fleet:backend', sourceProvenance: STAMP }, db.sql);
    await assertFact({ ...base, key: 'swap', body: 'now unrestricted' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql); // default fold now sees it
    expect(f.key).toBe('swap');
    expect(f.audienceScope).toBeNull();
    expect(f.sourceProvenance).toBeNull();
  });

  it('a malformed/forged stored stamp reads back as null (defensive parse, fold never crashes)', async () => {
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, source_provenance)
      VALUES (${WS}, 'harness', 'papercusp', 'forged', 'b', 'peer', now() + interval '1 day',
              '{"kind":"god-mode","verified":"yes"}'::jsonb)`;
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.key).toBe('forged');
    expect(f.sourceProvenance).toBeNull();
  });
});

// WI-6052 (EI-18681964809855890 follow-up, mig 671): `confidence` reached the
// AgentFact contract + write-side TTL/lint behaviour but was never persisted —
// the INSERT/RETURNING/SELECT all omitted it, so it round-tripped as `null` on
// EVERY assert regardless of what the caller passed. This describe block is
// the regression: before mig 671 + the matching store.ts change, the first
// test here failed (`f.confidence` was `null`, not `'verified'`).
describe('confidence (evidence-strength tier, mig 671 / WI-6052)', () => {
  const SEL = [{ scope: 'harness' as const, scopeRef: 'papercusp' }];
  const base = {
    scope: 'harness' as const,
    scopeRef: 'papercusp',
    body: 'a conclusion',
    createdBy: 'su-int',
    workspaceId: WS,
  };

  it('confidence round-trips through assert → fold', async () => {
    await assertFact({ ...base, key: 'conf-rt', confidence: 'verified' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.confidence).toBe('verified');
  });

  it('each of the 3 tiers round-trips distinctly', async () => {
    await assertFact({ ...base, key: 'conf-verified', confidence: 'verified' }, db.sql);
    await assertFact({ ...base, key: 'conf-provisional', confidence: 'provisional' }, db.sql);
    await assertFact({ ...base, key: 'conf-suspected', confidence: 'suspected' }, db.sql);
    const facts = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f.confidence]));
    expect(byKey['conf-verified']).toBe('verified');
    expect(byKey['conf-provisional']).toBe('provisional');
    expect(byKey['conf-suspected']).toBe('suspected');
  });

  it('omitted confidence stays null (legacy/unset shape, unaffected by mig 671)', async () => {
    await assertFact({ ...base, key: 'conf-unset' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.confidence).toBeNull();
  });

  it('a re-assert REPLACES confidence (omitting it clears — fresh assert wins, same semantics as audienceScope/sourceProvenance)', async () => {
    await assertFact({ ...base, key: 'conf-swap', confidence: 'suspected' }, db.sql);
    await assertFact({ ...base, key: 'conf-swap', body: 'now unset' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.key).toBe('conf-swap');
    expect(f.confidence).toBeNull();
  });

  it('the DB CHECK constraint (mig 671) rejects an unrecognized value at write time — defense in depth alongside the TS enum', async () => {
    await expect(
      db.sql`
        INSERT INTO harness_shared.agent_facts
          (workspace_id, scope, scope_ref, key, body, created_by, expires_at, confidence)
        VALUES (${WS}, 'harness', 'papercusp', 'conf-forged', 'b', 'peer', now() + interval '1 day', 'omniscient')`,
    ).rejects.toThrow(/agent_facts_confidence_check|violates check constraint/i);
  });
});

// ── owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270): the
// wall-lapse read leg against the REAL table ──
describe('listLapsedWallFacts', () => {
  const base = { scope: 'harness' as const, scopeRef: 'papercusp', createdBy: 'su-int', workspaceId: WS };

  /** Assert then backdate expires_at past `now` — assertFact only accepts a
   *  positive ttlSec, so a lapsed fixture is built in two steps like a real
   *  wall would arrive at lapse: asserted live, then its TTL elapses. */
  async function assertLapsed(key: string, body: string, daysAgo: number) {
    await assertFact({ ...base, key, body, ttlSec: 3600 }, db.sql);
    await db.sql`UPDATE harness_shared.agent_facts SET expires_at = now() - make_interval(days => ${daysAgo})
                  WHERE workspace_id = ${WS} AND key = ${key}`;
  }

  it('finds an unretracted wall: fact past its expiry, oldest-lapsed first', async () => {
    await assertLapsed('wall:newer-lapse', 'b1', 1);
    await assertLapsed('wall:older-lapse', 'b2', 5);
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed.map((f) => f.key)).toEqual(['wall:older-lapse', 'wall:newer-lapse']);
    expect(lapsed[0]!.workspaceId).toBe(WS);
    expect(lapsed[0]!.createdBy).toBe('su-int');
  });

  it('excludes a non-wall-prefixed fact even when it too has lapsed', async () => {
    await assertLapsed('ordinary-lapsed', 'b', 1);
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed.map((f) => f.key)).not.toContain('ordinary-lapsed');
  });

  it('excludes a wall fact that has NOT yet lapsed', async () => {
    await assertFact({ ...base, key: 'wall:still-live', body: 'b', ttlSec: 3600 }, db.sql);
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed.map((f) => f.key)).not.toContain('wall:still-live');
  });

  it('excludes a lapsed wall fact that was explicitly retracted', async () => {
    await assertLapsed('wall:retracted', 'b', 1);
    await retractFact({ scope: 'harness', scopeRef: 'papercusp', key: 'wall:retracted', workspaceId: WS }, db.sql);
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed.map((f) => f.key)).not.toContain('wall:retracted');
  });

  it('a re-assert clears a wall from the lapsed set (fresh TTL, retracted_at reset)', async () => {
    await assertLapsed('wall:renewed', 'stale body', 2);
    expect((await listLapsedWallFacts({}, db.sql)).map((f) => f.key)).toContain('wall:renewed');
    await assertFact({ ...base, key: 'wall:renewed', body: 'fresh body', ttlSec: 3600 }, db.sql);
    expect((await listLapsedWallFacts({}, db.sql)).map((f) => f.key)).not.toContain('wall:renewed');
  });
});

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
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../../test/_pg-helpers';
import {
  assertFact,
  retractFact,
  findFactKeyElsewhere,
  foldFacts,
  factVersions,
  FACTS_PER_SCOPE_CAP,
  FACT_VOLATILE_MAX_TTL_SEC,
  listLapsedWallFacts,
  listConventionFacts,
  factCitationRef,
  type FactDependency,
} from './store';
import { isAgentFactWireRow } from '../sync/hyperbee/projections/agent-facts';
import { factsCellDelta } from './cells';
import { assumptionSelectorsFor, resolveAssumptions } from './assumptions';

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
  // P-008 (c) / D-077: migration 693 attaches `stamp_local_federated_write` to
  // agent_facts, so the function must EXIST before that CREATE TRIGGER runs.
  // Stubbed rather than applying migration 314, which also attaches triggers to
  // tables (harness_features_consolidated, …) this deliberately-minimal fixture
  // does not have.
  //
  // ⚠ SCOPE OF THIS STUB — it mints a monotonically increasing, HLC-SHAPED token,
  // which is exactly the property the delta cursor depends on (D-012: an HLC is a
  // total order, so the cursor is one comparable string). It is NOT the real
  // clock: node-id entropy, hlc_recv drift-clamping and the origin='remote'
  // passthrough are 314/459/466/681's business, not this file's. Those are
  // verified against the REAL trigger on the real schema — a local write is
  // stamped, a remote op carrying its own fed_ts is left alone.
  await db.sql.unsafe(`
    CREATE SEQUENCE IF NOT EXISTS harness_shared.test_hlc_seq;
    CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN RETURN NEW; END IF;
      IF COALESCE(NEW.origin, 'local') <> 'local' THEN RETURN NEW; END IF;
      NEW.fed_ts  := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := lpad(nextval('harness_shared.test_hlc_seq')::text, 15, '0') || ':00000:testnode';
      RETURN NEW;
    END $$;
  `);
  const migrations = [
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
    // P-008 (b): depends_on / kind / claim + the kind CHECK constraint and the
    // partial `agent_facts_kind` index. Added in the SAME edit as the migration,
    // which is the discipline the 498/505/664 drift above exists to enforce.
    '690-agent-facts-depends-on-kind-claim.sql',
    // P-018: the `enforcement` column + its tier CHECK. Same discipline again —
    // added in the same edit as the migration, so a drift between the tier
    // vocabulary in TypeScript and the one in the DB reds HERE.
    '692-agent-facts-convention-enforcement.sql',
    // P-008 (c) / D-077: `fed_hlc` + the stamp trigger — the migration that puts
    // agent_facts into the LWW regime its siblings were already in, so a fact
    // HAS a cell version to serve as the watermark cursor. Added in the SAME
    // edit as the migration, which is the discipline the 498/505/664 drift
    // comment above exists to enforce.
    '693-agent-facts-federation-stamp-regime.sql',
    // WI-6935 (b): `evicted_at` — stamped alongside `retracted_at` by the per-scope
    // cap so a machine eviction stops being indistinguishable from a deliberate
    // retract. Same discipline again: added in the SAME edit as the migration.
    '722-agent-facts-evicted-at.sql',
    // P-002 (agent-epistemics-2026-08-02): `settled_by` + the `undecidable` kind — the
    // durable "not decidable from available evidence, stop re-deriving" record, and the
    // exit condition that says what WOULD settle it. P-006's detector reads both off the
    // version chain, so this suite cannot exercise it without them.
    // ⚠ This entry was MISSING until 2026-08-02, which red-pinned the whole file after
    // migration 730 landed — the exact drift EI-18808675015292160's audit exists to name.
    '730-agent-facts-undecidable-kind.sql',
    // EI-20191740437408337: durable moving-subject snapshot metadata. Keep
    // this fixture list aligned with the live agent_facts migration set.
    '795-agent-facts-volatile-measurements.sql',
    // EI-20212953856919248: deliberate retractions retain their actor and reason.
    '801-agent-facts-retraction-reason.sql',
  ];
  // EI-18808675015292160: applies the list (EI-6887 strip semantics unchanged)
  // but AUDITS it first against the real sql/ dir — so the "list DRIFTED from the
  // real agent_facts migration set" failure described above now reds by NAMING the
  // missing file, instead of surfacing as `column "..." does not exist`.
  await applyMigrationsForTest(db.sql, migrations, {
    label: 'agent-facts/store.integration.test.ts',
  });
});
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.agent_facts');
});

// P-008 (c) / D-012 / D-077 — the cell version is minted by the REAL stamp
// trigger (mig 693) and must survive the fold, or the watermark surface has no
// cursor to advance. This is the leg that would have silently no-op'd if the
// trigger were stubbed: every fact would read cellVersion null and every delta
// would be empty forever, with all unit tests still green.
describe('P-008 (c) cell version (fed_hlc, migration 693)', () => {
  it('a locally-asserted fact gets an HLC cell version, and the fold serves it', async () => {
    await assertFact(
      { scope: 'harness', scopeRef: 'papercusp', key: 'cellv', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const folded = await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql);
    const f = folded.find((x) => x.key === 'cellv');
    expect(f).toBeDefined();
    expect(typeof f!.cellVersion).toBe('string');
    expect(f!.cellVersion).not.toBe('');
  });

  it('a CORRECTION mints a STRICTLY GREATER version — this is what makes it a delta cursor', async () => {
    await assertFact(
      { scope: 'harness', scopeRef: 'papercusp', key: 'moving', body: 'v1', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const first = (await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql)).find(
      (x) => x.key === 'moving',
    )!.cellVersion!;

    await assertFact(
      { scope: 'harness', scopeRef: 'papercusp', key: 'moving', body: 'v2', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const second = (await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql)).find(
      (x) => x.key === 'moving',
    )!.cellVersion!;

    // String comparison, because an HLC is a total order by construction — the
    // property that lets the cursor be one opaque token (D-012).
    expect(second > first).toBe(true);
  });

  it('the delta reports that correction as changed against the pre-correction cursor', async () => {
    await assertFact(
      { scope: 'harness', scopeRef: 'papercusp', key: 'watched', body: 'v1', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const before = await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql);
    // Bootstrap: records the position, reports nothing.
    const boot = factsCellDelta(before, '');
    expect(boot.changed).toEqual([]);

    await assertFact(
      { scope: 'harness', scopeRef: 'papercusp', key: 'watched', body: 'v2', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const after = await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql);
    const delta = factsCellDelta(after, boot.nextCursor);

    expect(delta.changed.map((f) => f.key)).toEqual(['watched']);
    expect(delta.changed[0].body).toBe('v2');
    expect(delta.nextCursor > boot.nextCursor).toBe(true);
  });
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

// EI-19952118814692217: `created_by` was the ONLY bind in assertFact's INSERT
// without a `?? null` coalesce. mode:set called assertFact directly (not through
// the facts:assert TOOL, which fills createdBy server-side) and omitted it, so
// postgres-js threw a driver-level `UNDEFINED_VALUE` before any row was written —
// and mode:set's bare `catch {}` discarded that error entirely, making the whole
// failure undiagnosable from logs. Every unit test stayed green because
// mode/set.test.ts MOCKS assertFact, so a missing required arg was invisible to it.
describe('createdBy binding (EI-19952118814692217 regression guard)', () => {
  it('succeeds with ONLY the documented-required fields — every other caller-omittable bind must coalesce', async () => {
    // Mirrors the actual failure shape: a direct (non-tool) caller supplying just
    // scope/scopeRef/key/body/createdBy/workspaceId and nothing else. Every
    // OPTIONAL AssertFactInput field left off here must resolve to a safe default
    // in the INSERT (`?? null` or equivalent) — an un-coalesced bind throws before
    // a row is ever written, exactly as `created_by` did.
    const fact = await assertFact(
      {
        scope: 'owner',
        scopeRef: 'su-required-fields-only',
        key: 'required-only',
        body: 'minimal required-field assert',
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    expect(fact.key).toBe('required-only');
    expect(fact.createdBy).toBe('su-int');
  });

  it('omitting createdBy fails LOUDLY with an attributable NOT NULL error, not a bare "undefined values" throw', async () => {
    // `createdBy` is REQUIRED in AssertFactInput — TypeScript refuses this at
    // compile time for any typed caller. This guards a caller that reaches the
    // store WITHOUT going through that type contract (mode:set's original direct
    // call did exactly this). Before the fix: postgres-js threw
    // `UNDEFINED_VALUE: Undefined values are not allowed` — a message naming no
    // column and no fix. After the fix (`${input.createdBy ?? null}`): the
    // NOT NULL constraint fires instead and names the actual column, which is
    // what makes the fail-soft catch's logged error diagnosable at all.
    const badInput = {
      scope: 'owner',
      scopeRef: 'su-missing-createdby',
      key: 'missing-createdby',
      body: 'no createdBy on purpose',
      workspaceId: WS,
      // createdBy deliberately omitted — the cast bypasses the type contract to
      // simulate a caller that skips it, the same shape as the original bug.
    } as unknown as Parameters<typeof assertFact>[0];
    await expect(assertFact(badInput, db.sql)).rejects.toThrow(/created_by/i);
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

  it('a deliberate retract preserves its actor and reason in version history', async () => {
    await assertFact({ ...base, body: 'temporary conclusion' }, db.sql);
    await retractFact(
      {
        scope: 'owner',
        scopeRef: 'su-v',
        key: 'ver',
        workspaceId: WS,
        retractedBy: 'su-auditor',
        reason: 'new live evidence superseded it',
      },
      db.sql,
    );
    const [version] = await factVersions({ ...base, limit: 1 }, db.sql);
    expect(version.retractedAt).not.toBeNull();
    expect(version.retractedBy).toBe('su-auditor');
    expect(version.retractionReason).toBe('new live evidence superseded it');
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

  it('WI-6935: a wall/dead-end fact survives a 51st assert — the typed safety slots are exempt from eviction', async () => {
    const scopeRef = 'su-slot-cap';
    const slotted = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };
    await assertFact({ ...slotted, key: 'wall:owner-must-ratify', body: 'HOLD — owner gate' }, db.sql);
    await assertFact({ ...slotted, key: 'dead-end:already-tried', body: 'do not re-try this' }, db.sql);

    // Fill well past the cap. Asserting these two FIRST makes them the
    // oldest-updated rows in the scope — precisely the victims the eviction's
    // `ORDER BY updated_at DESC OFFSET` ranking picks first. That ordering is why
    // the bug was certain rather than unlikely: a wall is asserted once and then
    // never touched again, so it sinks to the bottom of the victim ordering.
    for (let i = 0; i < FACTS_PER_SCOPE_CAP + 10; i++) {
      await assertFact({ ...slotted, key: `ordinary-${i}`, body: `n ${i}` }, db.sql);
    }

    const live = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    const keys = live.map((f) => f.key);
    // FIRST prove the cap actually BIT in this scope — otherwise the two
    // expectations below pass just as happily against an eviction that silently
    // no-op'd, and the guard would be vacuous. With the slots excluded from the
    // ranking, 60 ordinary facts are ranked and the 10 oldest-updated fall past
    // the cap: `ordinary-0` must be gone and `ordinary-<last>` must remain.
    expect(keys).not.toContain('ordinary-0');
    expect(keys).toContain(`ordinary-${FACTS_PER_SCOPE_CAP + 9}`);
    // Still LIVE, not merely still-present: eviction writes `retracted_at`, the same
    // field a deliberate retract writes, and listLapsedWallFacts filters
    // `retracted_at IS NULL` — so an evicted wall is invisible to the watchdog built
    // to page on exactly that wall.
    expect(keys).toContain('wall:owner-must-ratify');
    expect(keys).toContain('dead-end:already-tried');
  });

  it('WI-6935 (c): the cap evicts by DECLARED VALUE, not by write-recency', async () => {
    const scopeRef = 'su-value-rank';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // The two rows the OLD `ORDER BY updated_at DESC` ranking would have killed
    // FIRST, precisely because they are written once and never touched again.
    // Asserting them before the filler makes them the oldest-updated in the scope.
    await assertFact({ ...base, key: 'settled', body: 'a verified finding', confidence: 'verified' }, db.sql);
    await assertFact({ ...base, key: 'long-lived', body: 'deliberately given 90 days', ttlSec: 90 * 86400 }, db.sql);
    // …and a hedge, which SHOULD be the first thing sacrificed.
    await assertFact({ ...base, key: 'hedge', body: 'a hunch', confidence: 'suspected' }, db.sql);

    for (let i = 0; i < FACTS_PER_SCOPE_CAP; i++) {
      await assertFact({ ...base, key: `filler-${i}`, body: `n ${i}` }, db.sql);
    }

    const live = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    const keys = live.map((f) => f.key);
    // Prove the cap FIRED — without this the survival assertions below would pass
    // just as happily against an eviction that never ran (the vacuity trap the
    // sibling guard above was originally built with).
    expect(keys.length).toBeLessThanOrEqual(FACTS_PER_SCOPE_CAP);
    // The hedge is sacrificed first…
    expect(keys).not.toContain('hedge');
    // …while the verified finding and the deliberately long-lived fact survive,
    // even though both are the OLDEST-updated rows in the scope and would have been
    // the very first victims under the previous write-recency ranking.
    expect(keys).toContain('settled');
    expect(keys).toContain('long-lived');
  });

  it('WI-7292: an assert never evicts the row it just wrote, so a short-TTL fact can still enter a SATURATED scope', async () => {
    const scopeRef = 'su-self-eviction';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // Reproduce the live shape of harness:papercusp when this was measured:
    // saturated at exactly the cap, every incumbent verified and long-lived
    // (soonest survivor 7 days out, ZERO live facts under a 3-day TTL).
    for (let i = 0; i < FACTS_PER_SCOPE_CAP; i++) {
      await assertFact(
        { ...base, key: `incumbent-${i}`, body: `n ${i}`, confidence: 'verified', ttlSec: 30 * 86400 },
        db.sql,
      );
    }

    // The urgent, deliberately SHORT-lived fact — the class a fleet acts on within
    // the hour ("this alarm is false right now"). `expires_at DESC` is the #2 sort
    // key, so it ranks dead last and the pre-fix sweep retracted it as part of the
    // very statement that inserted it: written .710Z, evicted .714Z.
    await assertFact(
      { ...base, key: 'urgent', body: 'this alarm is false right now', confidence: 'verified', ttlSec: 3600 },
      db.sql,
    );

    const live = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    const keys = live.map((f) => f.key);

    // Non-vacuity FIRST: the cap must actually have BITTEN. Without this, "urgent
    // survived" proves nothing — it would survive just as happily in a scope where
    // eviction never ran at all (the trap the sibling guards above call out).
    expect(keys.length).toBe(FACTS_PER_SCOPE_CAP);
    expect(keys.filter((k) => k.startsWith('incumbent-')).length).toBe(FACTS_PER_SCOPE_CAP - 1);

    // The write survives its own assert — the whole point.
    expect(keys).toContain('urgent');

    // And state it at the row level too, because THAT is the shape of the bug: a
    // caller got ok:true with a future expiresAt while the row was already dead.
    const [row] = await db.sql<{ retracted_at: string | null; evicted_at: string | null }[]>`
      SELECT retracted_at::text, evicted_at::text
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner'
         AND scope_ref = ${scopeRef} AND key = 'urgent' AND superseded_at IS NULL`;
    expect(row.retracted_at).toBeNull();
    expect(row.evicted_at).toBeNull();
  });

  it('EI-19451909636567773: survival-ranking-matches-sweep — the receipt names THIS write as next, and the next assert evicts exactly that row', async () => {
    const scopeRef = 'su-survival-prediction';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // Saturated with long-lived `verified` incumbents.
    //
    // ⚠ This fixture changed with EI-19483432832662150. It used to make the
    // doomed row a SHORT-TTL write, because key 2 was `expires_at DESC`. Key 2
    // is now the remaining SHARE of declared TTL, and a fresh write always
    // scores ~1.0 — the maximum — so a new row can no longer be pushed last by
    // its TTL at all. The determinate last-place write is now one whose
    // CONFIDENCE ranks below the incumbents, which is what this pin needs: a
    // predictable victim, so "the row we named must be the row that dies" stays
    // a real assertion rather than a coin flip.
    for (let i = 0; i < FACTS_PER_SCOPE_CAP; i++) {
      await assertFact(
        { ...base, key: `incumbent-${i}`, body: `n ${i}`, confidence: 'verified', ttlSec: 30 * 86400 },
        db.sql,
      );
    }

    // The doomed write: a 'suspected' hedge in a scope of 'verified' findings.
    const doomed = await assertFact(
      { ...base, key: 'doomed', body: 'a hedge among findings', confidence: 'suspected', ttlSec: 30 * 86400 },
      db.sql,
    );

    // Non-vacuity FIRST: the cap must actually have BITTEN. Without this,
    // "ranked last" would be a claim about a scope where ranking never ran.
    expect(doomed.evicted?.length).toBeGreaterThan(0);

    // The half that used to be withheld.
    expect(doomed.survival).toBeDefined();
    expect(doomed.survival?.nextVictim).toBe(true);
    expect(doomed.survival?.rank).toBe(FACTS_PER_SCOPE_CAP);
    expect(doomed.survival?.liveCount).toBe(FACTS_PER_SCOPE_CAP);
    // It names the BAR this write failed to clear, in key 2's own units — a
    // share of declared life, not an absolute expiry. A fresh incumbent has
    // spent almost none of its TTL, so the bar sits just under 1.
    expect(doomed.survival?.survivingFractionFloor).not.toBeNull();
    expect(doomed.survival!.survivingFractionFloor!).toBeGreaterThan(0);
    expect(doomed.survival!.survivingFractionFloor!).toBeLessThanOrEqual(1);

    // ── THE PIN ────────────────────────────────────────────────────────────
    // A prediction is only worth printing if it comes true, and the JS ordering
    // that produced it is a hand-mirror of the sweep's SQL ORDER BY. This is
    // what stops the two drifting: a DIFFERENT author asserts, and the row we
    // named must be exactly the row that dies.
    const later = await assertFact(
      {
        ...base,
        createdBy: 'su-other-writer',
        key: 'a-later-write',
        body: 'by someone else entirely',
        confidence: 'verified',
        ttlSec: 30 * 86400,
      },
      db.sql,
    );
    expect(later.evicted?.map((e) => e.key)).toEqual(['doomed']);

    // …and it is really gone from the folds, which is the failure the author
    // would otherwise have experienced as silence.
    const live = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    expect(live.map((f) => f.key)).not.toContain('doomed');
  });

  it('EI-19483432832662150: an urgent SHORT-TTL fact is no longer doomed on arrival — the most-ELAPSED incumbent dies instead', async () => {
    const scopeRef = 'su-short-ttl-survives';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // Measured on the live scope 2026-08-04T01:19Z: an urgent 7-day operational
    // fact (a dev:restart blast-radius hazard) was evicted FIFTEEN SECONDS after
    // it was written, by the next agent's unrelated assert, because the pool was
    // full of incumbents holding later ABSOLUTE expiries. The scope's survival
    // floor had ratcheted to ~30 days, so nothing shorter could live in it.
    for (let i = 0; i < FACTS_PER_SCOPE_CAP; i++) {
      await assertFact(
        { ...base, key: `incumbent-${i}`, body: `n ${i}`, confidence: 'verified', ttlSec: 30 * 86400 },
        db.sql,
      );
    }

    // Age the whole cohort to EIGHT HOURS old, keeping the declared TTL at 30
    // days (both timestamps shift together). Without this the incumbents are
    // SECONDS old and the test is genuinely flaky, for a reason worth stating:
    // a 48-hour fact burns its declared share ~15× faster per wall-clock second
    // than a 30-day one, so against seconds-old incumbents the sub-second delay
    // between the write and the ranking query decides the verdict, and the same
    // code returns rank 41 on one run and LAST on the next. Both were observed.
    //
    // Eight hours is the regime actually measured in production, and it gives
    // the urgent write ~34 minutes of clear headroom — ample against a delay of
    // milliseconds, so the assertions below are decided by the RANKING and not
    // by how loaded the box was.
    await db.sql`
      UPDATE harness_shared.agent_facts
         SET created_at = now() - interval '8 hours',
             expires_at = now() + interval '30 days' - interval '8 hours'
       WHERE workspace_id = ${WS} AND scope = 'owner'
         AND scope_ref = ${scopeRef} AND key LIKE 'incumbent-%'
         AND superseded_at IS NULL AND retracted_at IS NULL`;

    // Age ONE incumbent much harder: 29 days into a 34-day life ⇒ ~0.15 left,
    // the worst in the scope. BOTH timestamps move, because backdating
    // created_at alone would LENGTHEN the declared TTL rather than consume it —
    // the fraction's denominator is (expires_at - created_at).
    //
    // Its absolute expiry (5 days out) is deliberately LATER than the urgent
    // write below (2 days). That is what makes this fixture DISCRIMINATE:
    //   • under the old `expires_at DESC`, the urgent write is last and dies;
    //   • under the fraction, it ranks top and this aged row dies instead.
    // Without that inversion the test would pass against the very bug it guards.
    await db.sql`
      UPDATE harness_shared.agent_facts
         SET created_at = now() - interval '29 days',
             expires_at = now() + interval '5 days'
       WHERE workspace_id = ${WS} AND scope = 'owner'
         AND scope_ref = ${scopeRef} AND key = 'incumbent-0'
         AND superseded_at IS NULL AND retracted_at IS NULL`;

    const urgent = await assertFact(
      {
        ...base,
        key: 'urgent-48h',
        body: 'a live hazard, true for about two days',
        confidence: 'verified',
        ttlSec: 48 * 3600,
      },
      db.sql,
    );

    // Non-vacuity: the cap BIT, so every verdict below came from a ranking that
    // actually ran — and it took the most-elapsed row, not the shortest-lived.
    expect(urgent.evicted?.map((e) => e.key)).toEqual(['incumbent-0']);

    // ── THE REGRESSION ASSERTION ───────────────────────────────────────────
    // This was `true` under `expires_at DESC`: the write arrived already last
    // in line, and the next assert by anyone destroyed it.
    expect(urgent.survival?.nextVictim).toBe(false);

    // Against 8h-old incumbents (~0.989 of their life left) a freshly-written
    // 48h fact holds ~0.99999, so it is the SAFEST row in the scope.
    expect(urgent.survival?.rank).toBe(1);

    // ⚠ Not a claim that a short-TTL fact now lives its full life. It does not:
    // both rows age, and this one loses ground 15× faster, so it falls to last
    // after ~34 minutes (solve t/172800 > (28800+t)/2592000). That is the fix
    // working as designed rather than a residual bug — at that crossover both
    // facts have spent ~1.19% of the life their authors declared, so they are
    // genuinely comparable losses. The change is 15 SECONDS → ~34 minutes, and
    // the removal of the TTL floor that made the scope structurally closed to
    // short-lived facts; it is not immortality, and should not be sold as it.
    expect(urgent.survival!.rank).toBeLessThan(urgent.survival!.liveCount);

    // …and it survives the NEXT writer, which is what actually killed the real
    // one. WI-7292 only ever exempted a row from its OWN assert.
    const later = await assertFact(
      {
        ...base,
        createdBy: 'su-other-writer',
        key: 'a-later-write',
        body: 'by someone else entirely',
        confidence: 'verified',
        ttlSec: 30 * 86400,
      },
      db.sql,
    );
    expect(later.evicted?.map((e) => e.key)).not.toContain('urgent-48h');

    const stillLive = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    expect(stillLive.map((f) => f.key)).toContain('urgent-48h');
  });

  it('EI-19451909636567773: a write that lands mid-ranking is NOT alarmed — a warning that always fires is one nobody reads', async () => {
    const scopeRef = 'su-survival-quiet';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // Short-lived incumbents this time, so a newcomer with a long TTL outranks
    // most of them rather than sinking to the bottom.
    for (let i = 0; i < FACTS_PER_SCOPE_CAP; i++) {
      await assertFact(
        { ...base, key: `incumbent-${i}`, body: `n ${i}`, confidence: 'verified', ttlSec: 3600 },
        db.sql,
      );
    }

    const safe = await assertFact(
      { ...base, key: 'well-declared', body: 'deliberately long-lived', confidence: 'verified', ttlSec: 90 * 86400 },
      db.sql,
    );

    // Non-vacuity: the cap bit here too, so `nextVictim:false` is a real verdict
    // from a ranking that ran — not the silence of a scope under its cap.
    expect(safe.evicted?.length).toBeGreaterThan(0);
    expect(safe.survival).toBeDefined();
    expect(safe.survival?.nextVictim).toBe(false);
    expect(safe.survival?.rank).toBe(1);
    // Nothing ranks above it, so there is no bar to report — and reporting one
    // anyway would imply a threat that does not exist.
    expect(safe.survival?.survivingFractionFloor).toBeNull();
  });

  it('WI-6935 (b): a cap eviction is distinguishable from a deliberate retract via evicted_at', async () => {
    const scopeRef = 'su-evicted-at';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // `deliberate` is asserted first and then explicitly retracted, so it carries a
    // retracted_at that the cap did NOT write — the control case.
    await assertFact({ ...base, key: 'deliberate', body: 'retract me on purpose' }, db.sql);
    await retractFact({ scope: 'owner', scopeRef, key: 'deliberate', workspaceId: WS }, db.sql);

    for (let i = 0; i < FACTS_PER_SCOPE_CAP + 10; i++) {
      await assertFact({ ...base, key: `ordinary-${i}`, body: `n ${i}` }, db.sql);
    }

    const rows = await db.sql<{ key: string; retracted: boolean; evicted: boolean }[]>`
      SELECT key,
             (retracted_at IS NOT NULL) AS retracted,
             (evicted_at   IS NOT NULL) AS evicted
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND superseded_at IS NULL
         AND key IN ('deliberate', 'ordinary-0')`;
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // Both rows are retracted — that is exactly the ambiguity this column resolves.
    expect(byKey.get('ordinary-0')?.retracted).toBe(true);
    expect(byKey.get('deliberate')?.retracted).toBe(true);
    // …and only the machine-chosen one is stamped evicted.
    expect(byKey.get('ordinary-0')?.evicted).toBe(true);
    expect(byKey.get('deliberate')?.evicted).toBe(false);
  });
});

// EI-19328780288425209: a retractFact miss is ambiguous — "never existed" vs "exists at a
// DIFFERENT scope" — the latter left a WRONG fact live and believed-retracted for 5h+ while
// the author had already told six agents it was gone. findFactKeyElsewhere is the disambiguator
// retract.ts calls on a miss, before reporting bare `retracted:false`.
describe('findFactKeyElsewhere (EI-19328780288425209 — the retract-scope-miss disambiguator)', () => {
  it('finds the SAME key live at a DIFFERENT scope/scopeRef', async () => {
    await assertFact(
      { scope: 'harness', scopeRef: 'papercusp', key: 'elsewhere-1', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const hits = await findFactKeyElsewhere(
      { scope: 'workspace', scopeRef: '', key: 'elsewhere-1', workspaceId: WS },
      db.sql,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.scope).toBe('harness');
    expect(hits[0]!.scopeRef).toBe('papercusp');
    expect(typeof hits[0]!.id).toBe('number');
  });

  it('is empty when the key truly does not exist anywhere', async () => {
    const hits = await findFactKeyElsewhere(
      { scope: 'workspace', scopeRef: '', key: 'genuinely-never-asserted-xyz', workspaceId: WS },
      db.sql,
    );
    expect(hits).toEqual([]);
  });

  it('excludes the scope actually searched — a hit there means retractFact should not have missed', async () => {
    await assertFact(
      { scope: 'owner', scopeRef: 'su-elsewhere', key: 'elsewhere-2', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const hits = await findFactKeyElsewhere(
      { scope: 'owner', scopeRef: 'su-elsewhere', key: 'elsewhere-2', workspaceId: WS },
      db.sql,
    );
    expect(hits).toEqual([]);
  });

  it('excludes a RETRACTED copy at another scope — retraction is not a live "elsewhere" hit', async () => {
    await assertFact(
      { scope: 'harness', scopeRef: 'papercusp', key: 'elsewhere-3', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    await retractFact({ scope: 'harness', scopeRef: 'papercusp', key: 'elsewhere-3', workspaceId: WS }, db.sql);
    const hits = await findFactKeyElsewhere(
      { scope: 'workspace', scopeRef: '', key: 'elsewhere-3', workspaceId: WS },
      db.sql,
    );
    expect(hits).toEqual([]);
  });
});

describe('P-008 (b) depends_on / kind / claim (migration 690)', () => {
  const base = { scope: 'owner' as const, scopeRef: 'su-d', key: 'dep', createdBy: 'su-int', workspaceId: WS };
  const dep = (over: Partial<FactDependency> = {}): FactDependency => ({
    cell: 'pipeline.myChange',
    observedAt: '2026-07-27T00:00:00.000Z',
    digest: 'abc123def4567890',
    observed: 'deployed',
    ...over,
  });
  const read = async () =>
    (await foldFacts([{ scope: 'owner', scopeRef: 'su-d' }], { workspaceId: WS, audiences: 'all' }, db.sql)).find(
      (f) => f.key === 'dep',
    );

  it('round-trips all three columns through assert → fold', async () => {
    await assertFact(
      {
        ...base,
        body: 'the reds are unrelated to my change',
        kind: 'assumption',
        confidence: 'suspected',
        dependsOn: [dep()],
        claim: { subject: 'cell:gate.greenCheckpoint.verdict', assertion: 'unrelated-to-my-change' },
      },
      db.sql,
    );
    const f = await read();
    expect(f?.kind).toBe('assumption');
    expect(f?.claim).toEqual({ subject: 'cell:gate.greenCheckpoint.verdict', assertion: 'unrelated-to-my-change' });
    expect(f?.dependsOn).toEqual([dep()]);
  });

  it('a fact with no declaration reads kind:null, claim:null and an EMPTY dependsOn (never null)', async () => {
    await assertFact({ ...base, body: 'plain' }, db.sql);
    const f = await read();
    expect(f?.kind).toBeNull();
    expect(f?.claim).toBeNull();
    // [] not null: "cannot go stale on declared terms" is one state, and every
    // consumer iterates it without a guard.
    expect(f?.dependsOn).toEqual([]);
  });

  it('an UNREADABLE dependency stores its unknown code instead of a digest — never an empty one', async () => {
    // The laundering this forbids: a blank digest would later compare EQUAL to
    // another failed read and certify the fact as fresh.
    await assertFact(
      { ...base, body: 'rests on something I could not read', dependsOn: [dep({ digest: undefined, unknown: 'not-measured' })] },
      db.sql,
    );
    const f = await read();
    expect(f?.dependsOn[0].digest).toBeUndefined();
    expect(f?.dependsOn[0].unknown).toBe('not-measured');
  });

  it('⚠ depends_on does NOT carry forward to a corrected version — it is an observation, not an identity', async () => {
    await assertFact({ ...base, body: 'one', dependsOn: [dep()] }, db.sql);
    await assertFact({ ...base, body: 'two' }, db.sql);
    // Inheriting the old digest would stamp a reading taken at v1's time onto a
    // claim made later, and it would fail in the CONFIDENT direction (reporting
    // fresh against an anchor that was never re-observed).
    expect((await read())?.dependsOn).toEqual([]);
    // …while the superseded version keeps its own, intact.
    const hist = await factVersions({ scope: 'owner', scopeRef: 'su-d', key: 'dep', workspaceId: WS }, db.sql);
    expect(hist[1].dependsOn).toEqual([dep()]);
  });

  it('normalizes on write: de-dupes by cell, drops anchorless entries, and bounds the list', async () => {
    await assertFact(
      {
        ...base,
        body: 'messy declaration',
        dependsOn: [
          dep({ cell: 'a' }),
          dep({ cell: 'a', observed: 'a second observation of the same cell' }), // dupe
          { cell: 'b', observedAt: '2026-07-27T00:00:00.000Z' } as FactDependency, // anchorless
          dep({ cell: 'c' }),
        ],
      },
      db.sql,
    );
    const f = await read();
    expect(f?.dependsOn.map((d) => d.cell)).toEqual(['a', 'c']);
    expect(f?.dependsOn[0].observed).toBe('deployed'); // FIRST occurrence wins
  });

  it('the DB CHECK rejects an out-of-vocabulary kind written around the store', async () => {
    await expect(
      db.sql`INSERT INTO harness_shared.agent_facts
               (workspace_id, scope, scope_ref, key, body, created_by, expires_at, kind)
             VALUES (${WS}, 'owner', 'su-d', 'bad-kind', 'x', 'su-int', now() + interval '1 day', 'guess')`,
    ).rejects.toThrow();
  });

  it('the store refuses an unknown kind as INVALID INPUT, not as a 500 from the CHECK', async () => {
    await expect(
      assertFact({ ...base, body: 'x', kind: 'hunch' as never }, db.sql),
    ).rejects.toThrow(/unknown kind/);
  });

  it('a version chain preserves each version OWN kind — a modality change is history, not a rewrite', async () => {
    await assertFact({ ...base, body: 'one', kind: 'assumption' }, db.sql);
    await assertFact({ ...base, body: 'two', kind: 'conclusion' }, db.sql);
    const hist = await factVersions({ scope: 'owner', scopeRef: 'su-d', key: 'dep', workspaceId: WS }, db.sql);
    expect(hist.map((h) => h.kind)).toEqual(['conclusion', 'assumption']);
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

// EI-20191740437408337: a measurement of a changing artifact is not a settled
// property. The metadata must survive the real SQL round-trip, and the store
// must impose the short TTL even when the caller omits ttlSec.
describe('volatile measurements (migration 795)', () => {
  const SEL = [{ scope: 'harness' as const, scopeRef: 'papercusp' }];
  const base = {
    scope: 'harness' as const,
    scopeRef: 'papercusp',
    body: 'currently 29 supported rows',
    createdBy: 'su-int',
    workspaceId: WS,
  };
  const measuredAt = '2026-08-11T20:50:00.000Z';

  it('measurement metadata round-trips and defaults the TTL to 15 minutes', async () => {
    await assertFact({ ...base, key: 'volatile-rt', subjectVolatile: true, measuredAt }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.measurement).toEqual({ subjectVolatile: true, measuredAt });
    const [row] = await db.sql<{ ttl_seconds: number }[]>`
      SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float AS ttl_seconds
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND key = 'volatile-rt' AND superseded_at IS NULL`;
    expect(row.ttl_seconds).toBeLessThanOrEqual(FACT_VOLATILE_MAX_TTL_SEC + 1);
  });

  it('a re-assert without the marker clears the prior snapshot metadata', async () => {
    await assertFact({ ...base, key: 'volatile-clear', subjectVolatile: true, measuredAt }, db.sql);
    await assertFact({ ...base, key: 'volatile-clear', body: 'the invariant is stable' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.measurement).toBeNull();
  });

  it('malformed stored metadata is fail-soft and never renders as a snapshot', async () => {
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, measurement)
      VALUES (${WS}, 'harness', 'papercusp', 'volatile-forged', 'b', 'peer', now() + interval '1 day',
              '{"subjectVolatile":true,"measuredAt":"not-a-date"}'::jsonb)`;
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.measurement).toBeNull();
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

/**
 * P-018 — the conventions layer against real PG. The unit suite pins the D-016
 * RULES; this pins that they survive a round-trip through the mig-692 column and
 * that the cross-scope discovery read actually selects what it claims to.
 */
describe('P-018 conventions — enforcement round-trip + cross-scope discovery', () => {
  const conv = (over: Record<string, unknown> = {}) => ({
    scope: 'workspace' as const,
    key: 'migrations-via-runner',
    body: 'Apply migrations via db:migrate, never a raw psql -f.',
    kind: 'convention' as const,
    createdBy: 'su-int',
    workspaceId: WS,
    ...over,
  });

  it('persists an enforcement tier and reads it back typed', async () => {
    const f = await assertFact(
      conv({ enforcement: { tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' } }),
      db.sql,
    );
    expect(f.enforcement).toEqual({ tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' });
    const [read] = await listConventionFacts({ workspaceId: WS }, db.sql);
    expect(read.enforcement).toEqual({ tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' });
    // The citable id carries the real version id, so it is checkable.
    expect(factCitationRef(read)).toMatch(/^fact:workspace:migrations-via-runner@v\d+$/);
  });

  it('a structural convention persists with no floor', async () => {
    const f = await assertFact(conv({ enforcement: { tier: 'structural' } }), db.sql);
    expect(f.enforcement).toEqual({ tier: 'structural' });
  });

  it('REFUSES a floorless gate at the STORE, not just the tool layer', async () => {
    await expect(assertFact(conv({ enforcement: { tier: 'gate' } }), db.sql)).rejects.toThrow(
      /requires floor and reviewBy/,
    );
    // …and nothing was written — a refused write must not leave a partial row.
    expect(await listConventionFacts({ workspaceId: WS }, db.sql)).toHaveLength(0);
  });

  it('REFUSES an enforcement tier on a non-convention', async () => {
    await expect(
      assertFact(conv({ kind: 'conclusion', enforcement: { tier: 'structural' } }), db.sql),
    ).rejects.toThrow(/only meaningful on kind:'convention'/);
  });

  it('the mig-692 CHECK rejects an out-of-vocabulary tier written OUT OF BAND', async () => {
    // The TypeScript validator is bypassable (a raw INSERT); the DB constraint is
    // the backstop that keeps the vocabulary closed either way.
    await expect(
      db.sql.unsafe(`
        INSERT INTO harness_shared.agent_facts
          (workspace_id, scope, scope_ref, key, body, created_by, expires_at, kind, enforcement)
        VALUES ('${WS}', 'workspace', NULL, 'smuggled', 'b', 'su-int', now() + interval '1 day',
                'convention', '{"tier":"prompt"}'::jsonb)`),
    ).rejects.toThrow(/agent_facts_enforcement_tier_check/);
  });

  it('discovery is CROSS-SCOPE — the caller need not know which scope it was filed under', async () => {
    await assertFact(conv({ key: 'ws-rule' }), db.sql);
    await assertFact(conv({ key: 'harness-rule', scope: 'harness', scopeRef: 'papercusp' }), db.sql);
    await assertFact(conv({ key: 'owner-rule', scope: 'owner', scopeRef: 'su-me' }), db.sql);
    const keys = (await listConventionFacts({ workspaceId: WS }, db.sql)).map((f) => f.key);
    expect(keys.sort()).toEqual(['harness-rule', 'owner-rule', 'ws-rule']);
  });

  it('scopeRefs narrows to the refs that govern YOU — but never hides a workspace rule', async () => {
    await assertFact(conv({ key: 'ws-rule' }), db.sql);
    await assertFact(conv({ key: 'mine', scope: 'owner', scopeRef: 'su-me' }), db.sql);
    await assertFact(conv({ key: 'theirs', scope: 'owner', scopeRef: 'su-someone-else' }), db.sql);
    const keys = (
      await listConventionFacts({ workspaceId: WS, scopeRefs: ['su-me'] }, db.sql)
    ).map((f) => f.key);
    expect(keys.sort()).toEqual(['mine', 'ws-rule']);
  });

  it('excludes non-conventions, retracted, and superseded versions', async () => {
    await assertFact(conv({ key: 'a-conclusion', kind: 'conclusion' }), db.sql);
    await assertFact(conv({ key: 'no-kind', kind: null }), db.sql);
    await assertFact(conv({ key: 'gone' }), db.sql);
    await retractFact({ scope: 'workspace', key: 'gone', workspaceId: WS }, db.sql);
    // A corrected convention returns ONCE — the current version, not both.
    await assertFact(conv({ key: 'revised', body: 'v1' }), db.sql);
    await assertFact(conv({ key: 'revised', body: 'v2' }), db.sql);
    const out = await listConventionFacts({ workspaceId: WS }, db.sql);
    expect(out.map((f) => f.key)).toEqual(['revised']);
    expect(out[0].body).toBe('v2');
  });
});

/**
 * P-008 (d) / D-050 / D-079 — assumption key RESOLUTION.
 *
 * These run against real PG because the whole question is what the LEDGER says,
 * and the distinction the gate turns on (lapsed vs never-existed) is invisible to
 * `foldFacts`, which filters expired/retracted/superseded rows out entirely. A
 * mocked read could not tell the two apart, which is the bug being prevented.
 */
describe('P-008 (d) assumption resolution (D-079)', () => {
  const base = {
    scope: 'owner' as const,
    scopeRef: 'su-me',
    body: 'the gate red is a flake',
    createdBy: 'su-int',
    workspaceId: WS,
  };
  const selectors = assumptionSelectorsFor({ workItemId: 'WI-1', ownerId: 'su-me', harnessSlug: 'papercusp' });
  const resolve = (declared: string[]) => resolveAssumptions(declared, selectors, { workspaceId: WS }, db.sql);

  it('resolves a live bare key and STAMPS the absolute versioned ref', async () => {
    const f = await assertFact({ ...base, key: 'gate-flake' }, db.sql);
    const [r] = await resolve(['gate-flake']);
    expect(r.condition).toBe('live');
    expect(r.ref).toBe(`fact:owner:su-me:gate-flake@v${f.id}`);
    expect(r.versionId).toBe(f.id);
    // The excerpt is what makes the record survive the 30d expiry sweep.
    expect(r.excerpt).toBe('the gate red is a flake');
  });

  it('an EXPIRED key resolves as lapsed — NOT dangling (the D-050 question)', async () => {
    await assertFact({ ...base, key: 'stale-hunch' }, db.sql);
    await db.sql`UPDATE harness_shared.agent_facts SET expires_at = now() - interval '1 hour'
                  WHERE workspace_id = ${WS} AND key = 'stale-hunch'`;
    const [r] = await resolve(['stale-hunch']);
    expect(r.condition).toBe('lapsed');
    expect(r.ref).toContain('stale-hunch');
    expect(r.excerpt).toBeTruthy();
  });

  it('a RETRACTED key resolves as retracted, not dangling', async () => {
    await assertFact({ ...base, key: 'withdrawn' }, db.sql);
    await retractFact({ scope: 'owner', scopeRef: 'su-me', key: 'withdrawn', workspaceId: WS }, db.sql);
    const [r] = await resolve(['withdrawn']);
    expect(r.condition).toBe('retracted');
  });

  it('a key that NEVER existed is the one thing that dangles', async () => {
    const [r] = await resolve(['never-asserted-anywhere']);
    expect(r.condition).toBe('dangling');
    expect(r.ref).toBeNull();
  });

  it('a bare key resolves to the CURRENT version after a correction', async () => {
    await assertFact({ ...base, key: 'revised', body: 'v1' }, db.sql);
    const v2 = await assertFact({ ...base, key: 'revised', body: 'v2' }, db.sql);
    const [r] = await resolve(['revised']);
    expect(r.condition).toBe('live');
    expect(r.versionId).toBe(v2.id);
    expect(r.excerpt).toBe('v2');
  });

  it('a version-pinned ref whose version was superseded reports superseded, pointing at the current one', async () => {
    const v1 = await assertFact({ ...base, key: 'pinned', body: 'first' }, db.sql);
    const v2 = await assertFact({ ...base, key: 'pinned', body: 'second' }, db.sql);
    const [r] = await resolve([`fact:owner:su-me:pinned@v${v1.id}`]);
    expect(r.condition).toBe('superseded');
    expect(r.versionId).toBe(v2.id);
    expect(r.excerpt).toBe('second');
  });

  it('most-specific scope wins, and the multi-scope hit is flagged ambiguous', async () => {
    await assertFact(
      { scope: 'workspace', key: 'shared-slug', body: 'workspace-wide', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    await assertFact({ ...base, key: 'shared-slug', body: 'mine' }, db.sql);
    const [r] = await resolve(['shared-slug']);
    expect(r.scope).toBe('owner');
    expect(r.excerpt).toBe('mine');
    expect(r.ambiguous).toBe(true);
  });

  it('a single-scope hit is NOT flagged ambiguous', async () => {
    await assertFact({ ...base, key: 'only-mine' }, db.sql);
    const [r] = await resolve(['only-mine']);
    expect(r.ambiguous).toBeUndefined();
  });

  /**
   * The reason absolute refs exist: a role-scoped fact cannot be reached by a
   * bare key (AgentIdentity carries no role), so it must stay citable explicitly.
   */
  it('an absolute ref resolves a scope OUTSIDE the caller selector set', async () => {
    await assertFact(
      {
        scope: 'role',
        scopeRef: 'engineer',
        key: 'role-rule',
        body: 'engineers do X',
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    expect((await resolve(['role-rule']))[0].condition).toBe('dangling');
    const [r] = await resolve(['fact:role:engineer:role-rule']);
    expect(r.condition).toBe('live');
    expect(r.scope).toBe('role');
    expect(r.excerpt).toBe('engineers do X');
  });

  it('a foreign hive partition is not the fact you asserted', async () => {
    await assertFact({ ...base, key: 'local-only' }, db.sql);
    await db.sql`UPDATE harness_shared.agent_facts SET source_hive = 'other-hive'
                  WHERE workspace_id = ${WS} AND key = 'local-only'`;
    expect((await resolve(['local-only']))[0].condition).toBe('dangling');
  });

  it('resolves a whole batch in ONE read, preserving caller order', async () => {
    await assertFact({ ...base, key: 'k-a' }, db.sql);
    await assertFact({ ...base, key: 'k-b' }, db.sql);
    const out = await resolve(['k-b', 'ghost', 'k-a']);
    expect(out.map((r) => r.key)).toEqual(['k-b', 'ghost', 'k-a']);
    expect(out.map((r) => r.condition)).toEqual(['live', 'dangling', 'live']);
  });
});

// ⚠ The `P-011 — assumptions in tension (real PG)` suite that stood here was
// REMOVED by WI-6545 / D-103 together with the detector it exercised. It is worth
// recording WHY a green, well-built suite was deleted rather than kept: it seeded
// its own contradictions. Every case constructed two assumptions itself and then
// proved the detector paired them — so it passed identically whether the fleet
// wrote assumptions or not, and it did so for the detector's entire life while the
// real corpus held 0 of 2,217. That is precisely the gap this plan was chartered to
// find: unit-green, production-unreachable. Do not restore these tests without a
// producer; they measure the fixture, not the plane.

/**
 * P-006 / D-001 — the PRODUCER contract the replacement dispute detector rests on.
 *
 * Read the note directly above first: the deleted suite failed because it seeded its own
 * contradictions and then proved the detector paired them, so it passed identically whether
 * the fleet produced any input or not. This suite deliberately does the opposite — it asserts
 * nothing about pairing or messaging (that is `facts/contested-key.test.ts`, pure and
 * fixture-driven by design). It pins only the three STORE behaviours the detector consumes,
 * each of which is produced by the ordinary `facts:assert` write path with no opt-in:
 *
 *   1. a re-assert stamps `supersedesId` (a first assert does not) — the gate that keeps the
 *      detector free on ~90% of writes, and, if it broke, would silently disable it entirely;
 *   2. `factVersions` returns the chain CURRENT-FIRST — the assessor reads chain[0] as "the
 *      version this write replaced", so a reversed order would misreport a settled key;
 *   3. the chain carries `createdBy`, `kind` and `settledBy` — the only three fields it reads.
 *
 * Every one of these is a real property of the plane. If any regresses, the detector goes
 * quiet rather than wrong, which is the failure mode that took two years to notice last time.
 */
describe('P-006 / D-001 — the version-chain producer the dispute detector consumes', () => {
  const base = { scope: 'owner' as const, scopeRef: 'su-me', createdBy: 'su-alice', workspaceId: WS };

  it('stamps supersedesId on a RE-assert and leaves it null on the first', async () => {
    const v1 = await assertFact({ ...base, key: 'gate-candidate', body: 'judging 1ee32228' }, db.sql);
    expect(v1.supersedesId ?? null).toBeNull();

    const v2 = await assertFact(
      { ...base, createdBy: 'su-bob', key: 'gate-candidate', body: 'judging 4a9b218b' },
      db.sql,
    );
    expect(v2.supersedesId).toBe(v1.id);
  });

  it('returns the chain CURRENT-FIRST, carrying createdBy / kind / settledBy', async () => {
    await assertFact({ ...base, key: 'k', body: 'answer A' }, db.sql);
    await assertFact({ ...base, createdBy: 'su-bob', key: 'k', body: 'answer B' }, db.sql);
    await assertFact(
      {
        ...base,
        createdBy: 'su-carol',
        key: 'k',
        body: 'not determinable from these fields',
        kind: 'undecidable',
        settledBy: 'the inFlightRetriage marker in harness_shared.routines',
      },
      db.sql,
    );

    const chain = await factVersions({ scope: 'owner', scopeRef: 'su-me', key: 'k', workspaceId: WS }, db.sql);
    expect(chain).toHaveLength(3);
    // chain[0] is the LIVE version — the one a fourth assert would replace.
    expect(chain[0]).toMatchObject({
      createdBy: 'su-carol',
      kind: 'undecidable',
      settledBy: 'the inFlightRetriage marker in harness_shared.routines',
    });
    expect(chain.map((c) => c.createdBy)).toEqual(['su-carol', 'su-bob', 'su-alice']);
    // Three DISTINCT authors on one key is the shape D-001 measured at ~1 occurrence per 14
    // days — rare, which is exactly why the detector must not also require them to be
    // simultaneous, and why the threshold sits at 2 rather than the drafted 3.
    expect(new Set(chain.map((c) => c.createdBy)).size).toBe(3);
  });

  it('a settled undecidable is reachable from the chain even after a later answer overwrites it', async () => {
    // The assessor deliberately only treats chain[0] as the settlement, but the earlier
    // undecidable must still be READABLE — that history is what makes a later "wait, this was
    // already declared unknowable" recoverable at all.
    await assertFact(
      { ...base, key: 'buried', body: 'cannot tell', kind: 'undecidable', settledBy: 'a primary read' },
      db.sql,
    );
    await assertFact({ ...base, createdBy: 'su-bob', key: 'buried', body: 'it is X' }, db.sql);

    const chain = await factVersions({ scope: 'owner', scopeRef: 'su-me', key: 'buried', workspaceId: WS }, db.sql);
    expect(chain[0]!.kind).not.toBe('undecidable');
    expect(chain[1]).toMatchObject({ kind: 'undecidable', settledBy: 'a primary read' });
  });
});

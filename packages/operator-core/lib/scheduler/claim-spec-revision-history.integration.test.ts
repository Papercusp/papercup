/**
 * claim-spec-revision-history.integration.test.ts — migration 810 (EI-18677010014746233 gap 2):
 * a destroyed claim spec must be RECOVERABLE.
 *
 * THE BUG. `cup_claim_specs` upserts in place behind a single `revision` integer, with no
 * history and no soft-delete. On 2026-07-26 a Mug that only wanted to READ fleet
 * `nonp2p-bug-drain-0725`'s lane called `scheduler:set_claim_spec { fleet, spec:{...probe...} }`
 * — a WRITE — which overwrote the authored lane (rev 6 -> 7) and widened it from matched:31 to
 * matched:1185, deleting the title-glob exclusion that kept that fleet off another fleet's
 * lane. The authored spec BYTES were gone; recovery was luck (the response happened to echo
 * `previousMatched:31`).
 *
 * WHY THIS IS A TRIGGER, AND WHY THAT IS WHAT THIS FILE ACTUALLY TESTS. Three separate
 * statements can destroy a spec today — the ON CONFLICT upsert, the scope-change
 * DELETE+INSERT txn, and clearClaimSpec's DELETE — so the property worth pinning is not "one
 * call site remembers to record" but "the row cannot leave the table unrecorded". Each case
 * below drives the TABLE directly rather than going through setClaimSpec(), which is the
 * point: if someone later adds a fourth write path, these tests still describe the guarantee.
 *
 * ⚠ FIXTURE-DRIFT CAVEAT (EI-9387: createFreshPgDb silently skips real migrations, so a
 * hand-rolled fixture can fall behind a renamed/added column and still pass). Migration 810
 * itself is applied from its REAL file — never re-typed here — so the object under test cannot
 * drift. The PARENT table is hand-rolled because reaching its current shape means chaining
 * 372 -> 389 -> 438 -> 555, and 438 installs triggers calling `capture_substrate_outbox`, a
 * function that does not exist in a fresh test DB. The mitigation is `it('pins the parent
 * columns the trigger reads')` below: the trigger dereferences exactly seven OLD.* columns, so
 * that test fails loudly if the fixture and the trigger ever disagree about them.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-spec-revision-history.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');

/** Read a real migration, stripping psql meta-commands + the runner's own txn wrapper. */
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

/**
 * The migration file under test, resolved by BOTH names. It is written at a `.DRAFT` path so
 * it stays invisible to boot auto-apply / db:migrate / the gate preflight while in progress,
 * and is armed by dropping that suffix — so this test must keep passing across the arming
 * step rather than needing an edit at exactly the wrong moment.
 */
const MIGRATION_810 = (() => {
  // PROBE_MIGRATION lets `scripts/mutation-probe.sh` point this test at a MUTATED COPY of the
  // migration OUTSIDE the tree, so falsifiability can be proven without ever editing the
  // shared checkout (where git-sync would happily commit the mutant mid-probe). Unset in every
  // normal run — this one line is what makes the safe tier available at all.
  const override = process.env.PROBE_MIGRATION;
  if (override) return readFileSync(override, 'utf8');
  for (const name of [
    '810-claim-spec-revision-history.sql',
    '810-claim-spec-revision-history.sql.DRAFT',
  ]) {
    try {
      return readMigration(name);
    } catch {
      /* try the next name */
    }
  }
  throw new Error(
    'migration 810 not found under either its armed or .DRAFT name in ' +
      SQL_DIR +
      ' — if it was renumbered, update this test with it.',
  );
})();

/**
 * The parent table at its CURRENT shape (post-555 rename to cup_claim_specs, post-438
 * harness_slug, post-389 id_only). See the fixture-drift caveat in the file header.
 */
const PARENT_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.cup_claim_specs (
      workspace_id text        NOT NULL DEFAULT 'default',
      bee_id       text        NOT NULL,
      spec         jsonb       NOT NULL,
      revision     integer     NOT NULL DEFAULT 0,
      id_only      boolean,
      harness_slug text,
      updated_by   text,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, bee_id)
  );
`;

/** Exactly the OLD.* columns migration 810's trigger function dereferences. */
const TRIGGER_READS = [
  'workspace_id',
  'bee_id',
  'revision',
  'spec',
  'harness_slug',
  'id_only',
  'updated_by',
] as const;

const WS = 'ws-history-probe';
const LANE = 'fleet:nonp2p-bug-drain-0725';

let db: FreshPgDb;

/** Seed an AUTHORED lane — the thing the 2026-07-26 incident destroyed. */
async function seedAuthoredLane(revision = 6) {
  await db.sql`
    INSERT INTO harness_shared.cup_claim_specs (workspace_id, bee_id, spec, revision, id_only, harness_slug, updated_by)
    VALUES (${WS}, ${LANE},
            ${db.sql.json({ revision, note: 'AUTHORED-LANE', not: ['p2p/*', 'federation/*'] })},
            ${revision}, false, 'papercusp', 'the-author')`;
}

async function history() {
  return (await db.sql`
    SELECT revision, cause, spec, harness_slug, id_only, updated_by
      FROM harness_shared.cup_claim_spec_revisions
     WHERE workspace_id = ${WS} ORDER BY id`) as unknown as {
    revision: number;
    cause: string;
    spec: { note?: string; not?: string[] };
    harness_slug: string | null;
    id_only: boolean | null;
    updated_by: string | null;
  }[];
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-spec-revision-history');
  await db.sql.unsafe(PARENT_DDL).simple();
  await db.sql.unsafe(MIGRATION_810).simple();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  // ORDER MATTERS, and getting it wrong is self-inflicted: clearing the PARENT fires the
  // delete trigger, which writes fresh history rows. Truncating history first and the parent
  // second leaves exactly the residue this cleanup was meant to remove — so drain the parent
  // FIRST, then the history it just generated.
  await db.sql`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id IN (${WS}, 'ws-other')`;
  await db.sql`DELETE FROM harness_shared.cup_claim_spec_revisions WHERE workspace_id IN (${WS}, 'ws-other')`;
});

describe('migration 810 — cup_claim_specs revision history', () => {
  it('pins the parent columns the trigger reads (guards fixture drift, EI-9387)', async () => {
    const cols = (await db.sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'cup_claim_specs'`) as unknown as {
      column_name: string;
    }[];
    const present = new Set(cols.map((c) => c.column_name));
    // If a future migration renames or drops one of these, the trigger breaks in production
    // while every behavioural test below would still pass against a stale fixture.
    expect([...TRIGGER_READS].filter((c) => !present.has(c))).toEqual([]);
  });

  it('RETAINS the authored spec when a probe-shaped write supersedes it (the 2026-07-26 incident)', async () => {
    await seedAuthoredLane(6);

    // Exactly what set_claim_spec's ON CONFLICT branch does: bump revision, replace spec —
    // here the real widening that deleted the exclusion predicate.
    await db.sql`
      UPDATE harness_shared.cup_claim_specs
         SET spec = ${db.sql.json({ revision: 7, note: 'probe', not: [] })}, revision = 7
       WHERE workspace_id = ${WS} AND bee_id = ${LANE}`;

    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cause).toBe('update');
    expect(rows[0]!.revision).toBe(6);
    // THE POINT: the exclusion predicate that the widening deleted is recoverable verbatim.
    expect(rows[0]!.spec.not).toEqual(['p2p/*', 'federation/*']);
    expect(rows[0]!.spec.note).toBe('AUTHORED-LANE');
    // The rest of the prior row travels with it, so the lane can be rebuilt, not just read.
    expect(rows[0]!.harness_slug).toBe('papercusp');
    expect(rows[0]!.id_only).toBe(false);
    expect(rows[0]!.updated_by).toBe('the-author');
  });

  it('RETAINS the spec when the row is DELETED (clearClaimSpec / scope-change tombstone)', async () => {
    await seedAuthoredLane(6);
    await db.sql`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = ${WS} AND bee_id = ${LANE}`;

    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cause).toBe('delete');
    expect(rows[0]!.revision).toBe(6);
    expect(rows[0]!.spec.note).toBe('AUTHORED-LANE');
  });

  it('does NOT record a no-op update (the WHEN clause is live, not inert)', async () => {
    await seedAuthoredLane(6);
    // Touches a column the history does not version. Recording this would dilute the history
    // with rows that restore nothing — and a WHEN clause that never suppresses anything is
    // indistinguishable from one that was dropped.
    await db.sql`
      UPDATE harness_shared.cup_claim_specs SET updated_by = 'someone-else'
       WHERE workspace_id = ${WS} AND bee_id = ${LANE}`;

    expect(await history()).toHaveLength(0);
  });

  it('keeps BOTH versions when a lane is cleared and re-created at a repeated revision', async () => {
    // The reason the PK is a surrogate `id` and not (workspace_id, bee_id, revision): clearing
    // a lane deletes the row, so a later set_claim_spec restarts the revision counter and the
    // natural key legitimately recurs. Under a natural PK this second write would be rejected
    // and the history silently lost — exactly what the table exists to prevent.
    await seedAuthoredLane(6);
    await db.sql`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = ${WS} AND bee_id = ${LANE}`;
    await seedAuthoredLane(6);
    await db.sql`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = ${WS} AND bee_id = ${LANE}`;

    const rows = await history();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.revision)).toEqual([6, 6]);
  });

  it('records the MOST RECENT prior version first for a recovery read', async () => {
    await seedAuthoredLane(6);
    await db.sql`
      UPDATE harness_shared.cup_claim_specs
         SET spec = ${db.sql.json({ revision: 7, note: 'v7' })}, revision = 7
       WHERE workspace_id = ${WS} AND bee_id = ${LANE}`;
    await db.sql`
      UPDATE harness_shared.cup_claim_specs
         SET spec = ${db.sql.json({ revision: 8, note: 'v8' })}, revision = 8
       WHERE workspace_id = ${WS} AND bee_id = ${LANE}`;

    const latestPrior = (await db.sql`
      SELECT revision, spec FROM harness_shared.cup_claim_spec_revisions
       WHERE workspace_id = ${WS} AND bee_id = ${LANE}
       ORDER BY superseded_at DESC, id DESC LIMIT 1`) as unknown as {
      revision: number;
      spec: { note?: string };
    }[];

    // "Undo the last write" must land on v7, not on the original v6.
    expect(latestPrior[0]!.revision).toBe(7);
    expect(latestPrior[0]!.spec.note).toBe('v7');
  });

  it('isolates history by workspace (RLS partition column is populated, not defaulted)', async () => {
    await seedAuthoredLane(6);
    await db.sql`
      INSERT INTO harness_shared.cup_claim_specs (workspace_id, bee_id, spec, revision)
      VALUES ('ws-other', ${LANE}, ${db.sql.json({ revision: 1, note: 'other-ws' })}, 1)`;
    await db.sql`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = 'ws-other'`;
    await db.sql`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = ${WS}`;

    const mine = await history();
    expect(mine).toHaveLength(1);
    expect(mine[0]!.spec.note).toBe('AUTHORED-LANE');
  });
});

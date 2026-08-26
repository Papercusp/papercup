/**
 * stamp-trigger-coverage.integration.test.ts — the LWW-STAMP coverage guard.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * A federated CDC table's local write is ordered on every peer by its HLC key
 * `fed_hlc`. That key is populated by the `stamp_local_federated_write_trg`
 * BEFORE trigger (mig-214 / mig-314): on a LOCAL INSERT/UPDATE it stamps fed_ts +
 * fed_hlc, and the AFTER `capture_substrate_outbox` trigger then threads
 * NEW.fed_hlc onto the captured op as `op_hlc` (mig-314 §3b). If a NEW federated
 * table ships its CAPTURE trigger — which `checkSubstrateCaptureCoverage`
 * (capture-coverage.test.ts) guards — but FORGETS the BEFORE stamp trigger, every
 * local write is captured with op_hlc = NULL: the op federates with no ordering
 * key, so LWW SILENTLY breaks (last-writer is indeterminate; replays misorder).
 *
 * Neither existing coverage guard catches this. `checkSubstrateCaptureCoverage`
 * proves a PRODUCER exists (table grain); `federated-column-completeness`
 * (sibling) proves every COLUMN survives the value-mapper (column grain). Both
 * stay GREEN while the BEFORE stamp trigger is missing — the op still flows, it
 * just carries a NULL clock. This was a live footgun while authoring mig-317
 * (pot_policy): the stamp trigger had to be remembered by hand, and nothing in
 * CI would have failed had it been omitted. This guard is that missing teeth.
 *
 * WHY AN INTEGRATION TEST (not a parse of the DDL files)
 * -----------------------------------------------------
 * The trigger is attached imperatively and scattered: the mig-214 `FOREACH`
 * loop over 11 tables, then a per-table `CREATE TRIGGER` in 316/317/318/…
 * Grepping the DDL is brittle (DROP/CREATE ordering, IF EXISTS, dynamic EXECUTE
 * format, future migrations). Mirroring the sibling completeness guard, this
 * migrates an empty DB 000-baseline → head through the REAL boot-path runner and
 * introspects `pg_trigger` + `information_schema.columns`, so a new federated
 * table that forgets the stamp trigger trips it automatically — no test edit.
 *
 * WHAT IT ASSERTS
 * ---------------
 * The invariant is keyed on the HLC column, not the table list, so it can't
 * false-positive on a table that legitimately doesn't order by fed_hlc:
 *
 *   For every CDC-captured federated table (`CDC_CAPTURED_TABLES`) that carries a
 *   `fed_hlc` column, the `stamp_local_federated_write_trg` BEFORE trigger MUST
 *   be attached — UNLESS the table is in `STAMP_EXEMPT` with a documented reason.
 *
 * The core assertion is an EXACT set-equality (not a subset): the set of
 * fed_hlc-bearing CDC tables that lack the stamp trigger must be EXACTLY
 * `STAMP_EXEMPT`. That single check has teeth in three directions —
 *   • a NEW federated table with fed_hlc but no trigger (the 317 footgun) →
 *     RED, "undocumented stamp-trigger gap",
 *   • removing a real trigger → RED,
 *   • a STALE exemption (the table since GAINED the trigger, or LOST fed_hlc) →
 *     RED, forcing the dead allow-list entry to be removed.
 * The live `harness_plan_parts` exemption doubles as the negative control: it
 * proves the detector really does flag a fed_hlc-bearing, trigger-less table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { CDC_CAPTURED_TABLES, cdcPhysicalTable } from '../feature-issue-op-keys';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot.
// Roles are cluster-global on the reused testcontainer, hence IF NOT EXISTS.
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

const STAMP_TRIGGER = 'stamp_local_federated_write_trg';

/**
 * CDC tables that carry a `fed_hlc` column but INTENTIONALLY do not attach the
 * BEFORE stamp trigger, EACH with the reason it is safe + the condition to
 * re-arm. An entry here is a documented design decision; a fed_hlc-bearing CDC
 * table NOT here that lacks the trigger is the bug this guard exists to catch.
 */
const STAMP_EXEMPT: Record<string, string> = {
  harness_plan_parts:
    'DARK / flag-gated (papercusp-plan-part-federation). mig-314 deliberately keeps ' +
    'the fed_ts=0/now baseline convention (federation.ts) until plan-part federation ' +
    'is GA — nothing writes harness_plan_parts with origin=local yet (mig-271 DARK ' +
    'note), and the LWW guard fed_ts fallback covers ordering meanwhile. REMOVE this ' +
    'entry (and attach the stamp trigger in the GA migration) when the flag flips. ' +
    '(mig-314 lines 160-163; findings-J)',
};

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'stamptrg',
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
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('federated CDC tables — every fed_hlc table has the LWW stamp trigger (stamp-coverage guard)', () => {
  /** harness_shared tables (real migrated schema) that have a `fed_hlc` column. */
  async function fedHlcTables(): Promise<Set<string>> {
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND column_name = 'fed_hlc'
    `;
    return new Set(rows.map((r) => r.table_name));
  }

  /** harness_shared tables that have the BEFORE stamp trigger attached. */
  async function stampTriggerTables(): Promise<Set<string>> {
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT c.relname AS table_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND t.tgname = ${STAMP_TRIGGER}
         AND NOT t.tgisinternal
    `;
    return new Set(rows.map((r) => r.table_name));
  }

  it('sanity: the stamp trigger exists on a representative federated table', async () => {
    const withTrigger = await stampTriggerTables();
    // pot_settings is one of the original mig-214 federated tables — if THIS is
    // absent the introspection query or the migration apply is broken, not the
    // invariant. Guards against a silently-empty set making the core check vacuous.
    expect(withTrigger.has('pot_settings'), 'stamp trigger introspection returned nothing — query/migration broken').toBe(
      true,
    );
  });

  it('every fed_hlc-bearing CDC table has the stamp trigger, except the documented STAMP_EXEMPT set', async () => {
    const withHlc = await fedHlcTables();
    const withTrigger = await stampTriggerTables();

    // The fed_hlc-bearing federated CDC tables that lack the stamp trigger. By the
    // invariant this must be EXACTLY the documented-exempt set. The trigger lives on the
    // PHYSICAL base relation (post-374 the work-item families are views over work_items,
    // which carries the trigger), so introspect cdcPhysicalTable(t).
    const missing = CDC_CAPTURED_TABLES.filter((t) => withHlc.has(t) && !withTrigger.has(cdcPhysicalTable(t))).sort();
    const exempt = Object.keys(STAMP_EXEMPT).sort();

    expect(
      missing,
      `Federated CDC table(s) carry a fed_hlc ordering key but are MISSING the ` +
        `'${STAMP_TRIGGER}' BEFORE trigger. Local writes will capture op_hlc = NULL, so ` +
        `the op federates with no LWW key and ordering silently breaks on peers. For each: ` +
        `attach the trigger in your migration (mirror 317/318), OR — if the table is ` +
        `intentionally DARK / does not order by fed_hlc — add it to STAMP_EXEMPT in this ` +
        `test with the reason + the condition to re-arm. ` +
        `Undocumented vs documented-exempt diff is the failure.\n` +
        `  fed_hlc-but-no-trigger: [${missing.join(', ')}]\n` +
        `  documented STAMP_EXEMPT:  [${exempt.join(', ')}]`,
    ).toEqual(exempt);
  });

  it('no STAMP_EXEMPT entry is stale (each is a real CDC table that still lacks the trigger)', async () => {
    const withHlc = await fedHlcTables();
    const withTrigger = await stampTriggerTables();
    const cdc = new Set(CDC_CAPTURED_TABLES);

    const stale: string[] = [];
    for (const t of Object.keys(STAMP_EXEMPT)) {
      // An exemption is stale if the table is no longer CDC-federated, no longer
      // carries fed_hlc, or has SINCE gained the trigger (the GA cutover landed) — on
      // its physical base relation.
      if (!cdc.has(t) || !withHlc.has(t) || withTrigger.has(cdcPhysicalTable(t))) stale.push(t);
    }
    expect(
      stale,
      `STAMP_EXEMPT has stale entr(ies) — the table now has the trigger (or no longer ` +
        `federates / lost fed_hlc). Remove the dead exemption: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('every table WITH the stamp trigger carries a fed_hlc column (the trigger writes it)', async () => {
    const withHlc = await fedHlcTables();
    const withTrigger = await stampTriggerTables();
    // The stamp function references NEW.fed_hlc unconditionally; a table with the
    // trigger but no fed_hlc column would error on every local write.
    const triggerWithoutHlc = [...withTrigger].filter((t) => !withHlc.has(t)).sort();
    expect(
      triggerWithoutHlc,
      `Table(s) have '${STAMP_TRIGGER}' but NO fed_hlc column — the stamp function sets ` +
        `NEW.fed_hlc and will error on every local write: ${triggerWithoutHlc.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * The symmetric half: the CAPTURE trigger must be PHYSICALLY attached in the
 * migrated DB for every CDC-captured table. `checkSubstrateCaptureCoverage`
 * (capture-coverage.test.ts) asserts a producer exists in the IN-CODE registry
 * (`CDC_CAPTURED_TABLES` derived from the op-key map) — but nothing checks the
 * DDL actually attached the trigger. A new table added to the op-key map whose
 * `CREATE TRIGGER … capture_*_outbox` migration was forgotten passes the in-code
 * guard yet NEVER federates (local writes drop on the floor). The per-table
 * behavioral federation tests only cover the tables someone wrote a test for.
 * This closes it at the live-schema grain, same harness as above.
 */
describe('federated CDC tables — capture trigger physically attached (DDL-attachment guard)', () => {
  /** harness_shared tables with a `capture_*_outbox` AFTER trigger attached. The
   *  trigger NAME varies per table (capture_harness_plan_parts_outbox_trg, …) but
   *  the FUNCTION is always one of the capture-outbox family — match on proname so
   *  the guard is robust to new per-table trigger names. */
  async function captureTriggerTables(): Promise<Set<string>> {
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT DISTINCT c.relname AS table_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = 'harness_shared'
         AND p.proname LIKE 'capture\\_%\\_outbox'
         AND NOT t.tgisinternal
    `;
    return new Set(rows.map((r) => r.table_name));
  }

  it('sanity: capture triggers introspect (a representative table is present)', async () => {
    const withCapture = await captureTriggerTables();
    // Post-374 harness_features_consolidated is a VIEW over work_items, which physically
    // carries the capture trigger — introspect the physical base relation.
    expect(
      withCapture.has(cdcPhysicalTable('harness_features_consolidated')),
      'capture-trigger introspection returned nothing — query/migration broken',
    ).toBe(true);
  });

  it('every CDC-captured table has its capture_*_outbox trigger attached in the migrated DB', async () => {
    const withCapture = await captureTriggerTables();
    // The capture trigger lives on the physical base relation (the work-item families are
    // views over work_items, which carries capture_work_items_outbox) — check that.
    const missing = CDC_CAPTURED_TABLES.filter((t) => !withCapture.has(cdcPhysicalTable(t))).sort();
    expect(
      missing,
      `CDC-captured table(s) are in the in-code op-key map (CDC_CAPTURED_TABLES) but have NO ` +
        `capture_*_outbox trigger in the migrated schema — their local writes are never enqueued ` +
        `to substrate_outbox, so they SILENTLY never federate. checkSubstrateCaptureCoverage stays ` +
        `GREEN (it only checks the in-code registry). Attach the capture trigger in your migration ` +
        `(mirror mig-271 / mig-317), or remove the table from the op-key map. Missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * THE ORPHANED-CAPTURE-FUNCTION GUARD (EI-21474657831529811)
 * ---------------------------------------------------------
 * Every guard above — and both siblings it names — walks TABLE → TRIGGER: start
 * from a declared table list, assert the DB attached something to it. That
 * direction is structurally blind to the converse defect: a capture FUNCTION that
 * no trigger calls. No table names it, so no table-driven check can ever reach it,
 * and it is invisible to `checkSubstrateCaptureCoverage` (in-code registry) too.
 *
 * That is not hypothetical. `capture_engineer_issues_outbox` (mig-197) was attached
 * to two triggers on `harness_shared.engineer_issues` when that was a BASE TABLE.
 * Post-374 the work-item families were inverted — `work_items` became the base
 * table and `engineer_issues` a VIEW over it — so the triggers could not survive
 * and issue rows federate via `capture_work_items_outbox` instead. The migration
 * dropped the triggers and left the FUNCTION behind: unreachable, hand-building an
 * outbox jsonb that mig-965's nine new issue-family columns never reached.
 *
 * The cost of an orphan is not wasted bytes, it is a FALSE DIAGNOSIS. It is named
 * exactly what an auditor of "why don't issue columns federate?" greps for, and it
 * reads as a complete and convincing answer — with a tempting fix that would change
 * nothing, because nothing calls it. Two agents were misled in this exact spot
 * before anyone ran the one query that distinguishes existing from running.
 *
 * So: a capture function's EXISTENCE is not evidence it runs. This asserts
 * reachability at the function grain, the one direction the other guards cannot see.
 */
describe('capture-outbox FUNCTIONS are all reachable (orphan-function guard)', () => {
  /**
   * Capture-outbox functions that NO non-internal trigger references. A function
   * here is dead code that reads like a live federation path.
   *
   * Documented exemptions go here with a reason — deliberately EMPTY, so the guard
   * has maximum teeth. An orphan is either wired up or dropped; "left lying around"
   * is the state this exists to forbid.
   */
  const ORPHAN_EXEMPT: Record<string, string> = {};

  /** All capture_*_outbox functions in harness_shared, with their trigger count. */
  async function captureFunctionAttachment(): Promise<Array<{ proname: string; triggers: number }>> {
    return await sql<Array<{ proname: string; triggers: number }>>`
      SELECT p.proname,
             (SELECT count(*)::int FROM pg_trigger t
               WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS triggers
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'harness_shared'
         AND p.proname LIKE 'capture\\_%\\_outbox'
       ORDER BY p.proname
    `;
  }

  it('sanity: the function population is NON-EMPTY and a known-attached fn reads as attached', async () => {
    const fns = await captureFunctionAttachment();
    // Without this, a query that matched ZERO functions (wrong schema, broken LIKE
    // escape, migrations not applied) yields a trivially-empty orphan set and the
    // core check below passes VACUOUSLY — an absence claim with no positive control,
    // which is the exact failure mode the guard is about. Assert we measured something.
    expect(fns.length, 'capture-function introspection returned NOTHING — query/migration broken').toBeGreaterThan(0);
    const substrate = fns.find((f) => f.proname === 'capture_substrate_outbox');
    expect(substrate, 'capture_substrate_outbox absent — migrations did not apply').toBeDefined();
    expect(substrate!.triggers, 'the workhorse capture fn reads as unattached — introspection is wrong').toBeGreaterThan(
      0,
    );
  });

  it('every capture_*_outbox function is attached to at least one trigger', async () => {
    const fns = await captureFunctionAttachment();
    const orphaned = fns
      .filter((f) => f.triggers === 0)
      .map((f) => f.proname)
      .filter((name) => !(name in ORPHAN_EXEMPT))
      .sort();

    expect(
      orphaned,
      `Capture function(s) exist in harness_shared but NO trigger calls them — dead code ` +
        `shaped exactly like a live federation path. Every table-driven guard stays GREEN ` +
        `(no table names an orphan, so none can see it). This usually means a migration ` +
        `retargeted or dropped the triggers — e.g. the table became a VIEW over another ` +
        `base table — and left the function behind. Fix it by DROPPING the function in a ` +
        `migration, or by attaching it if the capture is genuinely still wanted. Do not ` +
        `silence this by adding to ORPHAN_EXEMPT unless the function must provably stay ` +
        `unattached, with the reason written down. Orphaned: ${orphaned.join(', ')}`,
    ).toEqual([]);
  });
});

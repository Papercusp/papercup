/**
 * db-plan-shape-shipped-gucs.integration.test.ts — the SHIPPED-PROFILE PLAN-SHAPE GATE.
 *
 * ## The gap this closes
 *
 * Every Postgres knob we ship is computed by `deriveDatabaseTuning()` from the
 * HOST's cores + RAM, so the dev box and a user's laptop legitimately get very
 * different servers. Measured 2026-08-29 (WI-918476), the two profiles differ by
 * more than an order of magnitude on the one knob the PLANNER actually reads:
 *
 *   GUC                             dev box (128c/252G)   laptop (8c/16G, embedded)
 *   effective_cache_size            193,536 MB            8,192 MB      ← 24x
 *   work_mem                        64 MB                 35 MB
 *   max_parallel_workers_per_gather 8                     4
 *   random_page_cost                4.0 (PG default — absent from the derivation entirely)
 *
 * `effective_cache_size` is a pure planner hint: it is how the planner decides
 * whether the random I/O of an index scan will be served from cache or from the
 * disk that `random_page_cost = 4.0` prices at 4x a sequential page. At 189 GB
 * of assumed cache every index looks cheap and nearly any plan is fine. At 8 GB
 * it does not, and a query that index-scans here can sequentially scan there.
 *
 * That divergence is structurally invisible on this box. `pg-tuning-drift.ts`
 * — the one mechanism that inspects PG configuration — deliberately SKIPS
 * embedded Postgres, and its reasoning is correct as far as it goes: an
 * embedded cluster is launched with `-c` flags from the same derivation at
 * every boot, so it cannot DRIFT. But the shipped risk was never drift. It is
 * that the derivation is incomplete for hardware we never run on, and being
 * unable to drift is exactly what makes that permanent and undetectable.
 *
 * ## What this gate asserts, and why it is deterministic
 *
 * PLAN SHAPE, never timing. Wall-clock is not CI-stable; the choice between an
 * Index Scan and a Seq Scan is, because it is a pure function of the planner's
 * cost model over the catalog statistics — both of which we pin exactly below.
 *
 * Two independent assertions per case:
 *
 *   1. ABSOLUTE — at the SHIPPED profile the query must reach its table through
 *      an index. A case that seq-scans on both profiles is a real finding, and
 *      the agreement check alone would call it green.
 *   2. AGREEMENT — the plan must be the SAME shape at the dev profile and the
 *      shipped profile. This is the audit's actual question, self-calibrating:
 *      it needs no hand-tuned expected cost and goes red the moment a schema,
 *      index or derivation change makes the two hosts disagree.
 *
 * A permanent DIVERGENCE CONTROL (see `divergence control` below) proves the
 * agreement check can still fail. Without it, "every case agreed" is
 * indistinguishable from "the comparison is broken" — the whole population
 * passing is only evidence when something is known to be able to fail.
 *
 * ## Why the session can stand in for a whole server
 *
 * Every GUC that feeds the planner is `context: user` (verified against
 * pg_settings on this box: effective_cache_size, work_mem, random_page_cost,
 * seq_page_cost, cpu_tuple_cost, max_parallel_workers_per_gather, jit). The one
 * derived knob that is `postmaster`-only, `shared_buffers`, is NOT a planner
 * input at all — it sizes the real buffer pool, which changes execution time,
 * not plan choice. So a `SET` per profile reproduces each host's PLANNER
 * exactly, and this gate needs no second container and no bespoke fixture
 * mechanism: it runs on the shared integration testcontainer like every other
 * integration test.
 *
 * ## Why the statistics are written, not seeded
 *
 * Plan choice depends on table size, and the divergence we are hunting only
 * appears once a table is too big to be assumed cached. Seeding tens of
 * millions of rows per case is neither fast nor deterministic. The planner
 * reads `pg_class.reltuples` / `relpages`, so we seed a modest, realistically
 * DISTRIBUTED sample (which is what gives ANALYZE its column statistics:
 * n_distinct, correlation, MCVs) and then scale the two size counters to
 * production magnitude. The costing is then exactly the costing a laptop with a
 * real table that size would produce.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
import { deriveDatabaseTuning, type DatabaseTuning } from '@papercusp/resource-profile';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const GIB = 1024 * 1024 * 1024;

// Boot pre-migration step (roles + extensions), mirrored from
// embedded-postgres-server/src/index.js — same block fresh-migrate.integration.test.ts uses.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
      CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
    END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

/**
 * The two hosts, as {@link deriveDatabaseTuning} inputs.
 *
 * These are the ONLY hardcoded numbers in the gate, and they are HOST facts
 * (what machine), never GUC values (what Postgres gets) — every GUC below is
 * computed by the shipped derivation from these, so a change to the derivation
 * moves this gate with it instead of stranding a copied constant. `hostRole`
 * and `freeMemBytes` are required by the signal type but unread by
 * deriveDatabaseTuning; they are filled with the obvious value.
 */
const DEV_BOX_SIGNALS = {
  cores: 128,
  physicalCores: 128,
  totalMemBytes: 252 * GIB,
  freeMemBytes: 100 * GIB,
  embeddedPg: false,
  hostRole: 'full' as const,
};

/** A mainstream laptop running the shipped desktop app: 8 cores, 16 GB, embedded PG. */
const SHIPPED_LAPTOP_SIGNALS = {
  cores: 8,
  physicalCores: 8,
  totalMemBytes: 16 * GIB,
  freeMemBytes: 6 * GIB,
  embeddedPg: true,
  hostRole: 'full' as const,
};

const DEV_TUNING = deriveDatabaseTuning(DEV_BOX_SIGNALS);
const SHIPPED_TUNING = deriveDatabaseTuning(SHIPPED_LAPTOP_SIGNALS);

/**
 * Apply a derived profile's PLANNER-VISIBLE knobs to this session.
 *
 * Only the knobs the planner reads are set — the rest of `DatabaseTuning`
 * (max_connections, shared_buffers, wal_buffers, maintenance_work_mem) is about
 * capacity and execution, not plan choice, and `shared_buffers` cannot be set
 * per-session anyway. `random_page_cost` is set EXPLICITLY to Postgres's
 * default rather than left implicit: the derivation does not produce one today,
 * and writing the value we actually ship keeps that fact visible here. If the
 * derivation later grows a `randomPageCost`, switch this to read it — the
 * `randomPageCostFor` indirection is where that lands.
 */
function randomPageCostFor(_tuning: DatabaseTuning): number {
  // deriveDatabaseTuning() does not derive random_page_cost, so BOTH hosts
  // inherit PostgreSQL's built-in 4.0 (spinning-disk arithmetic). Measured and
  // reported 2026-08-29; a fix is tracked separately and is NOT in this scope.
  return 4.0;
}

async function applyProfile(sql: postgres.Sql, tuning: DatabaseTuning): Promise<void> {
  await sql.unsafe(`SET effective_cache_size = '${tuning.effectiveCacheSizeMb}MB'`);
  await sql.unsafe(`SET work_mem = '${tuning.workMemMb}MB'`);
  await sql.unsafe(`SET max_parallel_workers_per_gather = ${tuning.maxParallelWorkersPerGather}`);
  await sql.unsafe(`SET random_page_cost = ${randomPageCostFor(tuning)}`);
}

/** Every scan-ish node type Postgres can put at a leaf, split by what it means. */
const INDEX_ACCESS_NODES = new Set([
  'Index Scan',
  'Index Only Scan',
  'Bitmap Index Scan',
  'Bitmap Heap Scan',
]);
const SEQ_ACCESS_NODES = new Set(['Seq Scan']);

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

/**
 * The set of access-path node types this plan uses to reach `relation`,
 * normalized to `'index' | 'seq'`. Returns a SET rather than a single value
 * because a plan may reach one table by several paths (a BitmapOr, a partition
 * append); if any path is a Seq Scan the table is being scanned and the case
 * should say so.
 */
function accessPaths(plan: PlanNode, relation: string): Set<'index' | 'seq'> {
  const found = new Set<'index' | 'seq'>();
  const walk = (node: PlanNode): void => {
    const nodeType = node['Node Type'];
    // A Bitmap Index Scan names the INDEX in 'Index Name' and leaves 'Relation
    // Name' unset; its parent Bitmap Heap Scan carries the relation. Matching on
    // the heap node is therefore sufficient and avoids an index-name→table lookup.
    if (node['Relation Name'] === relation) {
      if (INDEX_ACCESS_NODES.has(nodeType)) found.add('index');
      else if (SEQ_ACCESS_NODES.has(nodeType)) found.add('seq');
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return found;
}

async function planFor(sql: postgres.Sql, query: string): Promise<PlanNode> {
  // FORMAT JSON, no ANALYZE — the planner runs, the query does not. COSTS stay
  // ON: they are not asserted on, but they are what a failure message needs to
  // explain WHY the planner chose what it chose.
  const rows = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${query}`);
  const explain = rows[0]['QUERY PLAN'] as unknown as Array<{ Plan: PlanNode }>;
  return explain[0].Plan;
}

interface PlanCase {
  /** What the query is for, in the words of the code that runs it. */
  readonly name: string;
  /** The table whose access path is being asserted. */
  readonly relation: string;
  readonly query: string;
  /**
   * The access path the SHIPPED profile must use. `'index'` for a real hot
   * query; `'seq'` only for the divergence control, which exists to fail.
   */
  readonly expectShipped: 'index' | 'seq';
  /**
   * Must the two profiles agree? True for every real case. The divergence
   * control sets this false and asserts the opposite — that is what proves the
   * agreement check is falsifiable rather than vacuously true.
   */
  readonly expectAgreement: boolean;
  readonly why: string;
}

/**
 * Production magnitudes for the tables under test, as (reltuples, relpages).
 * Taken from the live dev database 2026-08-29 rounded to an order of magnitude —
 * these model "a long-lived install", which is the state a laptop reaches and
 * the state in which a bad plan actually hurts.
 */
const TABLE_SCALE: ReadonlyArray<{ table: string; reltuples: number; relpages: number }> = [
  // ~10M turns across ~40k sessions; wide rows (message text), so pages/row is high.
  { table: 'harness_shared.session_turns', reltuples: 10_000_000, relpages: 1_200_000 },
  // ~20M invocations; narrow rows.
  { table: 'harness_shared.tool_invocations', reltuples: 20_000_000, relpages: 500_000 },
];

const CASES: readonly PlanCase[] = [
  {
    name: 'read one session\'s turns in order (sessions:read)',
    relation: 'session_turns',
    query: `SELECT turn_idx, speaker, text
              FROM harness_shared.session_turns
             WHERE session_id = 'probe-session-0007'
             ORDER BY turn_idx`,
    expectShipped: 'index',
    expectAgreement: true,
    why: 'session_turns_session_idx. Reading one session out of tens of thousands is the single hottest session-store access; a Seq Scan here reads the whole ~10 GB table to return a few dozen rows.',
  },
  {
    name: 'newest turns first (the ingest/backfill sweep window)',
    relation: 'session_turns',
    query: `SELECT session_id, turn_idx
              FROM harness_shared.session_turns
             ORDER BY ingested_at DESC
             LIMIT 100`,
    expectShipped: 'index',
    expectAgreement: true,
    why: 'session_turns_ingested_idx. ORDER BY + LIMIT is the shape where losing the index is worst: the alternative is not a cheap scan, it is a full sort of every row to return 100.',
  },
  {
    name: 'per-workspace tool telemetry, newest first',
    relation: 'tool_invocations',
    query: `SELECT tool_name, status, invoked_at
              FROM harness_shared.tool_invocations
             WHERE workspace_id = 'probe-ws' AND harness_slug = 'probe-harness'
             ORDER BY invoked_at DESC
             LIMIT 50`,
    expectShipped: 'index',
    expectAgreement: true,
    why: 'tool_invocations_telemetry_idx is a covering (workspace_id, harness_slug, invoked_at DESC) index built for exactly this query; if the planner declines it, the index is dead weight on every install.',
  },
  {
    name: 'recent invocations across all workspaces (the admin activity feed)',
    relation: 'tool_invocations',
    query: `SELECT tool_name, duration_ms, status
              FROM harness_shared.tool_invocations
             ORDER BY invoked_at DESC
             LIMIT 100`,
    expectShipped: 'index',
    expectAgreement: true,
    why: 'tool_invocations_invoked_at_cov_idx INCLUDEs every selected column, so this should be an Index Only Scan — the cheapest plan available and the one most sensitive to a pessimistic random_page_cost.',
  },
  {
    name: 'divergence control — moderate-selectivity range scan (MUST diverge)',
    relation: 'tool_invocations',
    query: `SELECT id
              FROM harness_shared.tool_invocations
             WHERE invoked_at > now() - interval '30 days'`,
    expectShipped: 'seq',
    expectAgreement: false,
    why: 'THE CALIBRATION CASE — permanent, and it is meant to fail the agreement check. An unbounded range predicate matching a large fraction of a 20M-row table sits exactly on the index-vs-seq cost boundary, which is where a 24x effective_cache_size gap changes the answer. If this case ever starts AGREEING, the comparison has stopped discriminating and every green above is uninformative — fix the instrument before trusting the population.',
  },
];

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `planshape_${randomBytes(5).toString('hex')}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  // max:1 — every SET below is session state, so all work must share one backend.
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  await sql.unsafe(BOOT_PREREQS_DDL);
  // The REAL migration set: this gate asserts plans against the indexes we
  // actually ship, not against a fixture's idea of them.
  await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });

  // The change-notify triggers NOTIFY per row; seeding through them is pure
  // overhead here and nothing under test reads them.
  await sql.unsafe(`ALTER TABLE harness_shared.session_turns DISABLE TRIGGER USER`);
  await sql.unsafe(`ALTER TABLE harness_shared.tool_invocations DISABLE TRIGGER USER`);

  // A representative SAMPLE — its job is to give ANALYZE realistic column
  // statistics (n_distinct, correlation, MCVs), not to reach production size.
  // 20k turns over 250 sessions ≈ 80 turns/session, the real ratio.
  await sql.unsafe(`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, speaker, text, ingested_at)
    SELECT 'probe-ws',
           'claude',
           'probe-session-' || lpad(((g / 80) % 250)::text, 4, '0'),
           g,
           CASE WHEN g % 2 = 0 THEN 'user' ELSE 'assistant' END,
           repeat('turn body ', 20),
           now() - (g || ' seconds')::interval
      FROM generate_series(1, 20000) AS g
  `);
  await sql.unsafe(`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status, invoked_at)
    SELECT CASE WHEN g % 50 = 0 THEN 'other-ws' ELSE 'probe-ws' END,
           CASE WHEN g % 37 = 0 THEN 'other-harness' ELSE 'probe-harness' END,
           'papercusp',
           'tool-' || (g % 120),
           'su',
           'spawn-' || (g % 900),
           to_char(now() - (g || ' seconds')::interval, 'YYYY-MM-DD-HH24'),
           CASE WHEN g % 23 = 0 THEN 'refused' ELSE 'ok' END,
           now() - (g || ' seconds')::interval
      FROM generate_series(1, 20000) AS g
  `);

  await sql.unsafe(`ANALYZE harness_shared.session_turns`);
  await sql.unsafe(`ANALYZE harness_shared.tool_invocations`);

  // Scale the two size counters the planner reads to production magnitude. The
  // column statistics ANALYZE just wrote are ratios (selectivity fractions), so
  // they stay correct at any table size; reltuples/relpages are absolute, and
  // they are the inputs that decide whether a table is "small enough to just
  // scan". Superuser-only, which harness_admin is on the test container.
  for (const { table, reltuples, relpages } of TABLE_SCALE) {
    await sql.unsafe(
      `UPDATE pg_class SET reltuples = ${reltuples}, relpages = ${relpages}
        WHERE oid = '${table}'::regclass`,
    );
  }
  // Autovacuum would ANALYZE these back down to the seeded size mid-run.
  for (const { table } of TABLE_SCALE) {
    await sql.unsafe(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
  }
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('plan shape at the SHIPPED embedded GUC profile', () => {
  it('the two profiles really do differ on the planner knob that matters', () => {
    // If this ever stops being true the whole gate is comparing a profile with
    // itself, and every agreement below passes for free. Assert the premise.
    expect(SHIPPED_TUNING.effectiveCacheSizeMb).toBeLessThan(
      DEV_TUNING.effectiveCacheSizeMb / 10,
    );
    expect(SHIPPED_TUNING.workMemMb).toBeLessThan(DEV_TUNING.workMemMb);
  });

  it('random_page_cost is the one knob on which the two hosts agree', () => {
    // Documented, not aspirational: the derivation produces no random_page_cost,
    // so both hosts inherit 4.0. This assertion exists so that ADDING one to the
    // derivation (the separately-tracked fix) makes this test fail loudly and
    // forces `randomPageCostFor` to start reading it rather than returning a
    // constant that has quietly gone wrong.
    expect(randomPageCostFor(DEV_TUNING)).toBe(randomPageCostFor(SHIPPED_TUNING));
    expect(Object.keys(SHIPPED_TUNING)).not.toContain('randomPageCost');
  });

  for (const testCase of CASES) {
    it(`${testCase.name}`, async () => {
      await applyProfile(sql, SHIPPED_TUNING);
      const shippedPlan = await planFor(sql, testCase.query);
      const shipped = accessPaths(shippedPlan, testCase.relation);

      await applyProfile(sql, DEV_TUNING);
      const devPlan = await planFor(sql, testCase.query);
      const dev = accessPaths(devPlan, testCase.relation);

      expect(
        shipped.size,
        `no access path to ${testCase.relation} found in the plan — the query or the relation name is wrong:\n${JSON.stringify(shippedPlan, null, 2)}`,
      ).toBeGreaterThan(0);

      // 1. ABSOLUTE — what the shipped profile actually does.
      expect(
        [...shipped].sort(),
        `${testCase.why}\n\nAt the SHIPPED profile (effective_cache_size=${SHIPPED_TUNING.effectiveCacheSizeMb}MB, work_mem=${SHIPPED_TUNING.workMemMb}MB, random_page_cost=${randomPageCostFor(SHIPPED_TUNING)}) this query reaches ${testCase.relation} via [${[...shipped].join(', ')}], expected [${testCase.expectShipped}].\n\nPlan:\n${JSON.stringify(shippedPlan, null, 2)}`,
      ).toEqual([testCase.expectShipped]);

      // 2. AGREEMENT — whether the dev box can still see what a laptop does.
      const agrees =
        shipped.size === dev.size && [...shipped].every((path) => dev.has(path));
      expect(
        agrees,
        testCase.expectAgreement
          ? `PLAN DIVERGENCE: this query takes [${[...dev].join(', ')}] on the dev box but [${[...shipped].join(', ')}] on a shipped laptop. It is therefore UNTESTABLE here by observation — it will look correct on every dev box forever. ${testCase.why}`
          : `The divergence control has stopped diverging: both profiles now take [${[...shipped].join(', ')}]. ${testCase.why}`,
      ).toBe(testCase.expectAgreement);
    });
  }
});

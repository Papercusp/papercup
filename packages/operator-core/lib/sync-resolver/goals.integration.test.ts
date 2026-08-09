/**
 * goals.integration.test.ts — the goals.* sync resolvers against REAL SQL.
 *
 * Plan: goal-mode-2026-08-07 (P-021).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Both resolvers shipped REFERENCING COLUMNS THAT DO NOT EXIST
 * (`wi.closed_at`, `wi.updated_at`; the real ones are the bigint epoch-ms
 * `closed_ts` / `updated_ts`), and nothing caught it:
 *
 *   - tsc cannot see inside a SQL template string;
 *   - every test on this path mocked the sync layer, so the SQL never ran;
 *   - the resolvers were recorded DONE on those green tests, and two UI
 *     surfaces (the rail Goal tab, the HUD goals tab) were then built on top
 *     of them and also recorded done.
 *
 * The whole goal UI was dead on arrival — `{"error":"column wi.closed_at does
 * not exist"}` for every goal read — and it stayed invisible because a mocked
 * resolver is green exactly as loudly as a working one. The first time the
 * query hit a real database was during P-021's live verification.
 *
 * So the guard has to RUN THE SQL. That is the only thing that fails on this
 * class, and it is why this file cannot be replaced by a faster unit test.
 *
 * ⚠ THE SCHEMA MUST COME FROM THE REAL MIGRATIONS — never a hand-rolled
 * `CREATE TABLE` fixture. A fixture is written by the same author, from the
 * same wrong belief about the schema, so it would happily declare `closed_at`
 * and keep this test green while production 500s. `applyPendingMigrations`
 * over the whole sql/ directory is what makes the assertion mean something.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   npm run test:file -- packages/operator-core/lib/sync-resolver/goals.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..');
const SQL_DIR = join(REPO, 'libs', 'papercusp', 'libs', 'db', 'sql');
const RUNNER = join(
  REPO,
  'libs',
  'papercusp',
  'packages',
  'embedded-postgres-server',
  'src',
  'migration-runner.js',
);

const WS = 'papercusp-workspace';
const GOAL = 'goal-under-test';

let db: MigratedTestDb;
let sql: Sql;

// The resolvers reach for their connection through `getOrgPg()` at call time
// (a dynamic import inside each function), so pointing that at the test
// database is all the wiring this needs.
//
// PARTIAL mock, deliberately: `resolveGoalsList` also imports the REAL
// `portfolioSpend` from this module, and a whole-module replacement silently
// removes it — which surfaces as "No portfolio export is defined on the mock"
// from inside the resolver, i.e. an error about MY test dressed up as one
// about the code under test.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql }),
}));

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

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: {
        client: Sql;
        sqlDir: string;
      }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    // A PARTIAL migration run would give this suite a schema that is neither
    // the real one nor an honest fixture — the worst of both, and it would
    // most likely fail in a way that reads as a resolver bug.
    if (appliedCount !== totalKnown) {
      throw new Error(`migrations incomplete: applied ${appliedCount} of ${totalKnown}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ provision });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 600_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.goals, harness_shared.goal_projects,
                     harness_shared.work_items, harness_shared.agent_usage_samples`;
});

async function goal(over: { killCriterion?: string | null; tripwires?: unknown } = {}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.goals (id, workspace_id, install_slug, title, body, status,
                                      budget_cents, kill_criterion, tripwires, created_at, updated_at)
    VALUES (${GOAL}, ${WS}, 'papercusp', 'Ship the thing', 'body', 'active', 50000,
            ${over.killCriterion === undefined ? 'Stop at day 30' : over.killCriterion},
            ${sql.json((over.tripwires ?? []) as never)}, now(), now())
  `;
}

async function project(
  slug: string,
  over: { role?: string; removedAt?: string | null; killCriterion?: string | null } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.goal_projects (workspace_id, goal_id, harness_slug, role,
                                              added_at, removed_at, kill_criterion, note)
    VALUES (${WS}, ${GOAL}, ${slug}, ${over.role ?? 'owner'}, now(),
            ${over.removedAt ?? null}, ${over.killCriterion ?? 'ship or stop'}, 'a note')
  `;
}

/**
 * `closed_ts` / `updated_ts` are BIGINT EPOCH-MS — the very columns the bug got
 * wrong, so the fixture writes them in their real type.
 *
 * ⚠ CLOSING A ROW TAKES BOTH a terminal `status` AND an explicit `closedTs`.
 * `stamp_work_item_closed_ts_trg` (BEFORE INSERT OR UPDATE) NULLs `closed_ts`
 * whenever the status is non-terminal, and on INSERT it deliberately never
 * INVENTS one — an already-terminal row arriving is a federated replica or a
 * restore, where stamping now() would record its ARRIVAL as its close. So a
 * timestamp without a terminal status is silently discarded, and a terminal
 * status without a timestamp leaves an honest NULL; either alone produces a row
 * that reads as still-open.
 */
async function workItem(
  id: string,
  over: {
    harness?: string;
    status?: string;
    closedTs?: number | null;
    needsHuman?: boolean;
    updatedTs?: number;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, status, item_kind, workspace_id, goal_id,
       created_ts, updated_ts, closed_ts, payload)
    VALUES (${over.harness ?? 'alpha'}, ${id}, ${`item ${id}`}, ${over.status ?? 'open'}, 'task',
            ${WS}, ${GOAL}, 0, ${over.updatedTs ?? 1_700_000_000_000}, ${over.closedTs ?? null},
            ${sql.json({ needsHuman: over.needsHuman ?? false } as never)})
  `;
}

/** A genuinely CLOSED row — both halves the trigger requires, in one place so
 *  no case can accidentally set only one of them. */
const CLOSED_AT = Date.parse('2026-08-03T12:00:00Z');
function closedItem(id: string, updatedTs = CLOSED_AT): Promise<void> {
  return workItem(id, { status: 'done', closedTs: CLOSED_AT, updatedTs });
}

async function usage(slug: string, tsMs: number, costUsd: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_usage_samples (workspace_id, ts, harness_slug, cost_usd, bucket_key)
    VALUES (${WS}, ${tsMs}, ${slug}, ${costUsd}, 'b')
  `;
}

describe('goals.* resolvers against real SQL', () => {
  it('resolveGoalsList RUNS — the assertion the whole file exists for', async () => {
    // Before the fix this threw `column wi.closed_at does not exist`. Every
    // mocked test on this path was green at the same moment.
    const { resolveGoalsList } = await import('./goals');
    await goal();
    await project('alpha');
    await workItem('WI-1');
    await workItem('WI-2', { status: 'done' });
    await workItem('WI-3', { needsHuman: true });

    const out = await resolveGoalsList({ workspaceId: WS });
    expect(out.goals).toHaveLength(1);
    const g = out.goals[0];
    expect(g.id).toBe(GOAL);
    expect(g.killCriterion).toBe('Stop at day 30');
    // Counters read through the epoch-ms columns: 2 open (WI-1, WI-3), 1 of
    // them parked on the owner. A wrong closed-column would count all three.
    expect(g.openWorkItems).toBe(2);
    expect(g.needsHuman).toBe(1);
    expect(g.projectCount).toBe(1);
  });

  it('resolveGoalDetail RUNS and returns every section the detail view reads', async () => {
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await project('alpha');
    await workItem('WI-open');
    await workItem('WI-wall', { needsHuman: true });
    await usage('alpha', Date.parse('2026-08-01T10:00:00Z'), 3);
    await usage('alpha', Date.parse('2026-08-02T10:00:00Z'), 8);

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      goal: { id: string } | null;
      projects: unknown[];
      waitingOnYou: Array<{ id: string; updatedAt: string | null }>;
      activity: Array<{ id: string; closedAt: string | null; updatedAt: string | null }>;
      spendByDay: Array<{ day: string; costUsd: number }>;
      spendLabel: string;
    };

    expect(out.goal?.id).toBe(GOAL);
    expect(out.projects).toHaveLength(1);
    expect(out.waitingOnYou.map((w) => w.id)).toEqual(['WI-wall']);
    expect(out.activity).toHaveLength(2);
    expect(out.spendByDay.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02']);
    expect(out.spendLabel).toBe('fleet spend');
  });

  it('converts the epoch-ms timestamps into something Date can parse', async () => {
    // The columns are bigint epoch-ms but the row mappers hand them to `iso()`,
    // which expects a Date/ISO string — so passing the raw number through would
    // yield a field that looks populated and parses to NaN downstream (every
    // row then silently renders "unknown age").
    const { resolveGoalDetail } = await import('./goals');
    const updated = Date.parse('2026-08-03T12:00:00Z');
    const before = Date.now();
    await goal();
    await project('alpha');
    await workItem('WI-done', { status: 'done', updatedTs: updated });

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      activity: Array<{ closedAt: string | null; updatedAt: string | null }>;
    };
    const row = out.activity[0];

    // `updated_ts` is ours to set, so it is asserted EXACTLY — this is the
    // conversion under test.
    expect(new Date(row.updatedAt as string).getTime()).toBe(updated);

    // `closed_ts` is stamped by the trigger at insert time, so it is asserted
    // as a real, parseable instant in a plausible window rather than a value
    // the test handed itself.
    expect(row.closedAt).not.toBeNull();
    const closedMs = new Date(row.closedAt as string).getTime();
    expect(Number.isFinite(closedMs)).toBe(true);
    expect(closedMs).toBeGreaterThanOrEqual(before - 60_000);
    expect(closedMs).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('KEEPS a removed project in the payload, carrying removedAt', async () => {
    // The detail view greys these rather than dropping them; the resolver is
    // the other half of that decision, so it is pinned on both sides.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await project('alpha');
    await project('beta', { role: 'contributing', removedAt: new Date().toISOString() });

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      goal: { projectCount: number };
      projects: Array<{ harnessSlug: string; removedAt: string | null }>;
    };
    expect(out.projects.map((p) => p.harnessSlug).sort()).toEqual(['alpha', 'beta']);
    expect(out.projects.find((p) => p.harnessSlug === 'beta')?.removedAt).not.toBeNull();
    // ...but a removed project must not inflate the ACTIVE count.
    expect(out.goal.projectCount).toBe(1);
  });

  it('returns { goal: null } for a goal that does not exist', async () => {
    const { resolveGoalDetail } = await import('./goals');
    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: 'nope' })) as { goal: null };
    expect(out.goal).toBeNull();
  });

  it('scopes to the workspace it was asked for', async () => {
    const { resolveGoalsList } = await import('./goals');
    await goal();
    const other = await resolveGoalsList({ workspaceId: 'some-other-workspace' });
    expect(other.goals).toHaveLength(0);
  });
});

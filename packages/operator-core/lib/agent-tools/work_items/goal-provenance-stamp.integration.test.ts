/**
 * goal-provenance-stamp.integration.test.ts — P-002/D-008's goal stamp, against REAL SQL.
 *
 * Plan: goal-mode-hardening-2026-08-10 (P-002, D-008). Filed by the post-completion
 * audit of that plan, which found this path verified NOWHERE.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `stampGoalProvenance` in _create-core.ts is the WRITE half of P-002: it is what
 * actually puts `work_items.goal_id` on an item so a goal's spend meter and its
 * "what belongs to this goal?" view can see the work its fleet did. At the time
 * this file was written it had:
 *
 *   - ZERO test references anywhere in the repo (`grep stampGoalProvenance
 *     --include=*.test.ts` returned nothing). Its resolver, `resolveGoalContext`,
 *     is thoroughly covered in modes/goal-context.test.ts — but that suite runs
 *     over a MOCK sql seam and never executes this UPDATE;
 *   - ZERO live executions: 0 of 37,579 rows in harness_shared.work_items carried
 *     a goal_id, and 0 of 4,692 session_briefs carried one, so production had
 *     never run it either.
 *
 * That combination is the exact shape of the bug this plan family ALREADY shipped
 * once. sync-resolver/goals.integration.test.ts exists because both goal resolvers
 * shipped referencing columns that do not exist (`wi.closed_at` for the real
 * `closed_ts`): tsc cannot see inside a SQL template string, every test mocked the
 * layer so the SQL never ran, and the whole goal UI was dead on arrival.
 *
 * HERE IT WOULD BE WORSE, because this one is SILENT. The call site wraps the
 * stamp in `try { ... } catch { }` with an empty body — deliberately, since losing
 * provenance must not fail a creation. But that means a broken UPDATE produces NO
 * error, NO log and NO degraded flag: the item is created and `goalId` is simply
 * absent from the result. That is indistinguishable from "this agent has no goal
 * context", which is the overwhelmingly common case. A wrong column name here
 * would look exactly like a quiet, healthy system forever.
 *
 * So the assertion has to RUN THE SQL against the REAL migrated schema. A
 * hand-rolled CREATE TABLE fixture would be written from the same belief about the
 * schema as the code, and would keep this green while production silently records
 * nothing.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   npm run test:file -- packages/operator-core/lib/agent-tools/work_items/goal-provenance-stamp.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..', '..');
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
const HARNESS = 'papercusp';
const GOAL_RUN = 'goal-the-agent-runs';
const GOAL_INHERITED = 'goal-the-agent-inherited';

let db: MigratedTestDb;
let sql: Sql;

// Same partial-mock discipline as sync-resolver/goals.integration.test.ts: the
// code under test reaches for its connection through getOrgPg() at call time, so
// repointing that is all the wiring needed. PARTIAL because _create-core also
// imports real helpers from neighbouring modules that a whole-module replacement
// would silently remove.
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
  // NOT engineer_issues — it is a VIEW over work_items with an INSTEAD-OF trigger
  // (the issue-family write path), so truncating it fails with "is not a table".
  // Clearing work_items clears what that view exposes.
  await sql`TRUNCATE harness_shared.goals, harness_shared.work_items,
                     harness_shared.session_briefs, harness_shared.agent_modes CASCADE`;
  for (const id of [GOAL_RUN, GOAL_INHERITED]) {
    await sql`
      INSERT INTO harness_shared.goals (id, workspace_id, install_slug, title, status, created_at, updated_at)
      VALUES (${id}, ${WS}, ${HARNESS}, ${'Goal ' + id}, 'active', now(), now())`;
  }
});

/** This session RUNS the goal — agent_modes.subject. Never inherited. */
async function givenRunsGoal(ownerId: string, goalId: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_modes (workspace_id, owner_id, axis_key, mode, subject, set_at, set_by)
    VALUES (${WS}, ${ownerId}, 'overlay:goal', 'goal', ${goalId}, now(), ${ownerId})`;
}

/** This session's WORK BELONGS TO the goal — session_briefs.goal_id, inherited at launch. */
async function givenInheritedGoal(ownerId: string, goalId: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, goal_id, first_seen_at, updated_at)
    VALUES (${ownerId}, ${WS}, ${goalId}, now(), now())
    ON CONFLICT (owner_id) DO UPDATE SET goal_id = EXCLUDED.goal_id, updated_at = now()`;
}

async function createItem(ownerId: string, title: string) {
  const { createOneWorkItem } = await import('./_create-core');
  return createOneWorkItem(
    { kind: 'task', title, harness: HARNESS, workspace: WS },
    { ownerId, workspaceId: WS, harnessSlug: HARNESS },
  );
}

async function storedGoalId(itemId: string): Promise<string | null> {
  const rows = await sql`
    SELECT goal_id FROM harness_shared.work_items
     WHERE feature_id = ${itemId} AND harness_slug = ${HARNESS} LIMIT 1`;
  return rows.length ? ((rows[0] as { goal_id: string | null }).goal_id ?? null) : null;
}

describe('goal provenance stamping (P-002/D-008) against real SQL', () => {
  // THE CASE THAT HAD NEVER RUN, in production or in a test. P-002 exists for
  // exactly this agent: a fleet member that inherited its launcher's goal and has
  // no goal-mode row of its own. Before P-002 its items stamped NULL and the fleet
  // doing the actual work was invisible to the goal.
  it('stamps an item created by an agent that INHERITED a goal', async () => {
    const owner = 'su-inheritor';
    await givenInheritedGoal(owner, GOAL_INHERITED);

    const res = await createItem(owner, 'work done by an inheriting fleet member');
    expect(res.ok, res.ok ? '' : `create failed: ${(res as { error?: string }).error}`).toBe(true);
    if (!res.ok) return;

    expect(await storedGoalId(res.workItem.id)).toBe(GOAL_INHERITED);
    expect(res.goalId).toBe(GOAL_INHERITED);
  });

  it('stamps an item created by the agent that RUNS the goal', async () => {
    const owner = 'su-runner';
    await givenRunsGoal(owner, GOAL_RUN);

    const res = await createItem(owner, 'work done by the goal agent itself');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(await storedGoalId(res.workItem.id)).toBe(GOAL_RUN);
  });

  // CONTROL, and the reason the assertions above mean anything. Without it a
  // stamper that wrote some constant — or a test DB where every row happened to
  // carry a goal — would pass every case above. This is also the shape of the
  // overwhelmingly common real call: an ordinary agent attached to no goal.
  it('CONTROL: leaves goal_id NULL for an agent attached to no goal', async () => {
    const res = await createItem('su-unattached', 'ordinary work, no goal anywhere');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(await storedGoalId(res.workItem.id)).toBeNull();
    expect(res.goalId).toBeUndefined();
  });

  // Precedence is load-bearing (D-008): an agent that BOTH runs a goal and was
  // launched under another must attribute its work to the goal it RUNS. The
  // opposite order silently re-parents a whole sub-portfolio to its grandparent.
  it('prefers the goal it RUNS over the goal it inherited', async () => {
    const owner = 'su-both';
    await givenInheritedGoal(owner, GOAL_INHERITED);
    await givenRunsGoal(owner, GOAL_RUN);

    const res = await createItem(owner, 'a sub-portfolio manager creating work');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(await storedGoalId(res.workItem.id)).toBe(GOAL_RUN);
  });

  // The UPDATE carries `AND goal_id IS NULL` so an explicit attribution outranks
  // the ambient session context. Asserted directly against the column, because
  // this is the one branch whose absence would be invisible through the result.
  it('never clobbers an attribution already on the row', async () => {
    const owner = 'su-inheritor';
    await givenInheritedGoal(owner, GOAL_INHERITED);

    const res = await createItem(owner, 'item that gets re-attributed');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    await sql`
      UPDATE harness_shared.work_items SET goal_id = ${GOAL_RUN}
       WHERE feature_id = ${res.workItem.id} AND harness_slug = ${HARNESS}`;

    const { createOneWorkItem } = await import('./_create-core');
    await createOneWorkItem(
      { kind: 'task', title: 'a second, unrelated item', harness: HARNESS, workspace: WS },
      { ownerId: owner, workspaceId: WS, harnessSlug: HARNESS },
    );

    expect(await storedGoalId(res.workItem.id)).toBe(GOAL_RUN);
  });

  it('does not stamp a pre-existing feature row when the WI allocator collides', async () => {
    const owner = 'su-feature-collision';
    await givenInheritedGoal(owner, GOAL_INHERITED);

    // Simulate a restored/federated row arriving while the local allocator is
    // stale. The production sequence-floor trigger normally prevents this, but
    // the writer must still handle the conflict safely if it occurs (including
    // on a database that has not yet applied that migration).
    await sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, summary, status, item_kind, workspace_id, created_ts, updated_ts)
      VALUES
        (${HARNESS}, 'WI-1', 'pre-existing incumbent', 'must not be rewritten', 'open', 'feature', ${WS}, 1, 1)`;
    await sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;

    const { createOneWorkItem } = await import('./_create-core');
    const res = await createOneWorkItem(
      { kind: 'feature', title: 'fresh feature after allocator collision', harness: HARNESS, pot: HARNESS, workspace: WS },
      { ownerId: owner, workspaceId: WS, harnessSlug: HARNESS },
    );
    expect(res.ok, res.ok ? '' : `create failed: ${(res as { error?: string }).error}`).toBe(true);
    if (!res.ok) return;

    expect(res.workItem.id).not.toBe('WI-1');
    const incumbent = await sql`
      SELECT title, goal_id FROM harness_shared.work_items
       WHERE harness_slug = ${HARNESS} AND feature_id = 'WI-1'`;
    expect(incumbent).toEqual([{ title: 'pre-existing incumbent', goal_id: null }]);
    expect(await storedGoalId(res.workItem.id)).toBe(GOAL_INHERITED);
  });
});

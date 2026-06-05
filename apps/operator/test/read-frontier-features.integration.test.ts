/**
 * read-frontier-features.integration.test.ts — plan harness-test-coverage-for-launch
 * P-011 (the highest-value, DBOS-free slice of the sweep).
 *
 * readFrontierFeatures is the SQL that picks a harness's dispatchable features on
 * the live DBOS frontier. Its two gates had no coverage:
 *   - the AUDITOR GATE: a remote-authored feature is NOT pickable until admitted
 *     (`origin='local' OR origin IS NULL OR audit_verdict='admit'`) — the exact
 *     clause that hard-failed every worker invoke when migration 097/098 was
 *     missing on the live box (the coord report). This is a fail-safe quarantine.
 *   - the STARTED-PLAN filter: a feature whose source_plan isn't a `started` plan
 *     is excluded.
 *
 * It takes a `pg` client, so no DBOS is needed to drive it (the SDK is mocked
 * only so the module imports). PREFIX-SCHEMA CAVEAT (D-004): the migration set
 * isn't self-contained, so createOrgTestDb stops ≈ at 056 — harness_plans (122,
 * carrying the op_status columns folded from the retired harness_plan_status/086)
 * and origin/audit_verdict (097/098) aren't applied. We add them in setup to
 * exercise the query's gate LOGIC; the baseline rebuild will make this
 * head-faithful for free.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from './_org-test-db';

// The module registers a workflow + scheduled tick at load; mock the SDK so
// importing it needs no DBOS runtime. readFrontierFeatures itself is pure SQL.
vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  }
  return {
    WorkflowQueue,
    DBOS: {
      registerWorkflow: (impl: unknown) => impl,
      registerScheduled: () => {},
      startWorkflow: () => () => Promise.resolve(),
      listWorkflows: async () => [],
      runStep: (fn: () => unknown) => fn(),
      getResult: async () => null,
    },
  };
});

// eslint-disable-next-line import/no-relative-packages -- exercise the real query
import { readFrontierFeatures } from '@papercusp/operator-core/lib/dbos/orchestrator-loop';

const WS = 'ws-frontier';
const SLUG = 'h';
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  // Patch the prefix schema up to what readFrontierFeatures needs (see caveat).
  await db.adminSql.unsafe(`
    ALTER TABLE harness_shared.harness_features_consolidated
      ADD COLUMN IF NOT EXISTS workspace_id  TEXT,
      ADD COLUMN IF NOT EXISTS blocked_by    TEXT[],
      ADD COLUMN IF NOT EXISTS feature_order INT,
      ADD COLUMN IF NOT EXISTS origin        TEXT,
      ADD COLUMN IF NOT EXISTS audit_verdict TEXT;
    -- Plans are PG-canonical: the started-plan dispatch gate reads
    -- harness_plans.op_status (folded from the retired harness_plan_status).
    CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
      workspace_id TEXT NOT NULL, harness_slug TEXT NOT NULL, plan_slug TEXT NOT NULL,
      op_status TEXT, op_priority INT, op_started_at TIMESTAMPTZ,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
  `);

  // Seed features exercising both gates.
  const f = async (
    feature_id: string,
    origin: string | null,
    audit_verdict: string | null,
    sourcePlan: string | null,
    order: number,
  ) => {
    // Use sql.json() with an OBJECT — `${jsonString}::jsonb` double-encodes into a
    // jsonb *string*, so metadata->>'source_plan' would come back null.
    const metadata = sourcePlan ? db.adminSql.json({ source_plan: sourcePlan }) : null;
    // origin is NOT NULL DEFAULT 'local' in the real schema (was nullable in the old
    // pre-baseline prefix this fixture used to build). A "no remote-origin concern"
    // feature is represented as 'local' — so coalesce the test's null to 'local'.
    await db.adminSql`
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, status, metadata, workspace_id, origin, audit_verdict, feature_order)
      VALUES (${SLUG}, ${feature_id}, 'todo', ${metadata}, ${WS}, ${origin ?? 'local'}, ${audit_verdict}, ${order})`;
  };
  await f('F-LOCAL', 'local', null, null, 1);
  await f('F-NULLORIGIN', null, null, null, 2); // origin→'local' (real schema is NOT NULL); pickable
  await f('F-REMOTE-PENDING', 'remote', 'pending', null, 3); // quarantined
  await f('F-REMOTE-ADMIT', 'remote', 'admit', null, 4); // admitted → pickable
  await f('F-PLAN-STARTED', 'local', null, 'p-on', 5); // plan started → pickable
  await f('F-PLAN-OFF', 'local', null, 'p-off', 6); // plan not started → excluded

  await db.adminSql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_status)
    VALUES (${WS}, ${SLUG}, 'p-on', 'started'), (${WS}, ${SLUG}, 'p-off', 'paused')`;
}, 90_000);

afterAll(async () => {
  if (db) await db.cleanup();
});

describe('readFrontierFeatures — auditor gate + started-plan filter', () => {
  it('quarantines un-admitted remote features and excludes un-started plans', async () => {
    const rows = await readFrontierFeatures(db.adminSql as never, WS, SLUG);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['F-LOCAL', 'F-NULLORIGIN', 'F-PLAN-STARTED', 'F-REMOTE-ADMIT']);
    // Explicit on the security-relevant exclusions:
    expect(ids).not.toContain('F-REMOTE-PENDING'); // remote, not admitted → gated
    expect(ids).not.toContain('F-PLAN-OFF'); // source_plan not 'started' → excluded
  });

  it('admitting a quarantined remote feature makes it pickable', async () => {
    await db.adminSql`
      UPDATE harness_shared.harness_features_consolidated
         SET audit_verdict = 'admit'
       WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND feature_id = 'F-REMOTE-PENDING'`;
    const ids = (await readFrontierFeatures(db.adminSql as never, WS, SLUG)).map((r) => r.id);
    expect(ids).toContain('F-REMOTE-PENDING');
  });

  it('scopes strictly by workspace + harness', async () => {
    const other = await readFrontierFeatures(db.adminSql as never, 'someone-elses-ws', SLUG);
    expect(other).toHaveLength(0);
  });
});

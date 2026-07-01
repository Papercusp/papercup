import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
const WS = 'ws-curation-deps-test';
const NOW = Date.now();
const T_FEATURE = NOW - 2 * 60 * 60 * 1000;
const T_ISSUE = NOW - 60 * 60 * 1000;
const T_DEDUP = NOW - 30 * 60 * 1000;

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activeWorkspaceId: () => WS,
}));

const { buildFleetReaders } = await import('./deps');
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('curation deps production readers (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    const sql = db.adminSql;

    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, updated_ts,
         created_by_github_user_id, terminal_owner, terminal_completion_ref)
      VALUES
        (${WS}, 'papercup', 'F-GENUINE', 'Shipped the dock workbench', 'passed', ${T_FEATURE},
         123, 'bee-1', 'merged PR #1'),
        (${WS}, 'papercup', 'F-DEDUP', 'Auto-closed duplicate work', 'passed', ${T_DEDUP},
         NULL, 'watchdog-auto-close', NULL),
        (${WS}, 'papercup', 'F-WIP', 'Still building', 'in_progress', ${T_FEATURE},
         123, NULL, NULL)`;

    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, state, updated_at,
         terminal_owner, terminal_completion_ref)
      VALUES
        (${WS}, 'EI-5', 'harness:papercup', 'Fixed the flaky watchdog tick', 'resolved',
         ${new Date(T_ISSUE)}, 'bee-2', 'fixed in PR #2'),
        (${WS}, 'EI-6', 'harness:papercup', 'Dedup-only closure', 'resolved',
         ${new Date(T_DEDUP)}, 'improvement-hygiene', NULL),
        (${WS}, 'operator', 'operator', 'Still-open friction', 'open',
         ${new Date(T_ISSUE)}, NULL, NULL)`;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('surfaces ONLY genuine completions from the unified work-items view', async () => {
    const completions = await buildFleetReaders().completions();
    expect(completions).toEqual([
      {
        workItemId: 'papercup#EI-5',
        harness: 'papercup',
        title: 'Fixed the flaky watchdog tick',
        userRequested: false,
        ref: 'wi:papercup#EI-5',
        ts: new Date(T_ISSUE).toISOString(),
      },
      {
        workItemId: 'papercup#F-GENUINE',
        harness: 'papercup',
        title: 'Shipped the dock workbench',
        userRequested: true,
        ref: 'wi:papercup#F-GENUINE',
        ts: new Date(T_FEATURE).toISOString(),
      },
    ]);
  });
});

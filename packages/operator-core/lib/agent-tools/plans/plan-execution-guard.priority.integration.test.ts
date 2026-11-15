import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { _resetForTests, getOrgPg, withPriorityOrgPg } from '@papercusp/db-org';
import { pgResultDiagnosticSnapshot } from '@papercusp/db-org/acquire-registry';
import { specFor } from '../../../../../apps/operator/scripts/hooks/inject/ports.mjs';
import { checkPlanExecutionGuard } from './plan-execution-guard';

let db: MigratedTestDb;
const keys = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'PAPERCUSP_PGBOUNCER'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'guardqueue' });
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  await _resetForTests();
  // Only the durable reader's tables are needed: this private owner has no bound
  // plan, so the real guard must finish its fresh census before returning null.
  await getOrgPg().sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE IF NOT EXISTS harness_shared.session_briefs (
      owner_id text, workspace_id text, current_plan_slug text, harness_slug text, control_state jsonb);
    CREATE TABLE IF NOT EXISTS harness_shared.adv_sessions (
      coord_owner_id text, workspace_id text, plan_slug text, ended_at timestamptz);
    CREATE TABLE IF NOT EXISTS harness_shared.plan_item_claims (
      owner text, workspace_id text, plan_slug text, harness_slug text, item_id text);
    CREATE TABLE IF NOT EXISTS harness_shared.work_items (
      taken_by text, workspace_id text, source_plan_slug text, harness_slug text, feature_id text, status text);
  `);
}, 120_000);

afterAll(async () => {
  await _resetForTests();
  await db?.drop();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await _resetForTests();
});

describe('native plan authority read queue reproduction (EI-27691198286861651)', () => {
  it('can miss the native wall in the priority client queue while an ordinary read succeeds', async () => {
    const ordinary = getOrgPg().sql;
    const preTool = specFor('pre-tool');
    if (!preTool) throw new Error('pre-tool port spec missing from hooks/inject/ports.mjs');
    const nativeWallMs = preTool.timeoutMs;
    const input = { ownerId: 'guard-queue-fixture', workspaceId: 'private-fixture',
      toolName: 'Write', args: { file_path: 'fixture.ts', content: 'fixture' } };

    await withPriorityOrgPg(async () => {
      const priority = getOrgPg().sql;
      // No guard or reader mocks: baseline and queued reads use the production
      // durable binding census, with private fixture data and real acquisition.
      expect(await checkPlanExecutionGuard(input)).toBeNull();
      const held = await Promise.all(Array.from({ length: priority.options.max }, () => priority.reserve()));
      let settled = false;
      const pending = checkPlanExecutionGuard(input).then(result => {
        settled = true;
        return result;
      });
      // Attach rejection handling before any assertion or cleanup can fail.
      void pending.catch(() => { settled = true; });
      try {
        expect((await ordinary`SELECT 42::int AS value`)[0].value).toBe(42);
        await delay(nativeWallMs + 100);
        expect(settled).toBe(false);
      } finally {
        for (const connection of held) connection.release();
        await pending;
      }
      expect(await pending).toBeNull();
      const completed = pgResultDiagnosticSnapshot('org-admin-priority').results.at(-1);
      expect(completed).toMatchObject({ status: 'ok' });
      expect(completed?.preBuildMs).toBeGreaterThanOrEqual(nativeWallMs);
    });
  }, 15_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { _resetForTests, getOrgPg, withPriorityOrgPg } from '@papercusp/db-org';
import { pgResultDiagnosticSnapshot } from '@papercusp/db-org/acquire-registry';
import { specFor } from '../../../../../apps/operator/scripts/hooks/inject/ports.mjs';
import { checkPlanExecutionGuard } from './plan-execution-guard';
import { orgTemplateKey, provisionOrgTemplate } from '../../../test/_org-test-db';

let db: MigratedTestDb;
const keys = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'PAPERCUSP_PGBOUNCER'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));

beforeAll(async () => {
  // The real migrated schema, as a template clone. This private owner has no bound plan, so
  // the real guard must finish its fresh census before returning null. An earlier version
  // hand-made only the census tables. When the census began reading work_items.plan_slug
  // and plan_line_id (ac9e07ff577), that hand-made copy lacked both columns. Every census
  // then threw, and the guard's catch reported plan_authority_unavailable
  // (WI-6554700010049377). A clone of the head schema cannot drift that way.
  db = await createFreshTestDb({ prefix: 'guardqueue', template: {
    key: orgTemplateKey(), provision: provisionOrgTemplate,
  } });
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  await _resetForTests();
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
      const recordedBefore = pgResultDiagnosticSnapshot('org-admin-priority').totalRecorded;
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
      // The census runs more than one query (the binding union, then held work). Only the
      // first one waits behind the held connections. So judge every result the queued census
      // recorded, not just the last one. Reading only the last result saw an instant
      // follow-up query (preBuildMs 0).
      const snapshot = pgResultDiagnosticSnapshot('org-admin-priority');
      const added = snapshot.totalRecorded - recordedBefore;
      expect(added).toBeGreaterThan(0);
      expect(added).toBeLessThanOrEqual(snapshot.results.length);
      const queued = snapshot.results.slice(-added);
      expect(queued.map(result => result.status)).toEqual(queued.map(() => 'ok'));
      expect(Math.max(...queued.map(result => result.preBuildMs ?? 0))).toBeGreaterThanOrEqual(nativeWallMs);
    });
  }, 15_000);
});

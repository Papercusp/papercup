/** Real-PG proof for the exact production entry point projected as blender:run-drill. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return {
    ...actual,
    getFlag: async (
      flag: Parameters<typeof actual.getFlag>[0],
      distinct: Parameters<typeof actual.getFlag>[1],
    ) =>
      flag === 'papercusp-scout-experiment-rail' || flag === 'papercusp-scout-rubric-rail'
        ? false
        : actual.getFlag(flag, distinct),
  };
});

import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- test DB URL cache reset
import { _resetUrlCacheForTests } from '../../../../libs/papercusp/libs/db/src/connection';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { registerHarnessProject } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { runBlenderRubricDrill } from './rubric-live-drill';

const WS = 'ws-live-blender-drill';
const HARNESS = 'live-blender-drill-it';
const NOW = Date.parse('2026-07-13T20:00:00.000Z');

describe('runBlenderRubricDrill — deployed production entry', () => {
  let db: OrgTestDb;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    db = await createOrgTestDb();
    saved.HARNESS_DATABASE_URL = process.env.HARNESS_DATABASE_URL;
    saved.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();
    await registerHarnessProject(db.adminSql, WS, HARNESS);
  }, 180_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetUrlCacheForTests();
    await _resetForTests();
    await db?.cleanup();
  }, 180_000);

  it('routes + grades a drill-only rubric idea without changing organic metrics', async () => {
    const result = await runBlenderRubricDrill({
      workspaceId: WS,
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      nowMs: NOW,
    });

    expect(result.ok, result.failures.join('; ')).toBe(true);
    expect(result.stop).toBe('completed');
    expect(result.evidence).toMatchObject({
      rubricSurfaced: true,
      routedRows: 1,
      groundedRows: 1,
      rubricGroundingCount: 1,
      gradedRows: 1,
      syntheticScorecard: true,
      syntheticRoutes: 1,
      organicMetricsUnchanged: true,
      organicCountersStable: true,
    });
    expect(result.organicAfter).toEqual(result.organicBefore);
    expect(result.routedRefs[0]).toMatch(/^wi:EI-/);
  }, 180_000);
});

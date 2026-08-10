/**
 * hive-git-mode-gc-arming — G-9 (p2p-git-live-activation-2026-07-09 P-205):
 * `setPotGitMode` IS the mode-flip call site hive-git-gc-routine.ts documents
 * as the owner of gc activation. Off-legacy must arm the hive-home's
 * `system:hive-git-gc` ephemeral routine; back-to-legacy (and a cleared
 * setting) must disarm it IN PLACE (row + cadence config kept for
 * re-activation). Before this seam existed, `upsertHiveGitGcRoutine` had no
 * production caller at all — a hive flipped off legacy ran every p2p leg with
 * gc never scheduled (unbounded namespace-ref growth).
 *
 * Fixture: the serve-wiring.integration.test.ts idiom — env-route the ambient
 * getOrgPg() at a throwaway migrated container so the no-sql production call
 * path is what's exercised, then a real Hive row (setPotGitMode enforces one
 * via getHiveBySlug).
 *
 * Run: npm run test:file -- packages/operator-core/lib/harness/git-sync/hive-git-mode-gc-arming.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes (not re-exported from the index) — same pattern as serve-wiring.integration.test.ts
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { insertHiveIfAbsent } from '../../hive-store';
import { setPotGitMode, getPotGitMode } from './hive-git-mode';
import {
  getPotGitGcRoutine,
  DEFAULT_POT_GIT_GC_INTERVAL_SEC,
  POT_GIT_GC_TARGET,
} from './hive-git-gc-routine';

const WORKSPACE_ID = `ws-gc-arm-${randomUUID().slice(0, 8)}`;
const HIVE = `hive-gc-arm-${randomUUID().slice(0, 8)}`;
const FAKE_PUBKEY = Buffer.alloc(32, 4).toString('base64');

describe('setPotGitMode — arms/disarms the hive-git gc routine (G-9, P-205)', () => {
  let db: OrgTestDb;
  let prevAppUrl: string | undefined;
  let prevAdminUrl: string | undefined;
  let prevPgb: string | undefined;
  let prevSkipDisc: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    prevAppUrl = process.env.HARNESS_DATABASE_URL;
    prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    prevPgb = process.env.PAPERCUSP_PGBOUNCER;
    prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    process.env.PAPERCUSP_PGBOUNCER = '0';
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();
    await insertHiveIfAbsent({
      workspaceId: WORKSPACE_ID,
      homeSlug: HIVE,
      pubkeyBase64: FAKE_PUBKEY,
      keychainId: 'k-gc-arm',
    });
  }, 120_000);

  afterAll(async () => {
    process.env.HARNESS_DATABASE_URL = prevAppUrl;
    process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
    if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
    if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
    await _resetForTests();
    _resetUrlCacheForTests();
    await db?.cleanup();
  });

  it('a hive that never left legacy has no gc routine row', async () => {
    expect(await getPotGitGcRoutine(getOrgPg().sql, HIVE)).toBeNull();
  });

  it('flipping off legacy arms the routine against the primary store', async () => {
    await setPotGitMode(WORKSPACE_ID, HIVE, 'bridged');
    expect(await getPotGitMode(WORKSPACE_ID, HIVE)).toBe('bridged');
    const routine = await getPotGitGcRoutine(getOrgPg().sql, HIVE);
    expect(routine).not.toBeNull();
    expect(routine!.active).toBe(true);
    expect(routine!.tier).toBe('ephemeral');
    expect(routine!.targetRole).toBe(POT_GIT_GC_TARGET);
    expect(routine!.triggerConfig).toMatchObject({
      pot_home_slug: HIVE,
      repo_key: HIVE,
      interval_sec: DEFAULT_POT_GIT_GC_INTERVAL_SEC,
    });
  });

  it('flipping back to legacy disarms in place — row + config survive', async () => {
    await setPotGitMode(WORKSPACE_ID, HIVE, 'legacy');
    const routine = await getPotGitGcRoutine(getOrgPg().sql, HIVE);
    expect(routine).not.toBeNull();
    expect(routine!.active).toBe(false);
    expect(routine!.triggerConfig).toMatchObject({ repo_key: HIVE });
  });

  it('re-arming after a legacy round-trip and disarming via a cleared setting', async () => {
    await setPotGitMode(WORKSPACE_ID, HIVE, 'p2p-only');
    expect((await getPotGitGcRoutine(getOrgPg().sql, HIVE))!.active).toBe(true);
    // Clearing the setting (mode: null → default-legacy) must also disarm.
    await setPotGitMode(WORKSPACE_ID, HIVE, null);
    expect(await getPotGitMode(WORKSPACE_ID, HIVE)).toBe('legacy');
    expect((await getPotGitGcRoutine(getOrgPg().sql, HIVE))!.active).toBe(false);
  });
});

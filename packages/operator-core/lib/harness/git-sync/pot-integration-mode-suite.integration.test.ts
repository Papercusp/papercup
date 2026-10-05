/**
 * pot-integration-mode-suite.integration.test.ts — plan pot-review-integration-mode-2026-10-05,
 * P-015 (spec SPEC-P-015-require-suite; decision D-007).
 *
 * The INTEGRATION leg of "choosing working-copy mode is refused for a pot that has no
 * green-gate test command configured". The unit tests in pot-integration-mode.test.ts
 * pin the guard with injected deps; this file drives the production functions against
 * the REAL hive-settings store (createOrgTestDb, real migrations) and reads the stored
 * row back. The spec's falsifier — "working-copy mode is saved for a pot whose green-gate
 * test command is empty" — is observed directly: if the guard regressed, getHiveSetting
 * would return 'review' and these assertions would fail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { insertHiveIfAbsent } from '../../hive-store';
import { getHiveSetting } from '../../hive-settings-store';
import {
  choosePotIntegrationMode,
  POT_INTEGRATION_SETTING_KEY,
  setPotIntegrationMode,
} from './pot-integration-mode';

const WS = 'ws-p015';
const pk = (fill: number): string => Buffer.alloc(32, fill).toString('base64');
const FORK = 'https://github.com/pot-owner/repo.git';

describe('SPEC-P-015-require-suite — working-copy mode needs a test suite (real hive-settings store)', () => {
  let db: OrgTestDb;
  let sql: Sql;

  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
    for (const [i, slug] of ['empty-cmd', 'blank-cmd', 'choose-empty', 'keeps-direct', 'has-suite'].entries()) {
      await insertHiveIfAbsent({ workspaceId: WS, homeSlug: slug, pubkeyBase64: pk(i + 1), keychainId: 'k' }, sql);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const stored = async (slug: string): Promise<unknown> =>
    (await getHiveSetting(WS, slug, POT_INTEGRATION_SETTING_KEY, sql))?.value ?? null;

  it('an empty test command refuses working-copy mode and stores nothing', async () => {
    const r = await setPotIntegrationMode({
      workspaceId: WS,
      potHomeSlug: 'empty-cmd',
      mode: 'review',
      greenCmd: '',
      forkRemote: FORK,
      sql,
    });
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(await stored('empty-cmd')).toBeNull();
  });

  it('a whitespace-only or missing test command is refused the same way', async () => {
    for (const greenCmd of ['   ', null, undefined]) {
      const r = await setPotIntegrationMode({
        workspaceId: WS,
        potHomeSlug: 'blank-cmd',
        mode: 'review',
        greenCmd,
        forkRemote: FORK,
        sql,
      });
      expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    }
    expect(await stored('blank-cmd')).toBeNull();
  });

  it('the guided switch refuses before creating a fork, and stores nothing', async () => {
    const ensureFork = vi.fn();
    const setForkRemote = vi.fn();
    const r = await choosePotIntegrationMode(
      {
        workspaceId: WS,
        potHomeSlug: 'choose-empty',
        harnessSlug: 'choose-empty',
        upstreamRemote: 'https://github.com/main-owner/repo.git',
        mode: 'review',
        greenCmd: '',
        forkRemote: null,
        sql,
      },
      { ensureFork, setForkRemote },
    );
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(ensureFork).not.toHaveBeenCalled();
    expect(setForkRemote).not.toHaveBeenCalled();
    expect(await stored('choose-empty')).toBeNull();
  });

  it('a refused switch leaves an existing direct setting untouched', async () => {
    const set = await setPotIntegrationMode({
      workspaceId: WS,
      potHomeSlug: 'keeps-direct',
      mode: 'direct',
      greenCmd: '',
      forkRemote: null,
      sql,
    });
    expect(set).toEqual({ ok: true, mode: 'direct' });
    const r = await setPotIntegrationMode({
      workspaceId: WS,
      potHomeSlug: 'keeps-direct',
      mode: 'review',
      greenCmd: '',
      forkRemote: FORK,
      sql,
    });
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(await stored('keeps-direct')).toBe('direct');
  });

  it('control: with a test command and a fork, working-copy mode IS saved', async () => {
    const r = await setPotIntegrationMode({
      workspaceId: WS,
      potHomeSlug: 'has-suite',
      mode: 'review',
      greenCmd: 'npm test',
      forkRemote: FORK,
      sql,
    });
    expect(r).toEqual({ ok: true, mode: 'review' });
    expect(await stored('has-suite')).toBe('review');
  });
});

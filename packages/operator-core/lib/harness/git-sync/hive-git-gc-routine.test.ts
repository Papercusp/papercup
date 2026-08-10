/**
 * Unit tests for hive-git-gc-routine.ts (G-9, p2p-git-live-activation-2026-07-09
 * / P-205). A fake Sql tagged-template captures the interpolated values (id,
 * install_slug, trigger_config json, active, tier, workspace_id) — no real PG.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  upsertPotGitGcRoutine,
  getPotGitGcRoutine,
  setPotGitGcRoutineActive,
  removePotGitGcRoutine,
  POT_GIT_GC_TARGET,
  POT_GIT_GC_ROUTINE_NAME,
  DEFAULT_POT_GIT_GC_INTERVAL_SEC,
} from './hive-git-gc-routine';

function fakeSql(rows: Array<Record<string, unknown>>) {
  const calls: unknown[][] = [];
  const fn = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return rows;
  });
  return { sql: fn as unknown as Sql, calls };
}

describe('upsertPotGitGcRoutine', () => {
  it('writes an ephemeral, active-by-default row keyed on the pot-home slug', async () => {
    const { sql, calls } = fakeSql([{ id: 'rt_shop_hive_pot_git_gc' }]);
    const out = await upsertPotGitGcRoutine(sql, {
      workspaceId: 'ws-1',
      potHomeSlug: 'shop-hive',
      repoKey: 'repo-1',
    });
    expect(out).toEqual({ id: 'rt_shop_hive_pot_git_gc' });
    const values = calls[0];
    // Order matches the tagged-template interpolation order in the module.
    // P-051: the row id derives from the NAME, so the rename re-keys the row —
    // which is why the three live rows had to be migrated in the same change
    // rather than left for the next upsert to reconcile (it would have INSERTed
    // a duplicate under the new key instead of updating in place).
    expect(values[0]).toBe('rt_shop-hive_pot-git-gc'.replace(/[^a-z0-9_]/gi, '_').toLowerCase());
    expect(values[1]).toBe('shop-hive'); // install_slug
    expect(values[2]).toBe(POT_GIT_GC_ROUTINE_NAME); // name
    const triggerConfig = JSON.parse(values[3] as string);
    expect(triggerConfig).toEqual({
      interval_sec: DEFAULT_POT_GIT_GC_INTERVAL_SEC,
      pot_home_slug: 'shop-hive',
      repo_key: 'repo-1',
    });
    expect(values[4]).toBe(POT_GIT_GC_TARGET);
    expect(values[5]).toBe(true); // active default
    expect(values[6]).toBe('ws-1');
  });

  it('honors an explicit intervalSec / keepPublishedRefsPerNamespace / active:false', async () => {
    const { sql, calls } = fakeSql([{ id: 'rt_x' }]);
    await upsertPotGitGcRoutine(sql, {
      workspaceId: 'ws-1',
      potHomeSlug: 'shop-hive',
      repoKey: 'repo-1',
      intervalSec: 1800,
      keepPublishedRefsPerNamespace: 3,
      active: false,
    });
    const values = calls[0];
    const triggerConfig = JSON.parse(values[3] as string);
    expect(triggerConfig).toEqual({
      interval_sec: 1800,
      pot_home_slug: 'shop-hive',
      repo_key: 'repo-1',
      keep_published_refs_per_namespace: 3,
    });
    expect(values[5]).toBe(false);
  });
});

describe('getPotGitGcRoutine', () => {
  it('returns null when no row exists', async () => {
    const { sql } = fakeSql([]);
    expect(await getPotGitGcRoutine(sql, 'shop-hive')).toBeNull();
  });

  it('maps a row to RoutineRow shape (defaults tier to ephemeral)', async () => {
    const { sql } = fakeSql([
      {
        id: 'rt_shop_hive_pot_git_gc',
        workspace_id: 'ws-1',
        install_slug: 'shop-hive',
        name: 'hive-git-gc',
        trigger_kind: 'cron',
        trigger_config: { interval_sec: 3600 },
        target_role: POT_GIT_GC_TARGET,
        payload_template: null,
        concurrency: 'skip',
        catchup: 'skip-old',
        tier: null,
        active: true,
        last_fired_at: null,
        next_fire_at: null,
        reschedule_interval_sec: null,
        target_owner_id: null,
      },
    ]);
    const row = await getPotGitGcRoutine(sql, 'shop-hive');
    expect(row).toMatchObject({ id: 'rt_shop_hive_pot_git_gc', tier: 'ephemeral', active: true, targetRole: POT_GIT_GC_TARGET });
  });
});

describe('setPotGitGcRoutineActive / removePotGitGcRoutine', () => {
  let calls: unknown[][];
  let sql: Sql;
  beforeEach(() => {
    ({ sql, calls } = fakeSql([{ id: 'rt_shop_hive_pot_git_gc' }]));
  });

  it('setActive returns true when a row was updated', async () => {
    expect(await setPotGitGcRoutineActive(sql, 'shop-hive', false)).toBe(true);
    expect(calls[0][0]).toBe(false);
    expect(calls[0][1]).toBe('shop-hive');
    expect(calls[0][2]).toBe(POT_GIT_GC_TARGET);
  });

  it('setActive returns false when no row matched', async () => {
    const empty = fakeSql([]);
    expect(await setPotGitGcRoutineActive(empty.sql, 'nobody-hive', true)).toBe(false);
  });

  it('remove returns true when a row was deleted, false when idempotent no-op', async () => {
    expect(await removePotGitGcRoutine(sql, 'shop-hive')).toBe(true);
    const empty = fakeSql([]);
    expect(await removePotGitGcRoutine(empty.sql, 'shop-hive')).toBe(false);
  });
});

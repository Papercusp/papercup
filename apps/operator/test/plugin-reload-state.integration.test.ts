/**
 * Integration test for apps/operator/lib/plugin-reload-state.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { withTestSchema } from '@papercusp/test-config';
import {
  savePluginReloadState,
  popPluginReloadState,
  clearPluginReloadState,
  MAX_STATE_BYTES,
} from '@papercusp/operator-core/lib/plugin-reload-state';

let sql: postgres.Sql;

beforeAll(async () => {
  const handle = await withTestSchema();
  sql = postgres(handle.connectionUri, { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.plugin_reload_state (
      plugin_id    TEXT NOT NULL,
      harness_slug TEXT NOT NULL,
      state        JSONB NOT NULL,
      byte_size    INTEGER NOT NULL,
      saved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (plugin_id, harness_slug)
    )
  `);
});

afterAll(async () => {
  if (sql) {
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS harness_shared CASCADE`); } catch {}
    await sql.end({ timeout: 5 });
  }
});

beforeEach(async () => {
  await sql.unsafe(`DELETE FROM harness_shared.plugin_reload_state`);
});

describe('plugin-reload-state save → pop round-trip', () => {
  it('saves and pops a structured state', async () => {
    const deps = { pluginId: 'p1', harnessSlug: 'h1', sql };
    const ok = await savePluginReloadState(deps, { lastSync: 12345, queue: [1, 2, 3] });
    expect(ok).toBe(true);
    const recovered = await popPluginReloadState(deps);
    expect(recovered).toEqual({ lastSync: 12345, queue: [1, 2, 3] });
  });

  it('pop deletes the row (one-shot semantics)', async () => {
    const deps = { pluginId: 'p1', harnessSlug: 'h1', sql };
    await savePluginReloadState(deps, { x: 1 });
    expect(await popPluginReloadState(deps)).toEqual({ x: 1 });
    expect(await popPluginReloadState(deps)).toBeUndefined();
  });

  it('pop on a missing row returns undefined', async () => {
    expect(
      await popPluginReloadState({ pluginId: 'nobody', harnessSlug: 'nowhere', sql }),
    ).toBeUndefined();
  });
});

describe('plugin-reload-state size cap', () => {
  it('rejects state > MAX_STATE_BYTES, drops silently', async () => {
    const deps = { pluginId: 'p1', harnessSlug: 'h1', sql };
    const big = { blob: 'x'.repeat(MAX_STATE_BYTES + 1) };
    const ok = await savePluginReloadState(deps, big);
    expect(ok).toBe(false);
    expect(await popPluginReloadState(deps)).toBeUndefined();
  });

  it('accepts state right at the cap', async () => {
    const deps = { pluginId: 'p1', harnessSlug: 'h1', sql };
    // 64KiB - JSON quote overhead
    const value = { blob: 'x'.repeat(MAX_STATE_BYTES - 20) };
    const ok = await savePluginReloadState(deps, value);
    expect(ok).toBe(true);
  });

  it('rejects non-JSON-serialisable values', async () => {
    const deps = { pluginId: 'p1', harnessSlug: 'h1', sql };
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const ok = await savePluginReloadState(deps, circular);
    expect(ok).toBe(false);
  });

  it('rejects undefined explicitly', async () => {
    const deps = { pluginId: 'p1', harnessSlug: 'h1', sql };
    expect(await savePluginReloadState(deps, undefined)).toBe(false);
  });
});

describe('plugin-reload-state isolation', () => {
  it('save overwrites previous state for the same (plugin, harness)', async () => {
    const deps = { pluginId: 'p1', harnessSlug: 'h1', sql };
    await savePluginReloadState(deps, { v: 1 });
    await savePluginReloadState(deps, { v: 2 });
    expect(await popPluginReloadState(deps)).toEqual({ v: 2 });
  });

  it('different (plugin, harness) pairs are independent', async () => {
    const a = { pluginId: 'A', harnessSlug: 'h1', sql };
    const b = { pluginId: 'B', harnessSlug: 'h1', sql };
    const c = { pluginId: 'A', harnessSlug: 'h2', sql };
    await savePluginReloadState(a, { who: 'A-h1' });
    await savePluginReloadState(b, { who: 'B-h1' });
    await savePluginReloadState(c, { who: 'A-h2' });
    expect(await popPluginReloadState(a)).toEqual({ who: 'A-h1' });
    expect(await popPluginReloadState(b)).toEqual({ who: 'B-h1' });
    expect(await popPluginReloadState(c)).toEqual({ who: 'A-h2' });
  });

  it('clear removes without reading', async () => {
    const deps = { pluginId: 'p1', harnessSlug: 'h1', sql };
    await savePluginReloadState(deps, { x: 1 });
    await clearPluginReloadState(deps);
    expect(await popPluginReloadState(deps)).toBeUndefined();
  });
});

/**
 * Integration test for apps/operator/lib/plugin-kv.ts.
 *
 * Boots a testcontainers Postgres, applies a minimal version of
 * Migration 054 (plugin_kv table + indexes), exercises get/set/delete/
 * list, per-key and per-plugin quotas, key validation, and namespace
 * isolation across (plugin_id, harness_slug) pairs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { withTestSchema } from '@papercusp/test-config';
import {
  makePluginKv,
  DEFAULT_MAX_BYTES_PER_KEY,
  DEFAULT_MAX_BYTES_PER_PLUGIN,
} from '@papercusp/operator-core/lib/plugin-kv';
import { KvQuotaError } from '@papercusp/plugin-sdk';

let sql: postgres.Sql;

beforeAll(async () => {
  const handle = await withTestSchema();
  sql = postgres(handle.connectionUri, { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.plugin_kv (
      plugin_id    TEXT NOT NULL,
      harness_slug TEXT NOT NULL,
      key          TEXT NOT NULL,
      value        JSONB NOT NULL,
      byte_size    INTEGER NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (plugin_id, harness_slug, key)
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
  await sql.unsafe(`DELETE FROM harness_shared.plugin_kv`);
});

describe('plugin-kv basic ops', () => {
  it('set then get round-trips JSON-serialisable values', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    await kv.set('a', { x: 1, y: 'two' });
    await kv.set('b', [1, 2, 3]);
    await kv.set('c', 'just a string');
    await kv.set('d', null);

    expect(await kv.get('a')).toEqual({ x: 1, y: 'two' });
    expect(await kv.get('b')).toEqual([1, 2, 3]);
    expect(await kv.get('c')).toBe('just a string');
    expect(await kv.get('d')).toBe(null);
  });

  it('get returns undefined for missing keys', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    expect(await kv.get('missing')).toBeUndefined();
  });

  it('set overwrites prior value at the same key', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    await kv.set('a', { v: 1 });
    await kv.set('a', { v: 2 });
    expect(await kv.get('a')).toEqual({ v: 2 });
  });

  it('delete removes the key', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    await kv.set('a', 1);
    await kv.delete('a');
    expect(await kv.get('a')).toBeUndefined();
  });

  it('delete on a missing key is a no-op', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    await expect(kv.delete('missing')).resolves.toBeUndefined();
  });
});

describe('plugin-kv quotas', () => {
  it('rejects value > maxBytesPerKey', async () => {
    const kv = makePluginKv({
      pluginId: 'p1',
      harnessSlug: 'h1',
      sql,
      quota: { maxBytesPerKey: 100, maxBytesPerPlugin: 10_000 },
    });
    const big = 'x'.repeat(200);
    await expect(kv.set('big', big)).rejects.toBeInstanceOf(KvQuotaError);
  });

  it('rejects when per-plugin total would exceed', async () => {
    const kv = makePluginKv({
      pluginId: 'p1',
      harnessSlug: 'h1',
      sql,
      quota: { maxBytesPerKey: 1000, maxBytesPerPlugin: 1500 },
    });
    await kv.set('a', 'x'.repeat(500));
    await kv.set('b', 'x'.repeat(500));
    // Third write would exceed 1500 total (500 + 500 + 500 = 1500; +
    // JSON quote chars). Use slightly bigger to be sure.
    await expect(kv.set('c', 'x'.repeat(800))).rejects.toMatchObject({
      name: 'KvQuotaError',
      kind: 'per-plugin',
    });
  });

  it('overwriting a key does not double-count its bytes', async () => {
    const kv = makePluginKv({
      pluginId: 'p1',
      harnessSlug: 'h1',
      sql,
      quota: { maxBytesPerKey: 5000, maxBytesPerPlugin: 1500 },
    });
    await kv.set('a', 'x'.repeat(700));
    // Overwriting should subtract the old size; otherwise this fails.
    await expect(kv.set('a', 'y'.repeat(700))).resolves.toBeUndefined();
    expect((await kv.get<string>('a'))!.length).toBe(700);
  });

  it('module defaults are sane', () => {
    expect(DEFAULT_MAX_BYTES_PER_KEY).toBe(10 * 1024);
    expect(DEFAULT_MAX_BYTES_PER_PLUGIN).toBe(1024 * 1024);
  });

  it('rejects non-JSON-serialisable values', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(kv.set('a', circular)).rejects.toThrow();
    await expect(kv.set('b', () => 1)).rejects.toThrow(/not JSON-serialisable/);
  });
});

describe('plugin-kv namespace isolation', () => {
  it('plugin A cannot see plugin B writes in the same harness', async () => {
    const a = makePluginKv({ pluginId: 'A', harnessSlug: 'h1', sql });
    const b = makePluginKv({ pluginId: 'B', harnessSlug: 'h1', sql });
    await a.set('shared-name', { who: 'A' });
    await b.set('shared-name', { who: 'B' });
    expect(await a.get('shared-name')).toEqual({ who: 'A' });
    expect(await b.get('shared-name')).toEqual({ who: 'B' });
  });

  it('same plugin in different harnesses gets separate stores', async () => {
    const h1 = makePluginKv({ pluginId: 'P', harnessSlug: 'h1', sql });
    const h2 = makePluginKv({ pluginId: 'P', harnessSlug: 'h2', sql });
    await h1.set('k', 'v1');
    await h2.set('k', 'v2');
    expect(await h1.get('k')).toBe('v1');
    expect(await h2.get('k')).toBe('v2');
  });
});

describe('plugin-kv list', () => {
  it('returns keys with the given prefix in lexicographic order', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    await kv.set('user:1', 'a');
    await kv.set('user:2', 'b');
    await kv.set('user:3', 'c');
    await kv.set('post:1', 'x');
    const result = await kv.list({ prefix: 'user:' });
    expect(result).toEqual(['user:1', 'user:2', 'user:3']);
  });

  it('honors limit', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    for (let i = 0; i < 10; i++) await kv.set(`k${i}`, i);
    const r = await kv.list({ limit: 3 });
    expect(r.length).toBe(3);
  });

  it('supports cursor pagination via afterKey', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    for (const k of ['a', 'b', 'c', 'd']) await kv.set(k, 1);
    const page1 = await kv.list({ limit: 2 });
    expect(page1).toEqual(['a', 'b']);
    const page2 = await kv.list({ limit: 2, afterKey: page1[page1.length - 1] });
    expect(page2).toEqual(['c', 'd']);
  });

  it('list across plugins is namespace-scoped', async () => {
    const a = makePluginKv({ pluginId: 'A', harnessSlug: 'h1', sql });
    const b = makePluginKv({ pluginId: 'B', harnessSlug: 'h1', sql });
    await a.set('k1', 1);
    await b.set('k2', 2);
    expect(await a.list()).toEqual(['k1']);
    expect(await b.list()).toEqual(['k2']);
  });
});

describe('plugin-kv key validation', () => {
  it('rejects empty key', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    await expect(kv.set('', 1)).rejects.toThrow(/non-empty string/);
  });

  it('rejects key with control characters', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    await expect(kv.set('foo\nbar', 1)).rejects.toThrow(/control characters/);
    await expect(kv.set('foo\tbar', 1)).rejects.toThrow(/control characters/);
  });

  it('rejects too-long keys', async () => {
    const kv = makePluginKv({ pluginId: 'p1', harnessSlug: 'h1', sql });
    await expect(kv.set('x'.repeat(2000), 1)).rejects.toThrow(/limit is 1024/);
  });
});

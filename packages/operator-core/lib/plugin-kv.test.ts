/**
 * P-028 (production-readiness-test-coverage) — plugin-kv: the plugin-private KV
 * store's quota + key-validation logic (the security-relevant part). The PG
 * handle is a content-routed tagged-template mock (no real DB) so we can drive
 * each branch: key validation, per-key + per-plugin byte quotas, JSONB
 * parse-on-read, the upsert write, and list clamping.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { KvQuotaError } from '@papercusp/plugin-sdk';
import {
  makePluginKv,
  DEFAULT_MAX_BYTES_PER_KEY,
  type KvQuotaConfig,
} from './plugin-kv';

/**
 * A `sql` tagged-template mock that routes by query text. `rows` maps a
 * substring of the query to the rows it should resolve. Records every call's
 * interpolated values for assertions.
 */
function makeSqlMock(routes: Array<{ match: string; rows: unknown[] }>) {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    calls.push({ query, values });
    const hit = routes.find((r) => query.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  });
  return { sql: sql as unknown as Sql, calls, raw: sql };
}

const make = (
  routes: Array<{ match: string; rows: unknown[] }> = [],
  quota?: KvQuotaConfig,
) => {
  const m = makeSqlMock(routes);
  const kv = makePluginKv({ pluginId: 'plg', harnessSlug: 'papercup', sql: m.sql, quota });
  return { kv, ...m };
};

describe('plugin-kv — key validation', () => {
  it('rejects an empty key before touching the DB', async () => {
    const { kv, raw } = make();
    await expect(kv.get('')).rejects.toThrow(/non-empty string/);
    expect(raw).not.toHaveBeenCalled();
  });

  it('rejects a key with control characters', async () => {
    const { kv } = make();
    await expect(kv.get('a\nb')).rejects.toThrow(/control characters/);
    await expect(kv.delete('a\x00b')).rejects.toThrow(/control characters/);
  });

  it('rejects an over-long key (>1024)', async () => {
    const { kv } = make();
    await expect(kv.set('k'.repeat(1025), 'v')).rejects.toThrow(/limit is 1024/);
  });
});

describe('plugin-kv — set quotas', () => {
  it('throws KvQuotaError (per-key) before any DB read when the value exceeds maxBytesPerKey', async () => {
    const { kv, raw } = make([], { maxBytesPerKey: 5 });
    await expect(kv.set('k', 'this is well over five bytes')).rejects.toBeInstanceOf(KvQuotaError);
    expect(raw).not.toHaveBeenCalled(); // per-key check precedes the SUM query
  });

  it('throws TypeError for a non-JSON-serialisable value', async () => {
    const { kv } = make();
    await expect(kv.set('k', undefined)).rejects.toThrow(/not JSON-serialisable/);
  });

  it('throws KvQuotaError (per-plugin) when the projected total exceeds maxBytesPerPlugin', async () => {
    // used=40, no existing row for this key, new value ~20 bytes → projected ~60 > 50.
    const { kv } = make(
      [
        { match: 'SUM(byte_size)', rows: [{ used: 40 }] },
        { match: 'SELECT byte_size FROM', rows: [] },
      ],
      { maxBytesPerPlugin: 50 },
    );
    await expect(kv.set('k', 'twenty-ish bytes!!')).rejects.toBeInstanceOf(KvQuotaError);
  });

  it('subtracts an existing row from the total so a same-size overwrite fits', async () => {
    // used=48 already includes this key's 40 bytes; overwriting with ~10 bytes →
    // projected = 48 - 40 + ~12 ≈ 20 ≤ 50, so it must NOT throw and must upsert.
    const { kv, calls } = make(
      [
        { match: 'SUM(byte_size)', rows: [{ used: 48 }] },
        { match: 'SELECT byte_size FROM', rows: [{ byte_size: 40 }] },
        { match: 'INSERT INTO', rows: [] },
      ],
      { maxBytesPerPlugin: 50 },
    );
    await expect(kv.set('k', 'small')).resolves.toBeUndefined();
    expect(calls.some((c) => c.query.includes('INSERT INTO harness_shared.plugin_kv'))).toBe(true);
  });

  it('uses the default per-key limit when no quota is supplied', async () => {
    const { kv, raw } = make([], undefined);
    const tooBig = 'x'.repeat(DEFAULT_MAX_BYTES_PER_KEY + 1);
    await expect(kv.set('k', tooBig)).rejects.toBeInstanceOf(KvQuotaError);
    expect(raw).not.toHaveBeenCalled();
  });
});

describe('plugin-kv — get parse-on-read', () => {
  it('JSON-parses a string (JSONB) value', async () => {
    const { kv } = make([{ match: 'SELECT value FROM', rows: [{ value: '{"a":1}' }] }]);
    expect(await kv.get('k')).toEqual({ a: 1 });
  });

  it('passes a non-string value through unchanged', async () => {
    const { kv } = make([{ match: 'SELECT value FROM', rows: [{ value: { a: 1 } }] }]);
    expect(await kv.get('k')).toEqual({ a: 1 });
  });

  it('returns the raw string when it is not valid JSON', async () => {
    const { kv } = make([{ match: 'SELECT value FROM', rows: [{ value: 'not-json' }] }]);
    expect(await kv.get('k')).toBe('not-json');
  });

  it('returns undefined for a missing key', async () => {
    const { kv } = make([{ match: 'SELECT value FROM', rows: [] }]);
    expect(await kv.get('k')).toBeUndefined();
  });
});

describe('plugin-kv — list', () => {
  it('maps rows to keys and clamps the limit to 500', async () => {
    const { kv, calls } = make([{ match: 'SELECT key FROM', rows: [{ key: 'a' }, { key: 'b' }] }]);
    expect(await kv.list({ limit: 9999 })).toEqual(['a', 'b']);
    const listCall = calls.find((c) => c.query.includes('SELECT key FROM'));
    expect(listCall?.values).toContain(500); // limit clamped down
  });

  it('floors the limit at 1', async () => {
    const { kv, calls } = make([{ match: 'SELECT key FROM', rows: [] }]);
    await kv.list({ limit: 0 });
    const listCall = calls.find((c) => c.query.includes('SELECT key FROM'));
    expect(listCall?.values).toContain(1);
  });
});

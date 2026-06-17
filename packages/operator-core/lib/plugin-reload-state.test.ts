/**
 * Unit coverage for plugin-reload-state.ts — the PG-backed reload-state stash.
 *
 * `sql` is injected, so a fake tagged-template lets us test the PURE policy that
 * runs BEFORE any DB write (the value under test): the size cap, the
 * serialisability + undefined guards (all reject WITHOUT touching the DB), and
 * the pop-path's JSON.parse-with-fallback (a malformed stored row must not throw).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  MAX_STATE_BYTES,
  clearPluginReloadState,
  popPluginReloadState,
  savePluginReloadState,
} from './plugin-reload-state';

/** A fake `sql` tagged-template: records each call and returns canned rows. */
function fakeSql(rows: unknown[] = []) {
  const calls: unknown[][] = [];
  const fn = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve(rows);
  };
  (fn as unknown as { calls: unknown[][] }).calls = calls;
  return fn as unknown as Sql & { calls: unknown[][] };
}

const deps = (sql: Sql) => ({ pluginId: 'p1', harnessSlug: 'h1', sql });

describe('savePluginReloadState — guards run before any DB write', () => {
  it('returns false and never touches the DB for undefined state', async () => {
    const sql = fakeSql();
    expect(await savePluginReloadState(deps(sql), undefined)).toBe(false);
    expect(sql.calls).toHaveLength(0);
  });

  it('returns false and never touches the DB for non-serialisable state (circular ref)', async () => {
    const sql = fakeSql();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await savePluginReloadState(deps(sql), circular)).toBe(false);
    expect(sql.calls).toHaveLength(0);
  });

  it('returns false and never touches the DB when state exceeds the size cap', async () => {
    const sql = fakeSql();
    const tooBig = { blob: 'x'.repeat(MAX_STATE_BYTES + 1) };
    expect(await savePluginReloadState(deps(sql), tooBig)).toBe(false);
    expect(sql.calls).toHaveLength(0);
  });

  it('persists valid state (one upsert) and reports true', async () => {
    const sql = fakeSql();
    expect(await savePluginReloadState(deps(sql), { ok: true, n: 3 })).toBe(true);
    expect(sql.calls).toHaveLength(1);
    // The serialised state + computed byte size are bound into the upsert.
    const bound = sql.calls[0];
    expect(bound).toContain('{"ok":true,"n":3}');
    expect(bound).toContain(Buffer.byteLength('{"ok":true,"n":3}', 'utf8'));
  });

  it('accepts state exactly AT the size cap', async () => {
    const sql = fakeSql();
    // Build a JSON string whose byte length is exactly MAX_STATE_BYTES.
    const overhead = Buffer.byteLength('{"b":""}', 'utf8');
    const atCap = { b: 'x'.repeat(MAX_STATE_BYTES - overhead) };
    expect(Buffer.byteLength(JSON.stringify(atCap), 'utf8')).toBe(MAX_STATE_BYTES);
    expect(await savePluginReloadState(deps(sql), atCap)).toBe(true);
  });
});

describe('popPluginReloadState — one-shot read with a parse fallback', () => {
  it('returns undefined when no row was stashed', async () => {
    expect(await popPluginReloadState(deps(fakeSql([])))).toBeUndefined();
  });

  it('JSON-parses a stringified row back into its value', async () => {
    const out = await popPluginReloadState(deps(fakeSql([{ state: '{"a":1}' }])));
    expect(out).toEqual({ a: 1 });
  });

  it('falls back to the raw string when the stored row is not valid JSON (never throws)', async () => {
    const out = await popPluginReloadState(deps(fakeSql([{ state: 'not json{' }])));
    expect(out).toBe('not json{');
  });

  it('returns a non-string (already-parsed jsonb) row as-is', async () => {
    const out = await popPluginReloadState(deps(fakeSql([{ state: { a: 1 } }])));
    expect(out).toEqual({ a: 1 });
  });
});

describe('clearPluginReloadState', () => {
  it('issues the delete', async () => {
    const sql = fakeSql();
    await clearPluginReloadState(deps(sql));
    expect(sql.calls).toHaveLength(1);
  });
});

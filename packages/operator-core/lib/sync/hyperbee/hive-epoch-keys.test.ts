/**
 * Tests for the P-005 distribution data layer (Brief RE-KEY / Move 2):
 *  - projections/hive-epoch-keys.ts — composeKey, decode/validation, the harness_slug
 *    DEMUX, and the onEpochKeyApplied drain callback (J's seam).
 *  - hive-epoch-keys-store.ts — putWrappedKeys (base64 encode + origin='local') and
 *    createPgWrappedKeyLoader (base64 → bytes; null when absent).
 * A fake `sql` stands in for PG (the LWW SQL itself is covered by integration later);
 * these pin MY logic: demux, callback, key composition, encode/decode.
 */
import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
  buildHiveEpochKeysProjection,
  _testing,
  type HiveEpochKeyRow,
} from './projections/hive-epoch-keys';
import { putWrappedKeys, createPgWrappedKeyLoader } from './hive-epoch-keys-store';

/** A tagged-template + .unsafe fake matching the postgres-js surface these modules use. */
function makeFakeSql(returns: unknown[] = []) {
  const calls: Array<{ kind: 'tag' | 'unsafe'; params?: unknown[] }> = [];
  const fn = ((_s: TemplateStringsArray, ..._v: unknown[]) => {
    calls.push({ kind: 'tag' });
    return Promise.resolve(returns);
  }) as unknown as postgres.Sql & { unsafe: (q: string, p?: unknown[]) => Promise<unknown> };
  (fn as { unsafe: (q: string, p?: unknown[]) => Promise<unknown> }).unsafe = (_q, p) => {
    calls.push({ kind: 'unsafe', params: p });
    return Promise.resolve(returns);
  };
  return { sql: fn, calls };
}

const HOME = 'hello-world-hive';
const PUB = 'Z2LOLc/QCz84xIin8yUXgedmgJu7nBgW3bgmErFyZoY=';
const goodRow: HiveEpochKeyRow = { harness_slug: HOME, epoch: 2, member_device_pubkey: PUB, wrapped_key: 'd3JhcHBlZA==' };

describe('hive-epoch-keys projection — composeKey + validation', () => {
  it('composeKey is `${epoch}:${pubkey}` (matches the generated fed key)', () => {
    expect(_testing.composeKey(goodRow)).toBe(`2:${PUB}`);
  });
  it('accepts a well-formed row; rejects malformed ones', () => {
    expect(_testing.decodeValue(goodRow)).toEqual(goodRow);
    expect(_testing.decodeValue({ ...goodRow, epoch: 1.5 })).toBeNull();
    expect(_testing.decodeValue({ ...goodRow, epoch: -1 })).toBeNull();
    expect(_testing.decodeValue({ ...goodRow, member_device_pubkey: '' })).toBeNull();
    expect(_testing.decodeValue({ ...goodRow, wrapped_key: '' })).toBeNull();
    expect(_testing.decodeValue({ ...goodRow, harness_slug: 123 })).toBeNull();
  });
});

describe('hive-epoch-keys projection — demux + drain callback', () => {
  it('applies + fires onEpochKeyApplied for THIS Hive home', async () => {
    const { sql, calls } = makeFakeSql();
    const onEpochKeyApplied = vi.fn();
    const proj = buildHiveEpochKeysProjection({ workspaceId: 'default', harnessSlug: HOME, sql, onEpochKeyApplied });
    await proj.writeToPg(goodRow, { origin: 'remote', authorPubkey: 'remote-author', ts: 5, fedHlc: '000000000000005:00000' });
    expect(calls.filter((c) => c.kind === 'tag')).toHaveLength(1); // the INSERT ran
    expect(onEpochKeyApplied).toHaveBeenCalledWith(HOME, 2);
  });
  it('DEMUX: a row for a DIFFERENT Hive home is dropped (no write, no callback)', async () => {
    const { sql, calls } = makeFakeSql();
    const onEpochKeyApplied = vi.fn();
    const proj = buildHiveEpochKeysProjection({ workspaceId: 'default', harnessSlug: HOME, sql, onEpochKeyApplied });
    await proj.writeToPg({ ...goodRow, harness_slug: 'other-hive' }, { origin: 'remote', authorPubkey: 'remote-author' });
    expect(calls).toHaveLength(0);
    expect(onEpochKeyApplied).not.toHaveBeenCalled();
  });
});

describe('hive-epoch-keys store — encode + loader round-trip', () => {
  it('putWrappedKeys base64-encodes the blob + writes origin=local', async () => {
    const { sql, calls } = makeFakeSql();
    const blob = new Uint8Array([1, 2, 3, 250]);
    const n = await putWrappedKeys('default', HOME, 3, [{ memberDevicePubkey: PUB, wrappedKey: blob }], 'owner', sql);
    expect(n).toBe(1);
    const insert = calls.find((c) => c.kind === 'unsafe')!;
    expect(insert.params).toEqual(['default', HOME, 3, PUB, Buffer.from(blob).toString('base64'), 'owner']);
  });
  it('createPgWrappedKeyLoader decodes base64 → bytes, null when absent', async () => {
    const blob = new Uint8Array([9, 8, 7]);
    const present = makeFakeSql([{ wrapped_key: Buffer.from(blob).toString('base64') }]);
    const loader = createPgWrappedKeyLoader('default', HOME, present.sql);
    const got = await loader.load('hive-1', 3, PUB);
    expect(got && Buffer.from(got).equals(Buffer.from(blob))).toBe(true);

    const absent = makeFakeSql([]); // no row
    const loader2 = createPgWrappedKeyLoader('default', HOME, absent.sql);
    expect(await loader2.load('hive-1', 9, PUB)).toBeNull();
  });
});

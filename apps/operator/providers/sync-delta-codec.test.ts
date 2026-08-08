/**
 * createSyncDeltaCodec (agent-tool-delta-client-rollout-2026-06-23 P-006). The operator codec
 * that backs the sync delta seam. Load-bearing: it decodes a full then merges a delta back to
 * the exact view (learning the conveyed itemKeyField), signals refetchFull on a checksum
 * mismatch (the no-wrong-view guard), and only enables the opted-in resources.
 */
import { describe, it, expect } from 'vitest';
import { computeViewChecksum, type DeltaChange } from '@papercusp/tooldef';
import { RESOURCE_DELTA_NAMES } from '@papercusp/operator-core/lib/sync-resolver/resource-delta-config';
import { createSyncDeltaCodec } from './sync-delta-codec';

const id = (r: unknown) => String((r as { id: string }).id);

describe('createSyncDeltaCodec', () => {
  it('enables only the opted-in resources', () => {
    const codec = createSyncDeltaCodec();
    expect(codec.enabled('plans.attention')).toBe(true);
    expect(codec.enabled('plans.list')).toBe(true);
    expect(codec.enabled('workItems.byHarness')).toBe(false);
  });

  /**
   * The client gates FIRST: query-fetcher.ts:468 sends no cursor when `enabled(name)` is false,
   * so the server serves a full view and its delta config is dead weight. A server entry with no
   * client entry is therefore not a partial win — it is ZERO win, silently.
   *
   * This regressed twice unnoticed (`plans.byHive` via WI-7083, `codeRecipes` 2026-08-02), which
   * is why parity is asserted rather than documented. Direction matters: every SERVER name must be
   * enabled on the client. The reverse is deliberately allowed — the codec passes rows through for
   * a name the server does not negotiate, so a client-side extra is harmless.
   */
  it('enables every resource the SERVER delta-negotiates (no silent client/server drift)', () => {
    const codec = createSyncDeltaCodec();
    const missing = RESOURCE_DELTA_NAMES.filter((name) => !codec.enabled(name));
    expect(missing, `server delta-negotiates these but the client never sends a cursor: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * CONTROL for the parity check above — a guard that has never failed is a guard nobody has
   * tested. This pins the DRIFTED client set as it actually stood on 2026-08-08 (the two names
   * it shipped with on 2026-06-23) and asserts the same computation reports both misses. Without
   * it, the assertion above would still pass if `enabled()` ever degenerated to `() => true`.
   */
  it('CONTROL: the parity check reports a client set that has drifted behind the server', () => {
    const drifted = new Set(['plans.attention', 'plans.list']);
    const missing = RESOURCE_DELTA_NAMES.filter((name) => !drifted.has(name));
    expect(missing.sort()).toEqual(['codeRecipes', 'plans.byHive']);
  });

  it('decodes a full, then merges a delta back to the exact view (learns itemKeyField)', () => {
    const codec = createSyncDeltaCodec();
    const vk = codec.viewKey('plans.attention', {});

    const full = codec.decodeResult(vk, {
      rows: [{ id: 'a' }, { id: 'b' }],
      version: '1',
      delta: { mode: 'full', cursor: 'c1', itemKeyField: 'id' },
    });
    expect(full.refetchFull).toBe(false);
    expect(full.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(codec.cursorFor(vk)).toBe('c1');

    const changes: DeltaChange[] = [
      { change: 'removed', id: 'a' },
      { change: 'added', id: 'c', data: { id: 'c' } },
    ];
    const checksum = computeViewChecksum([{ id: 'b' }, { id: 'c' }], id);
    const delta = codec.decodeResult(vk, {
      changes,
      version: '2',
      delta: { mode: 'delta', cursor: 'c2', checksum, itemKeyField: 'id' },
    });
    expect(delta.refetchFull).toBe(false);
    expect(new Set(delta.rows.map(id))).toEqual(new Set(['b', 'c']));
    expect(codec.cursorFor(vk)).toBe('c2');
  });

  it('signals refetchFull on a checksum mismatch (no wrong view)', () => {
    const codec = createSyncDeltaCodec();
    const vk = codec.viewKey('plans.list', {});
    codec.decodeResult(vk, {
      rows: [{ slug: 'a' }],
      version: '1',
      delta: { mode: 'full', cursor: 'c1', itemKeyField: 'slug' },
    });
    const r = codec.decodeResult(vk, {
      changes: [{ change: 'added', id: 'b', data: { slug: 'b' } }] as DeltaChange[],
      version: '2',
      delta: { mode: 'delta', cursor: 'c2', checksum: 'BOGUS', itemKeyField: 'slug' },
    });
    expect(r.refetchFull).toBe(true);
  });

  it('a viewKey is stable across arg key order', () => {
    const codec = createSyncDeltaCodec();
    expect(codec.viewKey('plans.list', { a: 1, b: 2 })).toBe(codec.viewKey('plans.list', { b: 2, a: 1 }));
  });
});

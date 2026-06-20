import { describe, it, expect, vi } from 'vitest';
import {
  advanceEpochOnHiveBoundary,
  grantEpochKeysToMembers,
  type BoundaryRekeySeams,
} from './hive-epoch-boundary-wiring';
import type { WrappedEpochKeyRow } from './hive-epoch-boundary';

/**
 * Hermetic glue tests for the P-004 boundary trigger (shared-hive-rekey-2026-06-19).
 * No PG, no real crypto — every seam injected. The load-bearing invariant is
 * `remaining = all − cutOff`: a bug here = the removed member keeps the new key =
 * NO read cut-off.
 */
describe('advanceEpochOnHiveBoundary', () => {
  it('flag OFF ⇒ no-op (applied:false) and touches nothing', async () => {
    const loadAll = vi.fn(async () => ['A']);
    const persist = vi.fn(async () => 1);
    const r = await advanceEpochOnHiveBoundary(
      { workspaceId: 'w', hiveHomeSlug: 'h', enabled: false, cutOffPubkeys: ['B'] },
      { loadAllMemberPubkeys: loadAll, persistWrappedKeys: persist },
    );
    expect(r).toEqual({ applied: false });
    expect(loadAll).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('flag ON ⇒ re-keys the REMAINING members (cut-off excluded) + persists them', async () => {
    let seenRemaining: readonly string[] = [];
    let persisted: readonly WrappedEpochKeyRow[] = [];
    const seams: BoundaryRekeySeams = {
      resolveCrypto: async () => ({}) as never,
      loadAllMemberPubkeys: async () => ['A', 'B', 'C'],
      resolveAuthorPubkey: async () => 'owner-pub',
      advanceAndWrap: async (_c, _ctx, remaining) => {
        seenRemaining = remaining;
        return {
          newEpoch: 1,
          wrapped: remaining.map((pk) => ({ memberDevicePubkey: pk, wrappedKey: new Uint8Array([1]) })),
        };
      },
      persistWrappedKeys: async (_w, _s, _e, rows) => {
        persisted = rows;
        return rows.length;
      },
    };
    const r = await advanceEpochOnHiveBoundary(
      { workspaceId: 'w', hiveHomeSlug: 'h', enabled: true, cutOffPubkeys: ['B'] },
      seams,
    );
    // B (the cut-off member) is NEVER in the remaining set or persisted → no key → cut off.
    expect([...seenRemaining].sort()).toEqual(['A', 'C']);
    expect(persisted.map((x) => x.memberDevicePubkey).sort()).toEqual(['A', 'C']);
    expect(r).toEqual({ applied: true, newEpoch: 1, distributed: 2 });
  });

  it('passes hiveId = hiveHomeSlug to the core (mint ↔ encrypt/decrypt AAD agree per-peer)', async () => {
    let ctxSeen: { hiveId?: string; hiveHomeSlug?: string } = {};
    await advanceEpochOnHiveBoundary(
      { workspaceId: 'w', hiveHomeSlug: 'hello-world-hive', enabled: true },
      {
        resolveCrypto: async () => ({}) as never,
        loadAllMemberPubkeys: async () => ['A'],
        resolveAuthorPubkey: async () => null,
        advanceAndWrap: async (_c, ctx) => {
          ctxSeen = ctx;
          return { newEpoch: 1, wrapped: [] };
        },
        persistWrappedKeys: async () => 0,
      },
    );
    expect(ctxSeen.hiveId).toBe('hello-world-hive');
    expect(ctxSeen.hiveHomeSlug).toBe('hello-world-hive');
  });

  it('go-private (no cutOffPubkeys) ⇒ re-keys ALL current members (future link-holders get no key)', async () => {
    let seenRemaining: readonly string[] = [];
    const r = await advanceEpochOnHiveBoundary(
      { workspaceId: 'w', hiveHomeSlug: 'h', enabled: true },
      {
        resolveCrypto: async () => ({}) as never,
        loadAllMemberPubkeys: async () => ['A', 'B'],
        resolveAuthorPubkey: async () => null,
        advanceAndWrap: async (_c, _ctx, remaining) => {
          seenRemaining = remaining;
          return { newEpoch: 2, wrapped: [] };
        },
        persistWrappedKeys: async () => 0,
      },
    );
    expect([...seenRemaining].sort()).toEqual(['A', 'B']);
    expect(r.applied).toBe(true);
  });
});

describe('grantEpochKeysToMembers (member-add: wrap [0..current])', () => {
  it('flag OFF ⇒ no-op', async () => {
    const persist = vi.fn(async () => 1);
    const r = await grantEpochKeysToMembers(
      { workspaceId: 'w', hiveHomeSlug: 'h', enabled: false, newMemberPubkeys: ['B'] },
      { persistWrappedKeys: persist },
    );
    expect(r).toEqual({ applied: false, reason: 'flag-disabled' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('empty members ⇒ no-op', async () => {
    const r = await grantEpochKeysToMembers(
      { workspaceId: 'w', hiveHomeSlug: 'h', enabled: true, newMemberPubkeys: [] },
      { getCurrentEpoch: async () => 2 },
    );
    expect(r).toEqual({ applied: false, reason: 'no-fresh-members' });
  });

  it('flag ON, current=2 ⇒ wraps EVERY epoch [0..2] to each UNIQUE new member', async () => {
    const derivedEpochs: number[] = [];
    const persistedEpochs: number[] = [];
    const r = await grantEpochKeysToMembers(
      { workspaceId: 'w', hiveHomeSlug: 'hello-world-hive', enabled: true, newMemberPubkeys: ['B', 'B', 'C'] },
      {
        resolveCrypto: async () =>
          ({
            deriveEpochKey: async (_h: string, e: number) => {
              derivedEpochs.push(e);
              return `K${e}` as never;
            },
            wrapKeyToMember: async () => new Uint8Array([1]),
          }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: async (_w, _s, epoch, rows) => {
          persistedEpochs.push(epoch);
          return rows.length;
        },
        getCurrentEpoch: async () => 2,
      },
    );
    expect(derivedEpochs).toEqual([0, 1, 2]); // a key for EVERY epoch [0..current]
    expect(persistedEpochs).toEqual([0, 1, 2]);
    expect(r).toEqual({ applied: true, newEpoch: 2, distributed: 6 }); // 3 epochs × 2 unique members (B,C)
  });

  it('non-owner box (resolveAuthorPubkey null) ⇒ no-op — self-gates, safe to call from the admit path anywhere', async () => {
    const derive = vi.fn();
    const r = await grantEpochKeysToMembers(
      { workspaceId: 'w', hiveHomeSlug: 'h', enabled: true, newMemberPubkeys: ['B'] },
      {
        resolveAuthorPubkey: async () => null, // this box does not hold the hive key
        getCurrentEpoch: async () => 2,
        resolveCrypto: async () => ({ deriveEpochKey: derive }) as never,
      },
    );
    expect(r).toEqual({ applied: false, reason: 'no-author' });
    expect(derive).not.toHaveBeenCalled(); // owner-gate short-circuits BEFORE any derive
  });
});

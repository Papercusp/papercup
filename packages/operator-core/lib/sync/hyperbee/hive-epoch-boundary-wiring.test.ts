import { describe, it, expect, vi } from 'vitest';
import {
  advanceEpochOnHiveBoundary,
  grantEpochKeysToMembers,
  reconcileEpochKeysForCurrentMembers,
  reconcileOwnedHiveEpochKeys,
  type BoundaryRekeySeams,
} from './hive-epoch-boundary-wiring';
import type { WrappedEpochKeyRow } from './hive-epoch-boundary';

/**
 * WI-6311 — the divergent-joiner topology, which is the ONLY topology where this bug is
 * observable. `resolveFederatedPotScope` fails OPEN (returns the local handle) whenever it
 * cannot resolve, which is exactly what happens in a hermetic test with no registry and no PG.
 * So without this mock the resolved and unresolved scopes are byte-identical and a test that
 * "passes" proves nothing at all. Here LOCAL !== CANONICAL, so the two are distinguishable and
 * the assertions below can actually see which one each reader received.
 */
const LOCAL_HANDLE = 'shop-hive-2'; // what freeSlug produced on the joiner
const CANONICAL = 'shop-hive'; // what the owner authored, and what the projections write under
vi.mock('../../federated-pot-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../federated-pot-scope')>();
  return {
    ...actual,
    resolveFederatedPotScope: async (_ws: string, local: string) =>
      (local === LOCAL_HANDLE ? CANONICAL : local) as never,
  };
});

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
      { workspaceId: 'w', potHomeSlug: 'h', enabled: false, cutOffPubkeys: ['B'] },
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
      loadRevokedPubkeys: async () => new Set(),
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
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true, cutOffPubkeys: ['B'] },
      seams,
    );
    // B (the cut-off member) is NEVER in the remaining set or persisted → no key → cut off.
    expect([...seenRemaining].sort()).toEqual(['A', 'C']);
    expect(persisted.map((x) => x.memberDevicePubkey).sort()).toEqual(['A', 'C']);
    expect(r).toEqual({ applied: true, newEpoch: 1, distributed: 2 });
  });

  it('passes potId = potHomeSlug to the core (mint ↔ encrypt/decrypt AAD agree per-peer)', async () => {
    let ctxSeen: { potId?: string; potHomeSlug?: string } = {};
    await advanceEpochOnHiveBoundary(
      { workspaceId: 'w', potHomeSlug: 'hello-world-hive', enabled: true },
      {
        resolveCrypto: async () => ({}) as never,
        loadAllMemberPubkeys: async () => ['A'],
        loadRevokedPubkeys: async () => new Set(),
        resolveAuthorPubkey: async () => null,
        advanceAndWrap: async (_c, ctx) => {
          ctxSeen = ctx;
          return { newEpoch: 1, wrapped: [] };
        },
        persistWrappedKeys: async () => 0,
      },
    );
    expect(ctxSeen.potId).toBe('hello-world-hive');
    expect(ctxSeen.potHomeSlug).toBe('hello-world-hive');
  });

  it('go-private (no cutOffPubkeys) ⇒ re-keys ALL current members (future link-holders get no key)', async () => {
    let seenRemaining: readonly string[] = [];
    const r = await advanceEpochOnHiveBoundary(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true },
      {
        resolveCrypto: async () => ({}) as never,
        loadAllMemberPubkeys: async () => ['A', 'B'],
        loadRevokedPubkeys: async () => new Set(),
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

  // WI-566 audit: SECURITY BUG found + fixed. Before the fix, `remaining` excluded ONLY
  // this call's own `cutOffPubkeys` — a device revoked in a PRIOR boundary call (still
  // present in device_attestations; revocation is a blocklist, not a deletion) was NEVER
  // excluded on any SUBSEQUENT boundary event, silently re-granting it the new epoch key
  // and undoing the earlier cut-off. This is the K-CUT invariant's persistence across
  // repeated boundaries, not just the single call that first revoked the member.
  it('K-CUT PERSISTS across boundaries: a device revoked in a PRIOR call is excluded from a LATER (unrelated) boundary too', async () => {
    let seenRemaining: readonly string[] = [];
    // 'A' was revoked in an EARLIER call (not this one's cutOffPubkeys) — it must still be
    // excluded here via the accumulated revoked-pubkeys union, not just this call's cutOff.
    const r = await advanceEpochOnHiveBoundary(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true, cutOffPubkeys: ['B'] }, // THIS call revokes B, not A
      {
        resolveCrypto: async () => ({}) as never,
        loadAllMemberPubkeys: async () => ['A', 'B', 'C'], // A's device_attestations row still exists
        loadRevokedPubkeys: async () => new Set(['A']), // A was revoked in a PRIOR boundary call
        resolveAuthorPubkey: async () => 'owner-pub',
        advanceAndWrap: async (_c, _ctx, remaining) => {
          seenRemaining = remaining;
          return {
            newEpoch: 2,
            wrapped: remaining.map((pk) => ({ memberDevicePubkey: pk, wrappedKey: new Uint8Array([1]) })),
          };
        },
        persistWrappedKeys: async (_w, _s, _e, rows) => rows.length,
      },
    );
    // Only C remains: B is THIS call's fresh cut-off, A is the historically-revoked device —
    // neither may receive the new epoch key.
    expect([...seenRemaining].sort()).toEqual(['C']);
    expect(r).toEqual({ applied: true, newEpoch: 2, distributed: 1 });
  });

  it('go-private also excludes historically-revoked devices (not just the live member set)', async () => {
    let seenRemaining: readonly string[] = [];
    await advanceEpochOnHiveBoundary(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true }, // no cutOffPubkeys at all — this is the go-private shape
      {
        resolveCrypto: async () => ({}) as never,
        loadAllMemberPubkeys: async () => ['A', 'B'],
        loadRevokedPubkeys: async () => new Set(['B']), // B was revoked earlier
        resolveAuthorPubkey: async () => null,
        advanceAndWrap: async (_c, _ctx, remaining) => {
          seenRemaining = remaining;
          return { newEpoch: 3, wrapped: [] };
        },
        persistWrappedKeys: async () => 0,
      },
    );
    expect(seenRemaining).toEqual(['A']); // B stays cut off even on a boundary that names no cutOff
  });
});

describe('grantEpochKeysToMembers (member-add: wrap [0..current])', () => {
  it('flag OFF ⇒ no-op', async () => {
    const persist = vi.fn(async () => 1);
    const r = await grantEpochKeysToMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: false, newMemberPubkeys: ['B'] },
      { persistWrappedKeys: persist },
    );
    expect(r).toEqual({ applied: false, reason: 'flag-disabled' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('empty members ⇒ no-op', async () => {
    const r = await grantEpochKeysToMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true, newMemberPubkeys: [] },
      { getCurrentEpoch: async () => 2 },
    );
    expect(r).toEqual({ applied: false, reason: 'no-fresh-members' });
  });

  it('flag ON, current=2 ⇒ wraps EVERY epoch [0..2] to each UNIQUE new member', async () => {
    const derivedEpochs: number[] = [];
    const persistedEpochs: number[] = [];
    const r = await grantEpochKeysToMembers(
      { workspaceId: 'w', potHomeSlug: 'hello-world-hive', enabled: true, newMemberPubkeys: ['B', 'B', 'C'] },
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
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true, newMemberPubkeys: ['B'] },
      {
        resolveAuthorPubkey: async () => null, // this box does not hold the hive key
        getCurrentEpoch: async () => 2,
        resolveCrypto: async () => ({ deriveEpochKey: derive }) as never,
      },
    );
    expect(r).toEqual({ applied: false, reason: 'no-author' });
    expect(derive).not.toHaveBeenCalled(); // owner-gate short-circuits BEFORE any derive
  });

  it('WI-3927 guard: a MALFORMED pubkey (wrap throws) is SKIPPED + logged — the grant still lands for well-formed members', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapCalls: string[] = [];
    const seams = {
      resolveCrypto: async () =>
        ({
          deriveEpochKey: async (_h: string, e: number) => `K${e}` as never,
          wrapKeyToMember: async (_k: unknown, pk: string) => {
            wrapCalls.push(pk);
            if (pk === 'pk-creator') throw new Error('invalid public key length');
            return new Uint8Array([1]);
          },
        }) as never,
      resolveAuthorPubkey: async () => 'owner',
      getCurrentEpoch: async () => 1,
      persistWrappedKeys: async (_w: string, _s: string, _e: number, rows: readonly unknown[]) => rows.length,
    };
    try {
      // The 2026-07-10 hive-wide wedge: ONE leaked test-fixture pubkey ('pk-creator') among
      // well-formed members used to abort the WHOLE pass (reconciled=0). Now: skipped + logged,
      // the good members still get every epoch key, and the bad key is not retried per epoch.
      const r = await grantEpochKeysToMembers(
        { workspaceId: 'w', potHomeSlug: 'h', enabled: true, newMemberPubkeys: ['B', 'pk-creator', 'C'] },
        seams,
      );
      expect(r).toEqual({ applied: true, newEpoch: 1, distributed: 4 }); // 2 epochs × 2 good members; bad one skipped
      expect(wrapCalls.filter((pk) => pk === 'pk-creator')).toHaveLength(1); // thrown once, then skip-set — not retried per epoch
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('pk-creator');

      // ALL candidates malformed ⇒ distinct queryable reason, not a hollow applied:true/0.
      const rAll = await grantEpochKeysToMembers(
        { workspaceId: 'w', potHomeSlug: 'h', enabled: true, newMemberPubkeys: ['pk-creator'] },
        seams,
      );
      expect(rAll).toEqual({ applied: false, reason: 'all-members-unwrappable', distributed: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it('BUG B: refederate flag is THREADED into persistWrappedKeys (DEFAULT false)', async () => {
    const seenRefederate: Array<boolean | undefined> = [];
    const seams = {
      resolveCrypto: async () =>
        ({ deriveEpochKey: async () => 'K' as never, wrapKeyToMember: async () => new Uint8Array([1]) }) as never,
      resolveAuthorPubkey: async () => 'owner',
      getCurrentEpoch: async () => 0,
      persistWrappedKeys: async (
        _w: string,
        _s: string,
        _e: number,
        rows: readonly { memberDevicePubkey: string }[],
        _a: string | null,
        _sql?: unknown,
        opts?: { refederate?: boolean },
      ) => {
        seenRefederate.push(opts?.refederate);
        return rows.length;
      },
    };
    // default (no refederate) ⇒ persistWrappedKeys sees refederate undefined/false (write-once).
    await grantEpochKeysToMembers({ workspaceId: 'w', potHomeSlug: 'h', enabled: true, newMemberPubkeys: ['B'] }, seams);
    // refederate:true ⇒ persistWrappedKeys sees refederate true (DO UPDATE re-stamp path).
    await grantEpochKeysToMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true, newMemberPubkeys: ['B'], refederate: true },
      seams,
    );
    expect(seenRefederate).toEqual([undefined, true]);
  });
});

describe('reconcileEpochKeysForCurrentMembers (WI-887 self-heal: backfill [0..current] to ALL live members)', () => {
  // Minimal HiveMemberRecord shape the reconcile reads (deviceAttestations + revokedPubkeys).
  const member = (devicePubkeys: string[], revoked: string[] = []) =>
    ({
      deviceAttestations: devicePubkeys.map((device_pubkey) => ({ device_pubkey })),
      revokedPubkeys: revoked,
    }) as never;

  it('flag OFF ⇒ no-op (no member load, no grant)', async () => {
    const loadMembers = vi.fn(async () => [member(['A'])]);
    const r = await reconcileEpochKeysForCurrentMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: false },
      { loadMembers },
    );
    expect(r).toEqual({ applied: false, reason: 'flag-disabled' });
    expect(loadMembers).not.toHaveBeenCalled();
  });

  it('THE FIX: a member missing the current epoch is backfilled — wraps [0..current] to EVERY live member device', async () => {
    // owner 'A' + joiner 'B' (B federated in after the epoch advanced to 1, so it lacks epoch 1).
    const persisted: Array<{ epoch: number; members: string[] }> = [];
    const r = await reconcileEpochKeysForCurrentMembers(
      { workspaceId: 'w', potHomeSlug: 'hello-world-hive', enabled: true },
      {
        loadMembers: async () => [member(['A']), member(['B'])],
        loadEpochKeyDevices: async () => [], // nobody has any key yet ⇒ a gap exists ⇒ the guard grants
        resolveCrypto: async () =>
          ({
            deriveEpochKey: async (_h: string, e: number) => `K${e}` as never,
            wrapKeyToMember: async () => new Uint8Array([1]),
          }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: async (_w, _s, epoch, rows) => {
          persisted.push({ epoch, members: rows.map((row) => row.memberDevicePubkey) });
          return rows.length;
        },
        getCurrentEpoch: async () => 1,
      },
    );
    expect(persisted).toEqual([
      { epoch: 0, members: ['A', 'B'] },
      { epoch: 1, members: ['A', 'B'] }, // ← B (the stuck joiner) now gets the CURRENT epoch key
    ]);
    expect(r).toEqual({ applied: true, newEpoch: 1, distributed: 4 }); // 2 epochs × 2 members
  });

  it('C-001 SAFE: a revoked device is EXCLUDED — a removed member is never re-granted the current key', async () => {
    const persisted: Array<{ epoch: number; members: string[] }> = [];
    const r = await reconcileEpochKeysForCurrentMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true },
      {
        // 'B' is in the revoked blocklist (cut member) — must NOT receive the new key.
        loadMembers: async () => [member(['A']), member(['B'], ['B'])],
        loadEpochKeyDevices: async () => [], // a gap exists ⇒ the guard delegates to the grant

        resolveCrypto: async () =>
          ({
            deriveEpochKey: async (_h: string, e: number) => `K${e}` as never,
            wrapKeyToMember: async () => new Uint8Array([1]),
          }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: async (_w, _s, epoch, rows) => {
          persisted.push({ epoch, members: rows.map((row) => row.memberDevicePubkey) });
          return rows.length;
        },
        getCurrentEpoch: async () => 1,
      },
    );
    expect(persisted).toEqual([
      { epoch: 0, members: ['A'] }, // only the live member; revoked 'B' excluded
      { epoch: 1, members: ['A'] },
    ]);
    expect(r).toEqual({ applied: true, newEpoch: 1, distributed: 2 });
  });

  it('non-owner box (resolveAuthorPubkey null) ⇒ no-op — self-gates via the delegated grant', async () => {
    const derive = vi.fn();
    const r = await reconcileEpochKeysForCurrentMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true },
      {
        loadMembers: async () => [member(['A'])],
        loadEpochKeyDevices: async () => [], // a gap exists ⇒ guard passes through to the (self-gating) grant
        resolveAuthorPubkey: async () => null, // this box does not hold the hive key
        resolveCrypto: async () => ({ deriveEpochKey: derive }) as never,
        getCurrentEpoch: async () => 1,
      },
    );
    expect(r).toEqual({ applied: false, reason: 'no-author' });
    expect(derive).not.toHaveBeenCalled();
  });

  it('BUG B: refederate + onlyDevices ⇒ re-sends ONLY the target member device, refederate threaded, C-001 still excludes revoked', async () => {
    const persisted: Array<{ epoch: number; members: string[] }> = [];
    const seenRefederate: Array<boolean | undefined> = [];
    const r = await reconcileEpochKeysForCurrentMembers(
      // The whole hive is owner 'A' + member 'B' + revoked-and-cut 'R'; the reconnecting
      // member announces devices ['B','R']. onlyDevices targets B; C-001 drops R (revoked).
      { workspaceId: 'w', potHomeSlug: 'hello-world-hive', enabled: true, refederate: true, onlyDevices: ['B', 'R'] },
      {
        loadMembers: async () => [member(['A']), member(['B']), member(['R'], ['R'])],
        resolveCrypto: async () =>
          ({
            deriveEpochKey: async (_h: string, e: number) => `K${e}` as never,
            wrapKeyToMember: async () => new Uint8Array([1]),
          }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: async (
          _w: string,
          _s: string,
          epoch: number,
          rows: readonly { memberDevicePubkey: string }[],
          _a: string | null,
          _sql?: unknown,
          opts?: { refederate?: boolean },
        ) => {
          seenRefederate.push(opts?.refederate);
          persisted.push({ epoch, members: rows.map((row) => row.memberDevicePubkey) });
          return rows.length;
        },
        getCurrentEpoch: async () => 1,
      },
    );
    // Only B is re-granted: 'A' filtered out by onlyDevices, 'R' filtered out by C-001 revoked.
    expect(persisted).toEqual([
      { epoch: 0, members: ['B'] },
      { epoch: 1, members: ['B'] },
    ]);
    expect(seenRefederate).toEqual([true, true]); // refederate threaded into every persist
    expect(r).toEqual({ applied: true, newEpoch: 1, distributed: 2 });
  });

  it('PERF GUARD (P-020): every live device already holds the current epoch key ⇒ NO crypto, reason no-gap', async () => {
    // The hot onMemberApplied path. Without this guard, every membership apply re-wraps
    // [0..current] to every device → O(E·M) per apply, O(E·M²) per onboarding wave.
    const wrap = vi.fn(async () => new Uint8Array([1]));
    const derive = vi.fn(async () => 'K' as never);
    const persist = vi.fn(async () => 1);
    const r = await reconcileEpochKeysForCurrentMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true },
      {
        loadMembers: async () => [member(['A']), member(['B'])],
        getCurrentEpoch: async () => 1,
        loadEpochKeyDevices: async () => ['A', 'B'], // both already hold the current epoch key
        resolveCrypto: async () => ({ deriveEpochKey: derive, wrapKeyToMember: wrap }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: persist,
      },
    );
    expect(r).toEqual({ applied: false, reason: 'no-gap' });
    expect(wrap).not.toHaveBeenCalled();
    expect(derive).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('PERF GUARD bypassed by refederate ⇒ re-sends even when no device is missing the key', async () => {
    const persisted: Array<{ epoch: number; members: string[] }> = [];
    const r = await reconcileEpochKeysForCurrentMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true, refederate: true },
      {
        loadMembers: async () => [member(['A'])],
        getCurrentEpoch: async () => 0,
        loadEpochKeyDevices: async () => ['A'], // A already holds it — guard WOULD skip, but refederate bypasses it
        resolveCrypto: async () =>
          ({
            deriveEpochKey: async (_h: string, e: number) => `K${e}` as never,
            wrapKeyToMember: async () => new Uint8Array([1]),
          }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: async (_w, _s, epoch, rows) => {
          persisted.push({ epoch, members: rows.map((row) => row.memberDevicePubkey) });
          return rows.length;
        },
      },
    );
    expect(persisted).toEqual([{ epoch: 0, members: ['A'] }]); // re-sent despite no gap
    expect(r).toEqual({ applied: true, newEpoch: 0, distributed: 1 });
  });
});

describe('reconcileOwnedHiveEpochKeys (WI-887 gap-aware sweep)', () => {
  const member = (devicePubkeys: string[], revoked: string[] = []) =>
    ({
      deviceAttestations: devicePubkeys.map((device_pubkey) => ({ device_pubkey })),
      revokedPubkeys: revoked,
    }) as never;

  const cryptoSeams = (derived: number[]) => ({
    resolveCrypto: async () =>
      ({
        deriveEpochKey: async (_h: string, e: number) => {
          derived.push(e);
          return `K${e}` as never;
        },
        wrapKeyToMember: async () => new Uint8Array([1]),
      }) as never,
    resolveAuthorPubkey: async () => 'owner',
    persistWrappedKeys: async (_w: string, _s: string, _e: number, rows: readonly { memberDevicePubkey: string }[]) =>
      rows.length,
  });

  it('flag OFF ⇒ no scan, no work', async () => {
    const listHives = vi.fn(async () => [{ workspaceId: 'w', potHomeSlug: 'h' }]);
    const r = await reconcileOwnedHiveEpochKeys({ enabled: false }, { listHives });
    expect(r).toEqual({ scanned: 0, reconciled: 0 });
    expect(listHives).not.toHaveBeenCalled();
  });

  it('STEADY STATE (no gap) ⇒ scanned but NO crypto (perf guard)', async () => {
    const derived: number[] = [];
    const r = await reconcileOwnedHiveEpochKeys(
      { enabled: true },
      {
        ...cryptoSeams(derived),
        listHives: async () => [{ workspaceId: 'w', potHomeSlug: 'hello-world-hive' }],
        getCurrentEpoch: async () => 1,
        loadMembers: async () => [member(['A']), member(['B'])],
        // BOTH live devices already hold the current (epoch 1) key → no gap.
        loadEpochKeyDevices: async () => ['A', 'B'],
      },
    );
    expect(r).toEqual({ scanned: 1, reconciled: 1 - 1 }); // scanned 1, reconciled 0
    expect(derived).toEqual([]); // ← never derived a key: intact hive does NO crypto
  });

  // ── WI-6311: the epoch reads are federated-scoped; the member reader is not ──
  //
  // The sweep COMPARES the member set against the epoch-key set, so a half-resolved pair is
  // worse than either extreme: members resolve (populated) while epoch keys do not (empty),
  // the "everyone already holds the current key" guard can never be satisfied, and the O(E·M)
  // crypto it exists to prevent runs on EVERY sweep — forever, for a hive that is fine.
  it('DIVERGENT JOINER, steady state ⇒ epoch reads use the CANONICAL scope, members use the LOCAL handle, and the perf guard STILL fires', async () => {
    const derived: number[] = [];
    const epochScopes: string[] = [];
    const memberScopes: string[] = [];

    const r = await reconcileOwnedHiveEpochKeys(
      { enabled: true },
      {
        ...cryptoSeams(derived),
        listHives: async () => [{ workspaceId: 'w', potHomeSlug: LOCAL_HANDLE }],
        getCurrentEpoch: async (_w: string, slug: string) => {
          epochScopes.push(slug);
          return 1;
        },
        loadMembers: async (_w: string, slug: string) => {
          memberScopes.push(slug);
          return [member(['A']), member(['B'])];
        },
        // The rows exist ONLY under the canonical scope — which is the whole point: this is
        // what the projections actually wrote. Reading under the local handle returns [].
        loadEpochKeyDevices: async (_w: string, slug: string) => {
          epochScopes.push(slug);
          return slug === CANONICAL ? ['A', 'B'] : [];
        },
      },
    );

    // Every epoch-keyed read resolved; the member reader got the local handle it wants
    // (listHiveMembersForLocalPot resolves internally — resolving twice would be the other bug).
    expect(epochScopes).toEqual([CANONICAL, CANONICAL]);
    expect(memberScopes).toEqual([LOCAL_HANDLE]);

    // The payoff: the guard fires, so NO crypto. Before the fix loadEpochKeyDevices was called
    // with LOCAL_HANDLE, returned [], every device looked like a gap, and this asserted list
    // would be non-empty on every single sweep.
    expect(derived).toEqual([]);
    expect(r).toEqual({ scanned: 1, reconciled: 0 });
  });

  it('GAP (a member missing the current key) ⇒ reconciles that hive', async () => {
    const derived: number[] = [];
    const persisted: Array<{ epoch: number; members: string[] }> = [];
    const r = await reconcileOwnedHiveEpochKeys(
      { enabled: true },
      {
        resolveCrypto: async () =>
          ({
            deriveEpochKey: async (_h: string, e: number) => {
              derived.push(e);
              return `K${e}` as never;
            },
            wrapKeyToMember: async () => new Uint8Array([1]),
          }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: async (_w, _s, epoch, rows) => {
          persisted.push({ epoch, members: rows.map((row) => row.memberDevicePubkey) });
          return rows.length;
        },
        listHives: async () => [{ workspaceId: 'w', potHomeSlug: 'hello-world-hive' }],
        getCurrentEpoch: async () => 1,
        loadMembers: async () => [member(['A']), member(['B'])],
        // only 'A' holds the current key → 'B' has a GAP → reconcile.
        loadEpochKeyDevices: async () => ['A'],
      },
    );
    expect(r).toEqual({ scanned: 1, reconciled: 1 });
    expect(derived).toEqual([0, 1]); // backfilled [0..current]
    expect(persisted).toEqual([
      { epoch: 0, members: ['A', 'B'] },
      { epoch: 1, members: ['A', 'B'] }, // ← B (the stuck member) gets the current key
    ]);
  });
});

describe('WI-40537 (c75949 RULING 5) — the caller set of grantEpochKeysToMembers is PINNED', () => {
  // grantEpochKeysToMembers applies NO revocation filter of its own — deliberately. Its two
  // known callers are each safe at their OWN site: the upsertHiveMember hook filters the grant
  // set against the hive-wide revoked union BEFORE calling (hive-membership-store.ts, the
  // WI-40537 fix), and the reconcile delegation pre-filters at :382-406. A THIRD caller is the
  // event that reopens the grant-internal-filter question (an unfiltered new caller re-creates
  // the WI-40537 hole) — this pin is what surfaces it. Scope: packages/operator-core/lib
  // (non-test .ts) — the function is defined here and both known callers live here; a caller
  // added in another package should extend this list AND re-read c75949/c75950 first.
  it('exactly two non-test files reference it: the upsert hook + this wiring module', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, dirname, relative } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const libRoot = join(dirname(fileURLToPath(import.meta.url)), '../..'); // packages/operator-core/lib
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          // CALL-shape only (`grantEpochKeysToMembers(`): 4 other lib files mention the name in
          // prose comments (deferred-git-restore, hive-epoch-boot-deps, hive-epoch-boundary,
          // seed-cutter — verified 2026-08-22, all doc mentions, zero callers). A mention does
          // not reopen RULING 5; a new CALL does.
          /\bgrantEpochKeysToMembers\s*\(/.test(readFileSync(full, 'utf8'))
        ) {
          hits.push(relative(libRoot, full));
        }
      }
    };
    walk(libRoot);
    expect(hits.sort()).toEqual([
      'hive-membership-store.ts', // the upsert hook — filters hive-wide revoked BEFORE calling
      'sync/hyperbee/hive-epoch-boundary-wiring.ts', // definition + the pre-filtered reconcile delegation
    ]);
  });
});

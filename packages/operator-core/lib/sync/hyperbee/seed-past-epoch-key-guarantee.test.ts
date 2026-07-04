/**
 * seed-past-epoch-key-guarantee.test.ts — the CROSS-FEATURE regression guard for
 * the seed-bundle's Q-4 dependency (plan hive-seed-bundle-2026-07-04, D-009;
 * design memo agent-insights/hive-seed-bundle-design §Q-4).
 *
 * THE CONTRACT (ratified by the owner 2026-07-04): a newly-admitted member must
 * receive read keys for EVERY past epoch [0..current], so that a corestore SEED
 * — whose federated content is epoch-CIPHERTEXT under whatever epoch was current
 * when each op was written — is DECRYPTABLE by that member after admission.
 *
 * This is already the implemented + documented behavior of
 * `grantEpochKeysToMembers` ("Why [0..current], not current-only" in
 * hive-epoch-boundary-wiring.ts), and is asserted generically in
 * hive-epoch-boundary-wiring.test.ts. This file exists as an EXECUTABLE
 * TRIPWIRE named for the seed feature: if anyone later implements the
 * deliberately-deferred forward-secrecy policy (restrict new members to the
 * current epoch only), this test fails and forces them to reckon with the fact
 * that it makes a seed's pre-boundary history undecryptable — at which point the
 * seed manifest's `cutAtEpoch` gate (defer that store to the cold path when the
 * member lacks the epoch key) must be wired first.
 *
 * Hermetic: no PG, no real crypto — every seam injected (mirrors
 * hive-epoch-boundary-wiring.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { grantEpochKeysToMembers } from './hive-epoch-boundary-wiring';

describe('seed-bundle Q-4 guarantee — new members get ALL past-epoch keys', () => {
  async function grantWithCurrentEpoch(current: number, newMemberPubkeys: string[]) {
    const derivedEpochs: number[] = [];
    const persistedEpochs: number[] = [];
    const wrappedFor: string[] = [];
    const r = await grantEpochKeysToMembers(
      { workspaceId: 'w', hiveHomeSlug: 'papercusp', enabled: true, newMemberPubkeys },
      {
        resolveCrypto: async () =>
          ({
            deriveEpochKey: async (_h: string, e: number) => {
              derivedEpochs.push(e);
              return `K${e}` as never;
            },
            wrapKeyToMember: async (_k: unknown, pk: string) => {
              wrappedFor.push(pk);
              return new Uint8Array([1]);
            },
          }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: async (_w, _s, epoch, rows) => {
          persistedEpochs.push(epoch);
          return rows.length;
        },
        getCurrentEpoch: async () => current,
      },
    );
    return { r, derivedEpochs, persistedEpochs, wrappedFor };
  }

  it('grants EVERY epoch [0..current] to a new member (so seeded pre-boundary history decrypts)', async () => {
    const { r, derivedEpochs, persistedEpochs } = await grantWithCurrentEpoch(3, ['newmember-dev']);
    // The seed relies on this exact set — NOT [current] only.
    expect(derivedEpochs).toEqual([0, 1, 2, 3]);
    expect(persistedEpochs).toEqual([0, 1, 2, 3]);
    expect(r).toEqual({ applied: true, newEpoch: 3, distributed: 4 }); // 4 epochs × 1 member
  });

  it('epoch 0 is granted even when current > 0 — the seed tripwire', async () => {
    // If a forward-secrecy refactor ever restricts to current-only, epoch 0 would
    // drop out here and a seed cut before the boundary would be dead ciphertext.
    const { derivedEpochs } = await grantWithCurrentEpoch(5, ['m']);
    expect(derivedEpochs).toContain(0);
    expect(derivedEpochs[0]).toBe(0);
    expect(derivedEpochs.at(-1)).toBe(5);
  });

  it('a brand-new hive (current epoch 0) grants epoch 0 — the common dogfood case', async () => {
    // The canonical dogfood hive has no boundary bumps, so all content is under
    // epoch 0 and a new member decrypts the entire seed with its one epoch-0 key.
    const { derivedEpochs, r } = await grantWithCurrentEpoch(0, ['m']);
    expect(derivedEpochs).toEqual([0]);
    expect(r.distributed).toBe(1);
  });
});

import { describe, it, expect, vi } from 'vitest';

// The canonical invite is now COMMITTED (P-003), so goSharedHive's default canonicalSecret
// returns the BAKED secret. Mock the constant to null here so the gist/random-secret tests
// keep their pre-activation behaviour; the baked-secret tests pass `canonicalSecret` explicitly.
vi.mock('./canonical-hive-invite', () => ({ CANONICAL_PAPERCUSP_HIVE_INVITE: null, CANONICAL_HIVE_TEAM_ALLOWLIST: [] }));

import {
  adoptSharedHiveIdentity,
  goSharedHive,
  shareExistingHive,
  type SharedHiveState,
} from './papercusp-hive-share';
import type { OwnerHiveIdentity } from './papercusp-shared-identity-gist';

const okId = async () => ({ kind: 'ok' as const, token: 'tok', githubUserId: 7, githubLogin: 'avi' });
const EXISTING: OwnerHiveIdentity = {
  version: 1,
  privateKeyDer: Buffer.from('owner-der').toString('base64'),
  pubkeyBase64: 'owner-pub',
  inviteSecret: 'sec-existing',
};

// setHiveListing / authorHivePolicy return shapes we don't assert on — cast through unknown.
const setOk = async (): Promise<never> => ({}) as unknown as never;
const policyOk = async (): Promise<never> => ({ ok: true }) as unknown as never;

describe('adoptSharedHiveIdentity', () => {
  it('returns null when the flag is off — no gh / network', async () => {
    const resolveGithub = vi.fn();
    const res = await adoptSharedHiveIdentity({ isEnabled: async () => false, resolveGithub });
    expect(res).toBeNull();
    expect(resolveGithub).not.toHaveBeenCalled();
  });

  it('returns null when gh is not authenticated', async () => {
    const res = await adoptSharedHiveIdentity({
      isEnabled: async () => true,
      resolveGithub: async () => ({ kind: 'gh_auth_required' as const }),
    });
    expect(res).toBeNull();
  });

  it('first device (no gist): state.existing=null, nothing stored in keychain', async () => {
    const storeKey = vi.fn(async () => undefined);
    const res = await adoptSharedHiveIdentity({
      isEnabled: async () => true,
      resolveGithub: okId,
      fetchIdentity: async () => null,
      storeKey,
    });
    expect(res).toEqual({ githubLogin: 'avi', token: 'tok', existing: null });
    expect(storeKey).not.toHaveBeenCalled();
  });

  it('later device (gist found): adopts the owner key into the keychain BEFORE create', async () => {
    let storedValue: Buffer | undefined;
    const storeKey = async (_id: string, value: Buffer): Promise<undefined> => {
      storedValue = value;
      return undefined;
    };
    const res = await adoptSharedHiveIdentity({
      isEnabled: async () => true,
      resolveGithub: okId,
      fetchIdentity: async () => EXISTING,
      storeKey,
    });
    expect(res?.existing).toEqual(EXISTING);
    expect(storedValue && Buffer.isBuffer(storedValue)).toBe(true);
    expect(storedValue?.toString()).toBe('owner-der'); // decoded from base64
  });

  it('never throws on a resolver failure', async () => {
    const res = await adoptSharedHiveIdentity({
      isEnabled: async () => true,
      resolveGithub: async () => {
        throw new Error('boom');
      },
    });
    expect(res).toBeNull();
  });
});

describe('goSharedHive', () => {
  it('no-ops when state is null', async () => {
    const setListing = vi.fn(setOk);
    await goSharedHive(null, { setListing });
    expect(setListing).not.toHaveBeenCalled();
  });

  it('later device: announces (invite) with the existing secret + allowlist policy, NO publish', async () => {
    const publishIdentity = vi.fn();
    let listing: { visibility?: string; inviteSecret?: string } | undefined;
    let policy: { policy?: { membership?: string; allowlist?: string[] } } | undefined;
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', existing: EXISTING };

    await goSharedHive(state, {
      publishIdentity,
      setListing: async (input) => {
        listing = input;
        return {} as unknown as never;
      },
      authorPolicy: async (input) => {
        policy = input;
        return { ok: true } as unknown as never;
      },
    });

    expect(publishIdentity).not.toHaveBeenCalled();
    expect(listing).toMatchObject({ visibility: 'invite', inviteSecret: 'sec-existing' });
    expect(policy?.policy).toEqual({ membership: 'allowlist', allowlist: ['avi'], comms: { defaultTier: 'steer' } });
  });

  it('P-019: an `open` public hive authors membership:open + contentWriteAuthority:author-scoped', async () => {
    let policy: { policy?: { membership?: string; allowlist?: string[]; contentWriteAuthority?: string } } | undefined;
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', existing: EXISTING };
    await goSharedHive(state, {
      setListing: async () => ({}) as unknown as never,
      authorPolicy: async (input) => {
        policy = input;
        return { ok: true } as unknown as never;
      },
      membershipMode: 'open',
    });
    expect(policy?.policy?.membership).toBe('open');
    // open ⇒ author-scoped by default (D-012: strangers can't delete others' plans)
    expect(policy?.policy?.contentWriteAuthority).toBe('author-scoped');
  });

  it('P-019: default (no membershipMode) stays the private allowlist hive, no author-scoping (today)', async () => {
    let policy: { policy?: { membership?: string; contentWriteAuthority?: string } } | undefined;
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', existing: EXISTING };
    await goSharedHive(state, {
      setListing: async () => ({}) as unknown as never,
      authorPolicy: async (input) => {
        policy = input;
        return { ok: true } as unknown as never;
      },
    });
    expect(policy?.policy?.membership).toBe('allowlist');
    expect(policy?.policy?.contentWriteAuthority).toBeUndefined();
  });

  it('first device: reads key → publishes gist → announces with the fresh secret + policy', async () => {
    let published: OwnerHiveIdentity | undefined;
    let listing: { visibility?: string; inviteSecret?: string } | undefined;
    let policy: { policy?: { allowlist?: string[] } } | undefined;
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', existing: null };

    await goSharedHive(state, {
      publishIdentity: async (_token, identity) => {
        published = identity;
        return { gistId: 'g' };
      },
      setListing: async (input) => {
        listing = input;
        return {} as unknown as never;
      },
      authorPolicy: async (input) => {
        policy = input;
        return { ok: true } as unknown as never;
      },
      loadKey: async () => ({ kind: 'ok' as const, value: Buffer.from('mykey') }),
      randomSecret: () => 'fresh-secret',
      derivePubkey: () => 'derived-pub',
    });

    expect(published).toMatchObject({
      inviteSecret: 'fresh-secret',
      privateKeyDer: Buffer.from('mykey').toString('base64'),
      pubkeyBase64: 'derived-pub',
    });
    expect(listing).toMatchObject({ visibility: 'invite', inviteSecret: 'fresh-secret' });
    expect(policy?.policy?.allowlist).toEqual(['avi']);
  });

  it('first device WITH a baked canonical secret: publishes + announces the BAKED secret (not random)', async () => {
    let published: OwnerHiveIdentity | undefined;
    let listing: { inviteSecret?: string } | undefined;
    await goSharedHive(
      { githubLogin: 'avi', token: 'tok', existing: null },
      {
        canonicalSecret: () => 'baked-canonical-sec',
        publishIdentity: async (_t, id) => {
          published = id;
          return { gistId: 'g' };
        },
        setListing: async (i) => {
          listing = i;
          return {} as unknown as never;
        },
        authorPolicy: async () => ({ ok: true }) as unknown as never,
        loadKey: async () => ({ kind: 'ok' as const, value: Buffer.from('mykey') }),
        randomSecret: () => 'should-not-be-used',
        derivePubkey: () => 'pub',
      },
    );
    // The baked secret is authoritative — every owner device must announce on it.
    expect(published?.inviteSecret).toBe('baked-canonical-sec');
    expect(listing?.inviteSecret).toBe('baked-canonical-sec');
  });

  it('P-007: admits the owner PLUS the team allowlist (deduped) in the admission policy', async () => {
    let policy: { policy?: { membership?: string; allowlist?: string[] } } | undefined;
    await goSharedHive(
      { githubLogin: 'avi', token: 'tok', existing: EXISTING },
      {
        teamAllowlist: ['teammate-1', 'teammate-2', 'avi'], // 'avi' dup collapses
        setListing: async () => ({}) as unknown as never,
        authorPolicy: async (input) => {
          policy = input;
          return { ok: true } as unknown as never;
        },
      },
    );
    expect(policy?.policy).toEqual({ membership: 'allowlist', allowlist: ['avi', 'teammate-1', 'teammate-2'], comms: { defaultTier: 'steer' } });
  });

  it('later device: a baked canonical secret OVERRIDES a drifted gist secret on announce', async () => {
    let listing: { inviteSecret?: string } | undefined;
    await goSharedHive(
      { githubLogin: 'avi', token: 'tok', existing: { ...EXISTING, inviteSecret: 'drifted-old' } },
      {
        canonicalSecret: () => 'baked-canonical-sec',
        setListing: async (i) => {
          listing = i;
          return {} as unknown as never;
        },
        authorPolicy: async () => ({ ok: true }) as unknown as never,
      },
    );
    expect(listing?.inviteSecret).toBe('baked-canonical-sec');
  });

  it('first device but the keychain read fails → no publish / announce', async () => {
    const publishIdentity = vi.fn();
    const setListing = vi.fn(setOk);
    await goSharedHive(
      { githubLogin: 'avi', token: 'tok', existing: null },
      { publishIdentity, setListing, loadKey: async () => ({ kind: 'error' as const }) },
    );
    expect(publishIdentity).not.toHaveBeenCalled();
    expect(setListing).not.toHaveBeenCalled();
  });

  it('never throws when announce fails', async () => {
    await expect(
      goSharedHive(
        { githubLogin: 'avi', token: 'tok', existing: EXISTING },
        {
          setListing: async () => {
            throw new Error('announce down');
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('shareExistingHive (enable-later / re-boot path)', () => {
  it('no-ops when the flag is off — no gh resolve', async () => {
    const resolveGithub = vi.fn();
    await shareExistingHive({ isEnabled: async () => false, resolveGithub });
    expect(resolveGithub).not.toHaveBeenCalled();
  });

  it('no-ops when gh is not authenticated', async () => {
    const setListing = vi.fn(setOk);
    await shareExistingHive({
      isEnabled: async () => true,
      resolveGithub: async () => ({ kind: 'gh_auth_required' as const }),
      setListing,
    });
    expect(setListing).not.toHaveBeenCalled();
  });

  it('first device (no gist): publishes the local key + announces + policy', async () => {
    let published: OwnerHiveIdentity | undefined;
    let listing: { visibility?: string } | undefined;
    let policy: { policy?: { allowlist?: string[] } } | undefined;
    await shareExistingHive({
      isEnabled: async () => true,
      resolveGithub: okId,
      fetchIdentity: async () => null,
      loadKey: async () => ({ kind: 'ok' as const, value: Buffer.from('localkey') }),
      randomSecret: () => 's',
      derivePubkey: () => 'pub',
      publishIdentity: async (_t, id) => {
        published = id;
        return { gistId: 'g' };
      },
      setListing: async (i) => {
        listing = i;
        return {} as unknown as never;
      },
      authorPolicy: async (i) => {
        policy = i;
        return { ok: true } as unknown as never;
      },
    });
    expect(published).toMatchObject({ inviteSecret: 's' });
    expect(listing).toMatchObject({ visibility: 'invite' });
    expect(policy?.policy?.allowlist).toEqual(['avi']);
  });

  it('gist matches this hive pubkey → announces with the gist secret', async () => {
    let listing: { inviteSecret?: string } | undefined;
    const gist: OwnerHiveIdentity = { ...EXISTING, pubkeyBase64: 'match-pub' };
    await shareExistingHive({
      isEnabled: async () => true,
      resolveGithub: okId,
      fetchIdentity: async () => gist,
      loadPubkey: async () => ({ kind: 'ok' as const, pubkeyBase64: 'match-pub' }),
      setListing: async (i) => {
        listing = i;
        return {} as unknown as never;
      },
      authorPolicy: async () => ({ ok: true }) as unknown as never,
    });
    expect(listing).toMatchObject({ inviteSecret: gist.inviteSecret });
  });

  it('gist pubkey MISMATCHES this hive → skips (no announce of a wrong identity)', async () => {
    const setListing = vi.fn(setOk);
    await shareExistingHive({
      isEnabled: async () => true,
      resolveGithub: okId,
      fetchIdentity: async () => ({ ...EXISTING, pubkeyBase64: 'gist-pub' }),
      loadPubkey: async () => ({ kind: 'ok' as const, pubkeyBase64: 'different-local-pub' }),
      setListing,
    });
    expect(setListing).not.toHaveBeenCalled();
  });

  // WI-762: a non-owner member device legitimately holds NO local hive key at
  // all — `loadHiveKeyStatus` returns `not_found`, not a mismatched pubkey.
  // There is no competing local identity to check, so this must proceed
  // (this is the normal, expected path for every member device — the ORIGINAL
  // bug report worried a naive fix would instead make this incorrectly bail).
  it('no local key held (normal member device, not_found) → proceeds + announces with the gist secret', async () => {
    let listing: { inviteSecret?: string } | undefined;
    const gist: OwnerHiveIdentity = { ...EXISTING, pubkeyBase64: 'owner-only-pub' };
    await shareExistingHive({
      isEnabled: async () => true,
      resolveGithub: okId,
      fetchIdentity: async () => gist,
      loadPubkey: async () => ({ kind: 'not_found' as const }),
      setListing: async (i) => {
        listing = i;
        return {} as unknown as never;
      },
      authorPolicy: async () => ({ ok: true }) as unknown as never,
    });
    expect(listing).toMatchObject({ inviteSecret: gist.inviteSecret });
  });

  // WI-762 (the actual bug fixed here): a local key IS present but the keychain
  // read/decrypt failed — this must NOT be treated as "no local identity" (the
  // original `localPubkey && …` short-circuit did exactly that, silently
  // proceeding to adopt an unverified gist identity). Fail closed instead.
  it('local key present but unreadable (error) → does NOT adopt an unverified identity', async () => {
    const setListing = vi.fn(setOk);
    await shareExistingHive({
      isEnabled: async () => true,
      resolveGithub: okId,
      fetchIdentity: async () => ({ ...EXISTING, pubkeyBase64: 'gist-pub' }),
      loadPubkey: async () => ({ kind: 'error' as const, reason: 'decryption_failed' }),
      setListing,
    });
    expect(setListing).not.toHaveBeenCalled();
  });
});

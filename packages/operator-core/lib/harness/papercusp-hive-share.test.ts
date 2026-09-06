import { describe, it, expect, vi } from 'vitest';

// The canonical invite is now COMMITTED (P-003), so goSharedHive's default canonicalSecret
// returns the BAKED secret. Mock the constant to null here so the gist/random-secret tests
// keep their pre-activation behaviour; the baked-secret tests pass `canonicalSecret` explicitly.
vi.mock('./canonical-hive-invite', () => ({ CANONICAL_PAPERCUSP_HIVE_INVITE: null }));
// The team allowlist lives in its own SERVER-ONLY module (WI-38322 — keeping it beside the
// invite leaked the real team GitHub logins into the client bundle). Mock it separately, and
// still to [], so these tests keep asserting the no-extra-teammates behaviour they always did.
vi.mock('./canonical-hive-team-allowlist', () => ({ CANONICAL_HIVE_TEAM_ALLOWLIST: [] }));

import {
  adoptSharedHiveIdentity,
  authorBootPolicy,
  goSharedHive,
  mergeBootPolicy,
  shareExistingHive,
  type SharedHiveState,
} from './papercusp-hive-share';
import type { OwnerHiveIdentity } from './papercusp-shared-identity-gist';

/** WI-2147371: the gist is sealed under an owner-held passphrase, so every adopt/share
 *  path needs one — without it sharing fail-closes and never reaches a write. */
const TEST_PASS = 'a-sufficiently-long-owner-passphrase';
/** The gist record shape fetchIdentityRecord returns. */
function rec(identity: OwnerHiveIdentity, legacyPlaintext = false) {
  return { identity, gistId: 'g1', legacyPlaintext };
}

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
      fetchIdentityRecord: async () => null,
      identityPassphrase: async () => TEST_PASS,
      storeKey,
    });
    expect(res).toEqual({ githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: null });
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
      fetchIdentityRecord: async () => rec(EXISTING),
      identityPassphrase: async () => TEST_PASS,
      storeKey,
    });
    expect(res?.existing).toEqual(EXISTING);
    expect(storedValue && Buffer.isBuffer(storedValue)).toBe(true);
    expect(storedValue?.toString()).toBe('owner-der'); // decoded from base64
  });

  it('WI-2147371: FAIL-CLOSED with no owner passphrase — no fetch, no state, no publish path', async () => {
    // There is deliberately no plaintext fallback: without the sealing secret the whole
    // sharing path no-ops and the device keeps its own hive identity.
    const fetchIdentityRecord = vi.fn(async () => null);
    for (const bad of [null, '', 'tooshort']) {
      const res = await adoptSharedHiveIdentity({
        isEnabled: async () => true,
        resolveGithub: okId,
        fetchIdentityRecord,
        identityPassphrase: async () => bad,
        storeKey: async () => undefined,
      });
      expect(res).toBeNull();
    }
    expect(fetchIdentityRecord).not.toHaveBeenCalled();
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
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: EXISTING };

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

  it('WI-2147371: an adopted LEGACY PLAINTEXT gist is RE-SEALED in place, not merely adopted', async () => {
    // Adopting a pre-fix plaintext blob leaves the private key readable by anyone who
    // learns the gist URL. Fixing the write path only stops NEW leaks; retiring the LIVE
    // one requires re-publishing (which PATCHes the canonical gist) with the passphrase.
    const publishIdentity = vi.fn(async () => ({ gistId: 'g1' }));
    const state: SharedHiveState = {
      githubLogin: 'avi',
      token: 'tok',
      passphrase: TEST_PASS,
      existingLegacyPlaintext: true,
      existing: EXISTING,
    };

    await goSharedHive(state, {
      publishIdentity,
      setListing: async () => ({}) as unknown as never,
      authorPolicy: async () => ({ ok: true }) as unknown as never,
    });

    expect(publishIdentity).toHaveBeenCalledTimes(1);
    const [token, identity, passphrase] = publishIdentity.mock.calls[0] as unknown as [
      string,
      OwnerHiveIdentity,
      string,
    ];
    expect(token).toBe('tok');
    expect(identity).toEqual(EXISTING); // same identity — a re-seal, never a new keypair
    expect(passphrase).toBe(TEST_PASS);
  });

  it('WI-2147371: a SEALED (non-legacy) adopted gist is NOT re-published', async () => {
    const publishIdentity = vi.fn();
    const state: SharedHiveState = {
      githubLogin: 'avi',
      token: 'tok',
      passphrase: TEST_PASS,
      existingLegacyPlaintext: false,
      existing: EXISTING,
    };
    await goSharedHive(state, {
      publishIdentity,
      setListing: async () => ({}) as unknown as never,
      authorPolicy: async () => ({ ok: true }) as unknown as never,
    });
    expect(publishIdentity).not.toHaveBeenCalled();
  });

  it('P-019: an `open` public hive authors membership:open + contentWriteAuthority:author-scoped', async () => {
    let policy: { policy?: { membership?: string; allowlist?: string[]; contentWriteAuthority?: string } } | undefined;
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: EXISTING };
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
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: EXISTING };
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
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: null };

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
      { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: null },
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
      { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: EXISTING },
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
      { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: { ...EXISTING, inviteSecret: 'drifted-old' } },
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
      { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: null },
      { publishIdentity, setListing, loadKey: async () => ({ kind: 'error' as const }) },
    );
    expect(publishIdentity).not.toHaveBeenCalled();
    expect(setListing).not.toHaveBeenCalled();
  });

  it('never throws when announce fails', async () => {
    await expect(
      goSharedHive(
        { githubLogin: 'avi', token: 'tok', passphrase: TEST_PASS, existingLegacyPlaintext: false, existing: EXISTING },
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
      fetchIdentityRecord: async () => null,
      identityPassphrase: async () => TEST_PASS,
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
      fetchIdentityRecord: async () => rec(gist),
      identityPassphrase: async () => TEST_PASS,
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
      fetchIdentityRecord: async () => rec({ ...EXISTING, pubkeyBase64: 'gist-pub' }),
      identityPassphrase: async () => TEST_PASS,
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
      fetchIdentityRecord: async () => rec(gist),
      identityPassphrase: async () => TEST_PASS,
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
      fetchIdentityRecord: async () => rec({ ...EXISTING, pubkeyBase64: 'gist-pub' }),
      identityPassphrase: async () => TEST_PASS,
      loadPubkey: async () => ({ kind: 'error' as const, reason: 'decryption_failed' }),
      setListing,
    });
    expect(setListing).not.toHaveBeenCalled();
  });
});

describe('WI-2039866: the boot re-author is a DEFAULTS + allowlist-UNION pass, never a strip', () => {
  const DESIRED = { membership: 'allowlist' as const, allowlist: ['papercupai'], comms: { defaultTier: 'steer' as const } };
  const signedRow = (policy: Record<string, unknown>, policyVersion: number) => ({
    workspaceId: 'ws',
    potHomeSlug: 'papercusp',
    policy,
    // canonical form = sorted keys (hive-policy-schema.canonicalizeHivePolicy)
    policyJson: JSON.stringify(Object.fromEntries(Object.entries(policy).sort(([a], [b]) => (a < b ? -1 : 1)))),
    policyVersion,
    ownerPubkey: 'pk',
    signature: 'sig',
    fedHlc: null,
    updatedAt: 0,
  });

  it('mergeBootPolicy: owner-added logins survive a boot (union) and every other owner key rides through', () => {
    const current = {
      membership: 'allowlist',
      allowlist: ['papercupai', 'aviynw'],
      comms: { defaultTier: 'message' },
      moderation: { bannedGithubIds: ['42'] },
      rate: { ops: 5 },
    } as Record<string, unknown>;
    const next = mergeBootPolicy(current, DESIRED);
    expect(next.allowlist).toEqual(['papercupai', 'aviynw']); // the tower's live lockout: boot alone wrote ['papercupai']
    expect(next.comms).toEqual({ defaultTier: 'message' }); // the owner's explicit signed choice wins over the boot default
    expect(next.moderation).toEqual({ bannedGithubIds: ['42'] });
    expect(next.rate).toEqual({ ops: 5 });
    expect(next.membership).toBe('allowlist');
  });

  it('mergeBootPolicy: fills defaults on an empty current policy (the first-boot shape, byte-identical to the old author)', () => {
    expect(mergeBootPolicy({}, { ...DESIRED, contentWriteAuthority: 'author-scoped' })).toEqual({
      membership: 'allowlist',
      allowlist: ['papercupai'],
      comms: { defaultTier: 'steer' },
      contentWriteAuthority: 'author-scoped',
    });
    expect(mergeBootPolicy({}, DESIRED)).toEqual({ membership: 'allowlist', allowlist: ['papercupai'], comms: { defaultTier: 'steer' } });
  });

  it('authorBootPolicy: skips the re-sign when the merged policy is byte-identical (no one-version-per-restart churn)', async () => {
    const current = signedRow({ allowlist: ['papercupai', 'aviynw'], comms: { defaultTier: 'steer' }, membership: 'allowlist' }, 8082);
    let signed = 0;
    const res = await authorBootPolicy(
      { workspaceId: 'ws', potHomeSlug: 'papercusp', policy: DESIRED },
      {
        resolveWorkspaceId: async (w) => w,
        readCurrent: async () => current,
        loadOwnerPubkey: async () => 'pk',
        sign: async () => {
          signed++;
          return Buffer.alloc(64);
        },
        write: async (i) => ({ ...current, policyJson: i.policyJson, policyVersion: i.policyVersion }),
      },
    );
    expect(res).toMatchObject({ ok: true, unchanged: true, policy: { policyVersion: 8082 } });
    expect(signed).toBe(0);
  });

  it('authorBootPolicy: re-signs with the UNION when this boot alone would have stripped a signed login', async () => {
    const current = signedRow({ allowlist: ['aviynw'], comms: { defaultTier: 'steer' }, membership: 'allowlist' }, 1);
    let written: string | undefined;
    const res = await authorBootPolicy(
      { workspaceId: 'ws', potHomeSlug: 'papercusp', policy: DESIRED },
      {
        resolveWorkspaceId: async (w) => w,
        readCurrent: async () => current,
        loadOwnerPubkey: async () => 'pk',
        sign: async () => Buffer.alloc(64),
        write: async (i) => {
          written = i.policyJson;
          return { ...current, policyJson: i.policyJson, policyVersion: i.policyVersion };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('unchanged');
    expect(JSON.parse(written!)).toEqual({ allowlist: ['papercupai', 'aviynw'], comms: { defaultTier: 'steer' }, membership: 'allowlist' });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { adoptSharedHiveIdentity, goSharedHive, type SharedHiveState } from './papercusp-hive-share';
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
    expect(policy?.policy).toEqual({ membership: 'allowlist', allowlist: ['avi'] });
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

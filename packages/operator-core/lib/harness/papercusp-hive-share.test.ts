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
    const storeKey = vi.fn(async () => undefined);
    const res = await adoptSharedHiveIdentity({
      isEnabled: async () => true,
      resolveGithub: okId,
      fetchIdentity: async () => EXISTING,
      storeKey,
    });
    expect(res?.existing).toEqual(EXISTING);
    expect(storeKey).toHaveBeenCalledTimes(1);
    const [, value] = storeKey.mock.calls[0];
    expect(Buffer.isBuffer(value)).toBe(true);
    expect((value as Buffer).toString()).toBe('owner-der'); // decoded from base64
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
  const setOk = async () => ({}) as never;
  const policyOk = async () => ({ ok: true }) as never;

  it('no-ops when state is null', async () => {
    const setListing = vi.fn(setOk);
    await goSharedHive(null, { setListing });
    expect(setListing).not.toHaveBeenCalled();
  });

  it('later device: announces (invite) with the existing secret + allowlist policy, NO publish', async () => {
    const publishIdentity = vi.fn();
    const setListing = vi.fn(setOk);
    const authorPolicy = vi.fn(policyOk);
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', existing: EXISTING };

    await goSharedHive(state, { publishIdentity, setListing, authorPolicy });

    expect(publishIdentity).not.toHaveBeenCalled();
    expect(setListing.mock.calls[0][0]).toMatchObject({ visibility: 'invite', inviteSecret: 'sec-existing' });
    expect(authorPolicy.mock.calls[0][0].policy).toEqual({ membership: 'allowlist', allowlist: ['avi'] });
  });

  it('first device: reads key → publishes gist → announces with the fresh secret + policy', async () => {
    const publishIdentity = vi.fn(async () => ({ gistId: 'g' }));
    const setListing = vi.fn(setOk);
    const authorPolicy = vi.fn(policyOk);
    const loadKey = vi.fn(async () => ({ kind: 'ok' as const, value: Buffer.from('mykey') }));
    const state: SharedHiveState = { githubLogin: 'avi', token: 'tok', existing: null };

    await goSharedHive(state, {
      publishIdentity,
      setListing,
      authorPolicy,
      loadKey,
      randomSecret: () => 'fresh-secret',
      derivePubkey: () => 'derived-pub',
    });

    expect(publishIdentity.mock.calls[0][1]).toMatchObject({
      inviteSecret: 'fresh-secret',
      privateKeyDer: Buffer.from('mykey').toString('base64'),
      pubkeyBase64: 'derived-pub',
    });
    expect(setListing.mock.calls[0][0]).toMatchObject({ visibility: 'invite', inviteSecret: 'fresh-secret' });
    expect(authorPolicy.mock.calls[0][0].policy.allowlist).toEqual(['avi']);
  });

  it('first device but the keychain read fails → no publish / announce', async () => {
    const publishIdentity = vi.fn();
    const setListing = vi.fn(setOk);
    const loadKey = vi.fn(async () => ({ kind: 'error' as const }));
    await goSharedHive(
      { githubLogin: 'avi', token: 'tok', existing: null },
      { publishIdentity, setListing, loadKey },
    );
    expect(publishIdentity).not.toHaveBeenCalled();
    expect(setListing).not.toHaveBeenCalled();
  });

  it('never throws when announce fails', async () => {
    const setListing = vi.fn(async () => {
      throw new Error('announce down');
    });
    await expect(
      goSharedHive({ githubLogin: 'avi', token: 'tok', existing: EXISTING }, { setListing }),
    ).resolves.toBeUndefined();
  });
});

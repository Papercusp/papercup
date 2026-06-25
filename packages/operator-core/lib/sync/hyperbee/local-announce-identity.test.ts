/**
 * local-announce-identity tests (Fix 1 + Fix 6).
 *
 * The CRITICAL property under test: the announce identity resolves the device
 * keypair under the CANONICAL per-user keychain id
 * `<github_user_id>:<machine-fingerprint>` (built via the same
 * `resolveDeviceKeychainId` the join/contributor-file publish path uses), NOT
 * a fixed `'papercusp-device'`. If it didn't, the announced device_pubkey
 * would be a key the published contributor file was NOT signed with, and every
 * read-admission channel-2 check on the remote peer would fail.
 *
 * All inputs are injected — no live gh auth, no live keychain.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveLocalAnnounceIdentity } from './local-announce-identity';
import { resolveDeviceKeychainId } from '../../identity/device-keychain-id';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG_CORE_KEY = 'a'.repeat(64);

function stubUser(id = 4242, login = 'alice') {
  return vi.fn(async () => ({ id, login }));
}
function stubKeypair() {
  // Echoes the keychainId it was loaded with so the test can assert which id
  // the device keypair was resolved under.
  return vi.fn(async (keychainId: string) => ({ keychainId, pubkeyBase64: 'PUBKEY==' }));
}

describe('resolveLocalAnnounceIdentity', () => {
  it('loads the keypair under the canonical per-user keychain id (Fix 1)', async () => {
    const resolveGithubUser = stubUser(4242, 'alice');
    const loadKeypair = stubKeypair();
    // Deterministic keychain-id builder so we can assert the exact id.
    const buildKeychainId = vi.fn((uid: number) => `${uid}:test-machine`);

    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      resolveGithubUser,
      loadKeypair,
      buildKeychainId,
      resolveAttestationGistId: async () => 'g',
    });

    // The keychain id is keyed by the resolved gh user id — NOT a fixed string.
    expect(buildKeychainId).toHaveBeenCalledWith(4242);
    expect(identity.keychainId).toBe('4242:test-machine');
    // The keypair was loaded under that SAME id.
    expect(loadKeypair).toHaveBeenCalledWith('4242:test-machine');
    expect(identity.keychainId).not.toBe('papercusp-device');

    expect(identity.devicePubkeyBase64).toBe('PUBKEY==');
    expect(identity.githubUserId).toBe(4242);
    expect(identity.githubLogin).toBe('alice');
  });

  it('uses the REAL resolveDeviceKeychainId by default (matches the publish path)', async () => {
    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      resolveGithubUser: stubUser(777, 'bob'),
      loadKeypair: stubKeypair(),
      resolveAttestationGistId: async () => 'g',
      // no buildKeychainId override → the canonical resolver is used
    });
    // Same id the join path would build for this user on this machine.
    expect(identity.keychainId).toBe(resolveDeviceKeychainId(777));
    expect(identity.keychainId.startsWith('777:')).toBe(true);
  });

  it('resolves the gh user BEFORE building the keychain id (id is user-keyed)', async () => {
    const order: string[] = [];
    const resolveGithubUser = vi.fn(async () => {
      order.push('user');
      return { id: 11, login: 'carol' };
    });
    const buildKeychainId = vi.fn((uid: number) => {
      order.push('build');
      return `${uid}:m`;
    });
    const loadKeypair = vi.fn(async (keychainId: string) => {
      order.push('load');
      return { keychainId, pubkeyBase64: 'P' };
    });

    await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      resolveGithubUser,
      buildKeychainId,
      loadKeypair,
      resolveAttestationGistId: async () => 'g',
    });

    // user must resolve before the id is built + the keypair is loaded.
    expect(order.indexOf('user')).toBeLessThan(order.indexOf('build'));
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('load'));
  });

  it('an explicit keychainId override wins (tests / multi-identity dev)', async () => {
    const buildKeychainId = vi.fn(() => 'should-not-be-used');
    const loadKeypair = stubKeypair();
    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      keychainId: 'explicit-id',
      resolveGithubUser: stubUser(),
      loadKeypair,
      buildKeychainId,
      resolveAttestationGistId: async () => 'g',
    });
    expect(identity.keychainId).toBe('explicit-id');
    expect(buildKeychainId).not.toHaveBeenCalled();
    expect(loadKeypair).toHaveBeenCalledWith('explicit-id');
  });

  it('resolves the attestation gist id via the injected resolver (write-free join)', async () => {
    const resolveAttestationGistId = vi.fn(async () => 'gist-xyz-789');
    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      resolveGithubUser: stubUser(4242, 'alice'),
      loadKeypair: stubKeypair(),
      buildKeychainId: (uid: number) => `${uid}:m`,
      resolveAttestationGistId,
    });
    // The resolver is called with this peer's resolved identity inputs.
    expect(resolveAttestationGistId).toHaveBeenCalledWith(
      expect.objectContaining({
        keychainId: '4242:m',
        pubkeyBase64: 'PUBKEY==',
        githubUserId: 4242,
        githubLogin: 'alice',
      }),
    );
    // The gist id rides the announce identity (carried on the signed announce).
    expect(identity.attestationGistId).toBe('gist-xyz-789');
  });

  it('throws when logCoreKeyHex is missing', async () => {
    await expect(
      resolveLocalAnnounceIdentity({
        logCoreKeyHex: '',
        resolveGithubUser: stubUser(),
        loadKeypair: stubKeypair(),
      }),
    ).rejects.toThrow(/logCoreKeyHex required/);
  });

  it('propagates a gh-resolution failure (caller stays local-only)', async () => {
    await expect(
      resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        resolveGithubUser: vi.fn(async () => {
          throw new Error('gh not authenticated');
        }),
        loadKeypair: stubKeypair(),
      }),
    ).rejects.toThrow(/gh not authenticated/);
  });

  it('falls back to the last-good cached identity when GitHub user resolution is transiently unavailable', async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');

    await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      cachePath,
      resolveGithubUser: stubUser(4242, 'alice'),
      buildKeychainId: (uid: number) => `${uid}:m`,
      loadKeypair: stubKeypair(),
      resolveAttestationGistId: async () => 'gist-cached',
    });

    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      cachePath,
      resolveGithubUser: vi.fn(async () => {
        throw new Error('GitHub timeout');
      }),
      loadKeypair: vi.fn(async (keychainId: string) => ({
        keychainId,
        pubkeyBase64: 'PUBKEY==',
      })),
    });

    expect(identity).toMatchObject({
      keychainId: '4242:m',
      devicePubkeyBase64: 'PUBKEY==',
      githubUserId: 4242,
      githubLogin: 'alice',
      attestationGistId: 'gist-cached',
    });
  });

  it('rejects a cached identity when the keychain pubkey no longer matches the cached pubkey', async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        keychainId: '4242:m',
        devicePubkeyBase64: 'OLDPUB==',
        githubUserId: 4242,
        githubLogin: 'alice',
        attestationGistId: 'gist-cached',
      }),
      'utf8',
    );

    await expect(
      resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        cachePath,
        resolveGithubUser: vi.fn(async () => {
          throw new Error('GitHub timeout');
        }),
        loadKeypair: vi.fn(async (keychainId: string) => ({
          keychainId,
          pubkeyBase64: 'NEWPUB==',
        })),
      }),
    ).rejects.toThrow(/GitHub timeout/);
  });
});

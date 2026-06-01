/**
 * local-announce-identity — resolve THIS peer's identity for the Model B
 * signed announce (Stage 4b).
 *
 * The announce binds our writable log core to our device identity:
 *   { device_pubkey, github_user_id, github_login, log_core_key, sig }
 *
 * The log core key comes from the boot's own log; the rest of the identity is
 * resolved here:
 *   - keychainId / device_pubkey — the device Ed25519 keypair, loaded (or
 *     generated, idempotent) from the OS keychain under a fixed per-machine id.
 *     The pubkey is the SAME raw-32-byte base64 the two-channel binding uses,
 *     so a verified announce identifies a device whose binding the remote
 *     peer's read-admission can check.
 *   - github_user_id / github_login — the locally-authenticated GitHub user
 *     (gh CLI token → `GET /user`), the channel-1/channel-2 inputs the remote
 *     peer needs to verify our binding.
 *
 * Throws when the identity can't be resolved (no gh auth / keychain failure).
 * boot.ts's swarm-join catch treats that as "stay local-only" — a peer that
 * can't announce simply doesn't federate, which is correct.
 */

import { loadOrGenerateDeviceKeypair } from '@/lib/identity/attest';
import { getOctokit } from '@/lib/identity/octokit-client';

/**
 * Fixed per-machine keychain id for the device keypair. Matches the keychain
 * service convention (`papercusp-device-keypair`); the SAME id is reused on
 * every boot so the device pubkey is stable across restarts.
 */
export const DEVICE_KEYCHAIN_ID = 'papercusp-device' as const;

export interface LocalAnnounceIdentity {
  keychainId: string;
  /** Raw 32-byte Ed25519 device pubkey, base64 (== binding device_pubkey). */
  devicePubkeyBase64: string;
  githubUserId: number;
  githubLogin: string;
}

export interface ResolveLocalAnnounceIdentityOpts {
  /** 64-hex Hypercore key of our writable log (from boot's own log). */
  logCoreKeyHex: string;
  /** Override the keychain id (tests / multi-identity dev). */
  keychainId?: string;
  /**
   * Resolve the locally-authenticated GitHub user. Defaults to the gh-token
   * Octokit `users.getAuthenticated()`. Injectable for tests.
   */
  resolveGithubUser?: () => Promise<{ id: number; login: string }>;
  /** Override the keypair loader (tests). */
  loadKeypair?: (keychainId: string) => Promise<{ keychainId: string; pubkeyBase64: string }>;
}

async function defaultResolveGithubUser(): Promise<{ id: number; login: string }> {
  const oc = await getOctokit();
  if (!oc) {
    throw new Error('local-announce-identity: gh not authenticated (run `gh auth login`)');
  }
  const { data } = await oc.users.getAuthenticated();
  if (typeof data.id !== 'number' || typeof data.login !== 'string' || data.login.length === 0) {
    throw new Error('local-announce-identity: GET /user returned an unexpected shape');
  }
  return { id: data.id, login: data.login };
}

/**
 * Resolve the local peer's announce identity. Throws on any failure so the
 * caller's swarm-join catch keeps the harness local-only.
 */
export async function resolveLocalAnnounceIdentity(
  opts: ResolveLocalAnnounceIdentityOpts,
): Promise<LocalAnnounceIdentity> {
  if (!opts.logCoreKeyHex) {
    throw new Error('resolveLocalAnnounceIdentity: logCoreKeyHex required');
  }
  const keychainId = opts.keychainId ?? DEVICE_KEYCHAIN_ID;
  const loadKeypair = opts.loadKeypair ?? loadOrGenerateDeviceKeypair;
  const resolveUser = opts.resolveGithubUser ?? defaultResolveGithubUser;

  const [keypair, user] = await Promise.all([loadKeypair(keychainId), resolveUser()]);

  return {
    keychainId,
    devicePubkeyBase64: keypair.pubkeyBase64,
    githubUserId: user.id,
    githubLogin: user.login,
  };
}

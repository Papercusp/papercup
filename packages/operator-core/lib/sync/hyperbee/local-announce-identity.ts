/**
 * local-announce-identity — resolve THIS peer's identity for the Model B
 * signed announce (Stage 4b).
 *
 * The announce binds our writable log core to our device identity:
 *   { device_pubkey, github_user_id, github_login, log_core_key, sig }
 *
 * The log core key comes from the boot's own log; the rest of the identity is
 * resolved here:
 *   - github_user_id / github_login — the locally-authenticated GitHub user
 *     (gh CLI token → `GET /user`), the channel-1/channel-2 inputs the remote
 *     peer needs to verify our binding. Resolved FIRST, because the device
 *     keychain id is keyed by this user id (see below).
 *   - keychainId / device_pubkey — the device Ed25519 keypair, loaded (or
 *     generated, idempotent) from the OS keychain under the CANONICAL per-user
 *     keychain id `<github_user_id>:<machine-fingerprint>` (built by the shared
 *     `resolveDeviceKeychainId`). This is the SAME id the join path's
 *     binding/contributor-file publish signs under — so the announced
 *     `device_pubkey` matches the key the published contributor file was
 *     signed with, and the remote peer's read-admission channel-2 verify
 *     (`verifyContributorFileSignature`) passes. Using a DIFFERENT id here
 *     (e.g. a fixed `'papercusp-device'`) would advertise a key the remote's
 *     contributor file was NOT signed with, failing every channel-2 check so
 *     no log is ever admitted. The pubkey is the SAME raw-32-byte base64 the
 *     two-channel binding uses.
 *
 * Throws when the identity can't be resolved (no gh auth / keychain failure).
 * boot.ts's swarm-join catch treats that as "stay local-only" — a peer that
 * can't announce simply doesn't federate, which is correct.
 */

import { loadOrGenerateDeviceKeypair, ensureAttestationGist } from '../../identity/attest';
import { getAuthenticatedGithubUser } from '../../identity/resolve-local-github-identity';
import { resolveDeviceKeychainId } from '../../identity/device-keychain-id';
import { getGhAuthToken } from '../../identity/gh-token';

export interface LocalAnnounceIdentity {
  keychainId: string;
  /** Raw 32-byte Ed25519 device pubkey, base64 (== binding device_pubkey). */
  devicePubkeyBase64: string;
  githubUserId: number;
  githubLogin: string;
  /** This device's attestation gist id — carried on the signed announce so a
   *  remote peer admits via `verifyAttestation` with NO shared-repo read
   *  (write-free join, `non-collaborator-join-fork-pr-2026-06-02`). */
  attestationGistId: string;
}

/** Inputs the gist resolver receives — this peer's resolved device identity. */
export interface ResolveAttestationGistArgs {
  keychainId: string;
  pubkeyBase64: string;
  githubUserId: number;
  githubLogin: string;
}

export interface ResolveLocalAnnounceIdentityOpts {
  /** 64-hex Hypercore key of our writable log (from boot's own log). */
  logCoreKeyHex: string;
  /**
   * Override the keychain id (tests / multi-identity dev). When omitted the
   * canonical `<github_user_id>:<machine-fingerprint>` id is derived from the
   * resolved gh user via `resolveDeviceKeychainId`.
   */
  keychainId?: string;
  /**
   * Resolve the locally-authenticated GitHub user. Defaults to the gh-token
   * Octokit `users.getAuthenticated()`. Injectable for tests.
   */
  resolveGithubUser?: () => Promise<{ id: number; login: string }>;
  /** Override the keypair loader (tests). */
  loadKeypair?: (keychainId: string) => Promise<{ keychainId: string; pubkeyBase64: string }>;
  /**
   * Override the keychain-id builder (tests). Defaults to the canonical
   * `resolveDeviceKeychainId`.
   */
  buildKeychainId?: (githubUserId: number) => string;
  /**
   * Resolve this device's attestation gist id. Defaults to the idempotent
   * find-or-create over the gh-token (`ensureAttestationGist`). Injectable for
   * tests (and for any path that already holds the gist id).
   */
  resolveAttestationGistId?: (args: ResolveAttestationGistArgs) => Promise<string>;
}

async function defaultResolveGithubUser(): Promise<{ id: number; login: string }> {
  const user = await getAuthenticatedGithubUser();
  if (!user) {
    throw new Error('local-announce-identity: gh not authenticated (run `gh auth login`)');
  }
  return user;
}

async function defaultResolveAttestationGistId(
  args: ResolveAttestationGistArgs,
): Promise<string> {
  const tok = await getGhAuthToken();
  if (tok.kind !== 'ok') {
    throw new Error('local-announce-identity: gh token required to resolve attestation gist');
  }
  return ensureAttestationGist({
    keychainId: args.keychainId,
    pubkeyBase64: args.pubkeyBase64,
    deviceLabel: `papercusp-${args.githubLogin}`,
    githubUserId: args.githubUserId,
    githubLogin: args.githubLogin,
    token: tok.token,
  });
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
  const loadKeypair = opts.loadKeypair ?? loadOrGenerateDeviceKeypair;
  const resolveUser = opts.resolveGithubUser ?? defaultResolveGithubUser;
  const buildKeychainId = opts.buildKeychainId ?? resolveDeviceKeychainId;

  // Resolve the gh user FIRST — the canonical device keychain id is keyed by
  // the user's id (`<github_user_id>:<machine-fingerprint>`), the SAME id the
  // join path signs the contributor file under. An explicit `keychainId`
  // override wins (tests / multi-identity dev).
  const user = await resolveUser();
  const keychainId = opts.keychainId ?? buildKeychainId(user.id);
  const keypair = await loadKeypair(keychainId);
  const resolveGist = opts.resolveAttestationGistId ?? defaultResolveAttestationGistId;
  const attestationGistId = await resolveGist({
    keychainId,
    pubkeyBase64: keypair.pubkeyBase64,
    githubUserId: user.id,
    githubLogin: user.login,
  });

  return {
    keychainId,
    devicePubkeyBase64: keypair.pubkeyBase64,
    githubUserId: user.id,
    githubLogin: user.login,
    attestationGistId,
  };
}

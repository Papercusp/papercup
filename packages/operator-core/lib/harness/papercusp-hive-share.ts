/**
 * papercusp-hive-share — Solution C orchestration: announce the dogfood `papercusp`
 * hive as a SHARED P2P hive under a PER-OWNER identity, gated by
 * DOGFOOD_PAPERCUSP_HIVE_SHARE (default ON, still reversible by flag).
 *
 * Two hook points around the hive create in bootstrap-papercusp-hive:
 *
 *   adoptSharedHiveIdentity()  — BEFORE the hive is created. If the owner already
 *     has a hive-identity gist (a prior device of theirs created it), inject that
 *     keypair into the keychain so `ensurePapercuspHive` creates the hive under the
 *     OWNER's identity (same pubkey ⇒ same federation topic) instead of minting a
 *     fresh per-device one. Returns the state threaded to goSharedHive, or null to
 *     skip sharing this boot (flag off / no gh / not resolvable).
 *
 *   goSharedHive(state)        — AFTER the hive is created + homed. The FIRST device
 *     (no gist yet) publishes its just-minted keypair + a fresh invite secret to a
 *     per-owner PRIVATE gist; then BOTH paths announce the hive on the INVITE topic
 *     (go-live on the federation topic, no public/Cupboard leak) and set an
 *     owner-signed ALLOWLIST policy naming ONLY the owner's GitHub login — so the
 *     owner's own devices auto-merge and strangers on the topic are refused.
 *
 * Everything is BEST-EFFORT + never throws: a failure (no network, missing `gist`
 * scope, …) just skips/retries on the next boot. The shared identity's PRIVATE key
 * never leaves the owner's private gist — it is NOT baked into the binary (the
 * Solution-C security property).
 *
 * All collaborators are injectable seams for hermetic unit tests.
 */

import { randomBytes } from 'node:crypto';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { keychainStore, keychainLoad } from '../identity/keychain';
import { hiveKeychainId, HIVE_KEYPAIR_SERVICE, loadHiveKeyStatus, type HiveKeyStatus } from '../identity/hive-keypair';
import { pubkeyBase64FromDer } from '../identity/ed25519';
import { setHiveListing } from '../hive-set-listing';
import { authorHivePolicy } from '../hive-policy-author';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';
import { PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import {
  fetchOwnerHiveIdentity,
  publishOwnerHiveIdentity,
  type OwnerHiveIdentity,
} from './papercusp-shared-identity-gist';
import { bakedCanonicalHiveInvite } from './papercusp-hive-join';
import { CANONICAL_HIVE_TEAM_ALLOWLIST } from './canonical-hive-invite';

/** State threaded from the BEFORE hook (adopt) to the AFTER hook (goShared). */
export interface SharedHiveState {
  /** The owner's GitHub login — the sole allowlist entry (auto-admit my devices). */
  githubLogin: string;
  /** The owner's gh token — used to publish the identity gist on the first device. */
  token: string;
  /** The identity fetched from the gist; null ⇒ THIS device is the first/creator. */
  existing: OwnerHiveIdentity | null;
}

export interface HiveShareDeps {
  isEnabled?: () => Promise<boolean>;
  resolveGithub?: typeof resolveLocalGithubIdentity;
  fetchIdentity?: typeof fetchOwnerHiveIdentity;
  publishIdentity?: typeof publishOwnerHiveIdentity;
  storeKey?: (keychainId: string, value: Buffer, service: string) => Promise<unknown>;
  loadKey?: (keychainId: string, service: string) => Promise<{ kind: 'ok'; value: Buffer } | { kind: 'error' }>;
  setListing?: typeof setHiveListing;
  authorPolicy?: typeof authorHivePolicy;
  randomSecret?: () => string;
  /** The canonical invite secret baked into the public build (so every one of the
   *  owner's devices announces on the SAME invite topic that fresh installs listen on
   *  — WI-867 cause (a)). Default: bakedCanonicalHiveInvite()?.inviteSecret ?? null. */
  canonicalSecret?: () => string | null;
  /** Derive the raw-32 pubkey (base64) from the private DER. Default: pubkeyBase64FromDer. */
  derivePubkey?: (der: Buffer) => string;
  /** This hive's actual local key status — 'not_found' on a non-owner box (no
   *  competing local identity, safe to proceed), 'ok' with the pubkey to compare
   *  against the gist on the owner box, or 'error' when a key IS present but
   *  couldn't be read/decrypted (must NOT be treated as 'not_found' — WI-762: a
   *  read/decrypt failure is not proof of "no competing identity", so the guard
   *  fails closed on 'error' instead of silently proceeding). Default: loadHiveKeyStatus. */
  loadPubkey?: (workspaceId: string, slug: string) => Promise<HiveKeyStatus>;
  /** Extra GitHub logins admitted beyond the owner — the team allowlist that makes the
   *  dogfood a real SHARED hive (P-007). Default: CANONICAL_HIVE_TEAM_ALLOWLIST. */
  teamAllowlist?: readonly string[];
  /** P-019 — the hive's membership admission mode. Default 'allowlist' (the canonical dogfood
   *  hive is a PRIVATE team hive — D-001). A PUBLIC project hive passes 'open' so anyone may join
   *  + contribute without being a collaborator; 'approval' queues join requests for the owner. */
  membershipMode?: 'open' | 'approval' | 'allowlist';
  /** P-018 / D-012 — federated content write authority. Default: author-scoped for an `open` hive
   *  (so a stranger-member can't delete others' plans), else 'member' (trusted-hive behavior). */
  contentWriteAuthority?: 'member' | 'author-scoped';
}

async function defaultIsEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.DOGFOOD_PAPERCUSP_HIVE_SHARE, 'system');
  } catch {
    return false;
  }
}

/**
 * BEFORE the hive is created: adopt the owner's existing shared identity if present.
 * Returns the state for goSharedHive, or null when sharing is skipped this boot.
 */
export async function adoptSharedHiveIdentity(deps: HiveShareDeps = {}): Promise<SharedHiveState | null> {
  const isEnabled = deps.isEnabled ?? defaultIsEnabled;
  if (!(await isEnabled())) return null;

  const resolveGithub = deps.resolveGithub ?? resolveLocalGithubIdentity;
  const fetchIdentity = deps.fetchIdentity ?? fetchOwnerHiveIdentity;
  const storeKey =
    deps.storeKey ?? ((id, value, service) => keychainStore(id, value, service));

  try {
    const id = await resolveGithub();
    if (id.kind !== 'ok') return null; // no gh yet → can't share; retry next boot
    const existing = await fetchIdentity(id.token);
    if (existing) {
      // Adopt the owner's hive identity BEFORE the hive is created, so
      // ensurePapercuspHive → loadOrGenerateHiveKeypair LOADS it (same pubkey ⇒ same
      // federation topic) instead of minting a conflicting per-device identity.
      await storeKey(
        hiveKeychainId(PAPERCUSP_WORKSPACE_ID, PAPERCUSP_HIVE_SLUG),
        Buffer.from(existing.privateKeyDer, 'base64'),
        HIVE_KEYPAIR_SERVICE,
      );
    }
    return { githubLogin: id.githubLogin, token: id.token, existing };
  } catch {
    return null; // best-effort
  }
}

/**
 * AFTER the hive is created + homed: publish the identity gist (first device only),
 * then announce (invite) + set the owner-only allowlist policy. No-op when `state`
 * is null. Best-effort; never throws.
 */
export async function goSharedHive(state: SharedHiveState | null, deps: HiveShareDeps = {}): Promise<void> {
  if (!state) return;

  const publishIdentity = deps.publishIdentity ?? publishOwnerHiveIdentity;
  const loadKey = deps.loadKey ?? ((id, service) => keychainLoad(id, service));
  const setListing = deps.setListing ?? setHiveListing;
  const authorPolicy = deps.authorPolicy ?? authorHivePolicy;
  const randomSecret = deps.randomSecret ?? (() => randomBytes(32).toString('hex'));
  const canonicalSecret = deps.canonicalSecret ?? (() => bakedCanonicalHiveInvite()?.inviteSecret ?? null);
  const derivePubkey = deps.derivePubkey ?? pubkeyBase64FromDer;

  try {
    // The baked canonical secret is AUTHORITATIVE for the public release: every owner
    // device must announce on the SAME invite topic that fresh installs listen on. It
    // wins over a (possibly drifted) gist secret; only dev builds with no baked invite
    // fall back to the gist secret / a fresh random one.
    const bakedSecret = canonicalSecret();
    let inviteSecret = bakedSecret ?? state.existing?.inviteSecret;

    if (!state.existing) {
      // First device: read the just-minted hive keypair and publish it (+ the canonical
      // invite secret, or a fresh random one for dev builds) to the per-owner private
      // gist, so the owner's NEXT device adopts the same identity.
      const loaded = await loadKey(hiveKeychainId(PAPERCUSP_WORKSPACE_ID, PAPERCUSP_HIVE_SLUG), HIVE_KEYPAIR_SERVICE);
      if (loaded.kind !== 'ok') return; // can't read our own key — skip, retry next boot
      inviteSecret = bakedSecret ?? randomSecret();
      await publishIdentity(state.token, {
        version: 1,
        privateKeyDer: Buffer.from(loaded.value).toString('base64'),
        pubkeyBase64: derivePubkey(loaded.value),
        inviteSecret,
      });
    }
    if (!inviteSecret) return;

    // Go-live on the INVITE topic (not `public` — no global directory / Cupboard
    // leak of the private dogfood repo). This also triggers the harness to JOIN the
    // federation topic (derived from the shared pubkey) so the owner's devices find
    // each other.
    await setListing(
      {
        hiveId: PAPERCUSP_HIVE_SLUG,
        title: 'Papercusp',
        description: 'Papercusp building itself — shared dogfood hive.',
        visibility: 'invite',
        inviteSecret,
      },
      PAPERCUSP_WORKSPACE_ID,
    );

    // Allowlist admission. Default policy is `open` (admit ANY peer on the topic),
    // which would let a stranger merge — so this allowlist is the ESSENTIAL gate:
    // admit the owner's own GitHub login PLUS each allowlisted teammate (P-007 — what
    // makes the dogfood a real SHARED hive while repos stay private), all authenticated
    // via the device-attestation binding (not spoofable); refuse everyone else.
    const teamAllowlist = deps.teamAllowlist ?? CANONICAL_HIVE_TEAM_ALLOWLIST;
    const membershipMode = deps.membershipMode ?? 'allowlist';
    // P-019: an `open` PUBLIC hive admits anyone (no allowlist gate) and DEFAULTS to author-scoped
    // content writes (P-018/D-012) so a stranger-member can't overwrite/delete others' plans. A
    // private allowlist/approval hive keeps the owner+team gate and 'member' writes (today).
    const contentWriteAuthority =
      deps.contentWriteAuthority ?? (membershipMode === 'open' ? 'author-scoped' : 'member');
    await authorPolicy({
      workspaceId: PAPERCUSP_WORKSPACE_ID,
      hiveHomeSlug: PAPERCUSP_HIVE_SLUG,
      policy: {
        membership: membershipMode,
        // The allowlist is only consulted under 'allowlist' mode, but we always carry the owner+team
        // set so flipping modes later doesn't lose it; it is inert under 'open'/'approval'.
        allowlist: Array.from(new Set([state.githubLogin, ...teamAllowlist])),
        ...(contentWriteAuthority === 'author-scoped' ? { contentWriteAuthority } : {}),
        // P-013 (cross-machine-coord-parity-and-trust-2026-07-01): the per-owner
        // dogfood hive is the SAME human's devices — full comms parity by default
        // (steer). Without this, the conservative fallback ('message') would
        // suppress cross-machine wakes between the owner's own machines.
        comms: { defaultTier: 'steer' },
      },
    });
  } catch {
    // best-effort — a failed announce / policy author retries on the next boot.
  }
}

/**
 * Enable sharing on an ALREADY-PRESENT hive — the "go shared on a hive that was
 * created before the flag was on" path (and every subsequent boot). Unlike the
 * create path it does NOT inject a key (the hive's identity is already fixed); it
 * resolves the owner, then publishes (first device) / announces / sets the policy.
 *
 * Guard: if a gist already holds an identity whose pubkey does NOT match THIS hive's
 * actual pubkey, the local hive was created independently and can't retroactively
 * adopt the shared identity — SKIP (announcing a mismatched identity would put this
 * device on a different topic). To converge, that device must be re-created with the
 * flag on so the create path adopts the gist first. This guard is meaningful ONLY on
 * the owner box (only it ever holds the hive's private key to compare); a non-owner
 * member device legitimately has no local key at all (`loadHiveKeyStatus` returns
 * `not_found`) and always proceeds — there is no competing identity for it to check.
 * A genuine key-read/decrypt ERROR is distinct from "no key" and fails closed (WI-762)
 * rather than being silently treated as the safe not_found case.
 *
 * Idempotent + best-effort + flag-gated; a no-op when the flag is off.
 */
export async function shareExistingHive(deps: HiveShareDeps = {}): Promise<void> {
  const isEnabled = deps.isEnabled ?? defaultIsEnabled;
  if (!(await isEnabled())) return;

  const resolveGithub = deps.resolveGithub ?? resolveLocalGithubIdentity;
  const fetchIdentity = deps.fetchIdentity ?? fetchOwnerHiveIdentity;
  const loadPubkey = deps.loadPubkey ?? loadHiveKeyStatus;

  try {
    const id = await resolveGithub();
    if (id.kind !== 'ok') return;
    const existing = await fetchIdentity(id.token);
    if (existing) {
      const status = await loadPubkey(PAPERCUSP_WORKSPACE_ID, PAPERCUSP_HIVE_SLUG);
      // WI-762: the original guard was `if (localPubkey && localPubkey !== existing.pubkeyBase64) return`
      // — a plain `string | null` collapses "no local key held" (a normal non-owner
      // device; nothing to compare, safe to proceed) and "a local key IS held but
      // failed to load/decrypt" (a real error) into the same falsy `null`, so a
      // read/decrypt failure fell through the `localPubkey &&` short-circuit and
      // silently proceeded to adopt an UNVERIFIED gist identity. Handle the three
      // cases explicitly:
      if (status.kind === 'error') return; // can't verify — fail closed, don't adopt an unverified identity
      if (status.kind === 'ok' && status.pubkeyBase64 !== existing.pubkeyBase64) return; // mismatched local identity — skip
      // status.kind === 'not_found': no local identity to compare (the expected,
      // legitimate state for every non-owner member device) — proceed.
    }
    await goSharedHive({ githubLogin: id.githubLogin, token: id.token, existing }, deps);
  } catch {
    // best-effort
  }
}

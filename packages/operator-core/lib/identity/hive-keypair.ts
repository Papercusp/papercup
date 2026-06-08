/**
 * hive-keypair — the per-HIVE Ed25519 identity keypair
 * (shared-hive-federation-2026-06-08 P-002; D-002 keypair identity, D-008
 * multiple-Hives-per-workspace).
 *
 * A Hive's IDENTITY is a stable Ed25519 keypair, mirroring the per-device
 * identity (attest.ts) but scoped per-hive-entity: keyed by (workspaceId, hive
 * slug). The owner ruled a workspace hosts MULTIPLE Hives (D-008), so the key
 * is per-hive, NOT per-workspace.
 *
 * The PUBLIC key (raw 32-byte, base64) is the Hive's externally-addressable id:
 *   - it becomes the federation topic key (P-003 — deriveHiveFederationTopic),
 *     replacing the shared-harness slug; and
 *   - when cross-Hive lands (D-002, deferred) it is the hyperdht dial address.
 * The PRIVATE key lives in the keychain on the Hive's OWNING Swarm and never
 * leaves the identity layer — other Swarms / contributors only ever hold the
 * pubkey (distributed via the Hive entity / registry, never the secret).
 *
 * This reuses the device-key machinery wholesale (keychain.ts 3-tier persist +
 * ed25519.ts byte-compatible crypto). The ONLY differences from a device key
 * are the keychain SERVICE namespace and the per-hive keychainId.
 */

import { keychainStore, keychainLoad } from './keychain';
import {
  generateEd25519KeypairDer,
  pubkeyBase64FromDer,
  signWithPrivateKeyDer,
} from './ed25519';

/** OS-keychain service namespace for hive identity keys (distinct from the
 *  device key's `papercusp-device-keypair`). */
export const HIVE_KEYPAIR_SERVICE = 'papercusp-hive-keypair';

export interface HiveKeypairId {
  /** The keychainId the private key is stored under. */
  keychainId: string;
  /** Raw 32-byte Ed25519 public key, base64 — the Hive's addressable identity. */
  pubkeyBase64: string;
}

/**
 * Deterministic keychainId for a hive's identity key. A workspace hosts
 * multiple Hives (D-008), so the key is scoped by (workspaceId, slug). Slugs
 * are stable per workspace, so this id is stable for the hive's lifetime — the
 * keypair therefore survives restarts (the keychain persists; this id is the
 * lookup).
 */
export function hiveKeychainId(workspaceId: string, slug: string): string {
  if (!workspaceId) throw new Error('hiveKeychainId: workspaceId required');
  if (!slug) throw new Error('hiveKeychainId: slug required');
  return `hive:${workspaceId}:${slug}`;
}

/**
 * Load the existing hive keypair, or generate + persist one on first call.
 * Idempotent: repeated calls for the same hive always return the same pubkey.
 * The private key never leaves the keychain — callers receive only the pubkey.
 *
 * Call this on the Hive's OWNING Swarm (the one that created the hive). A peer
 * Swarm that only holds the pubkey must NOT call this — it would mint a second,
 * conflicting identity. Peers read the pubkey off the Hive entity instead.
 */
export async function loadOrGenerateHiveKeypair(
  workspaceId: string,
  slug: string,
): Promise<HiveKeypairId> {
  const keychainId = hiveKeychainId(workspaceId, slug);
  const loaded = await keychainLoad(keychainId, HIVE_KEYPAIR_SERVICE);
  if (loaded.kind === 'ok') {
    return { keychainId, pubkeyBase64: pubkeyBase64FromDer(loaded.value) };
  }
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  await keychainStore(keychainId, privateKeyDer, HIVE_KEYPAIR_SERVICE);
  return { keychainId, pubkeyBase64 };
}

/**
 * Load the hive's pubkey WITHOUT generating one if absent. Returns null when
 * this Swarm does not hold the hive's private key (e.g. a hive owned by a
 * different Swarm). Use loadOrGenerateHiveKeypair on the owning Swarm to mint
 * it; use the pubkey off the Hive entity for a peer-held hive.
 */
export async function loadHivePubkey(
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  const loaded = await keychainLoad(hiveKeychainId(workspaceId, slug), HIVE_KEYPAIR_SERVICE);
  return loaded.kind === 'ok' ? pubkeyBase64FromDer(loaded.value) : null;
}

/**
 * Sign `bytes` with the hive's Ed25519 private key. Throws if this Swarm does
 * not hold the hive's private key (only the owning Swarm does). Returns the raw
 * 64-byte signature Buffer — callers base64-encode for the wire.
 *
 * This is the hive-level signing seam (vs signWithDeviceKey): a signature that
 * binds to the HIVE identity rather than a device identity — e.g. a hive-level
 * directory announce or federation envelope — rides through here.
 */
export async function signWithHiveKey(
  workspaceId: string,
  slug: string,
  bytes: Buffer,
): Promise<Buffer> {
  const keychainId = hiveKeychainId(workspaceId, slug);
  const loaded = await keychainLoad(keychainId, HIVE_KEYPAIR_SERVICE);
  if (loaded.kind !== 'ok') {
    throw new Error('signWithHiveKey: hive private key not held by this Swarm for ' + keychainId);
  }
  return signWithPrivateKeyDer(loaded.value, bytes);
}

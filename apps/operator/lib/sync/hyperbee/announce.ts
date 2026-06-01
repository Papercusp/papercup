/**
 * announce — the signed peer-announce wire-format (Model B substrate, Stage 3).
 *
 * Per-peer Hypercore logs replicate over the swarm. On connect, peers exchange
 * a signed announce that binds a peer's log core to its device identity:
 *
 *   { device_pubkey, github_user_id, github_login, log_core_key, sig }
 *
 *   - device_pubkey — the RAW 32-byte Ed25519 device public key, base64. This
 *     is the SAME string as the binding's `device_pubkey`
 *     (attest.ts / two-channel-verifier.ts), so a verified announce identifies
 *     a device whose binding the read-admission decision can then check.
 *   - log_core_key — the 64-hex Hypercore key of the peer's writable log
 *     (distinct from device_pubkey; one is identity, one is the core to read).
 *   - sig — base64 Ed25519 signature over the canonical body (excluding `sig`).
 *
 * Crypto contract (Stage-0 spike, run-verified): Node-crypto Ed25519,
 * `sign(null, …)` / `verify(null, …)` (algorithm MUST be null for Ed25519),
 * with the raw-32-byte-base64 pubkey → SPKI-DER rebuild via the fixed 12-byte
 * Ed25519 prefix `302a300506032b6570032100`. This mirrors attest.ts's private
 * `verifyEd25519Signature` + `buildSpkiDerFromRawPubkey` and
 * two-channel-verifier.ts's `verifyContributorFileSignature` exactly, so the
 * announce sig is byte-compatible with the binding's signatures.
 *
 * attest.ts does not export those helpers (they're private and bound to the
 * AttestationGistBody schema), so the primitive is reimplemented here against
 * the announce body. The signer is INJECTED — tests pass a generated keypair;
 * production passes `bytes => signWithDeviceKey(keychainId, bytes)`.
 *
 * Canonicalization: the body is all primitives (no nested objects), so a fixed
 * field-ordered `JSON.stringify` is equivalent to JCS (RFC 8785) for this
 * schema. Field order: device_pubkey, github_user_id, github_login, log_core_key.
 */

import { verify as nodeVerify, createPublicKey } from 'node:crypto';

/** The signed-over fields of an announce (everything except `sig`). */
export interface AnnounceBody {
  /** Raw 32-byte Ed25519 device public key, base64 (== binding device_pubkey). */
  device_pubkey: string;
  github_user_id: number;
  github_login: string;
  /** 64-hex Hypercore key of the peer's writable log. */
  log_core_key: string;
}

/** A full announce frame as sent on the wire. */
export interface SignedAnnounce extends AnnounceBody {
  /** Base64 Ed25519 signature over `announceSigningBytes(body)`. */
  sig: string;
}

/** Fixed 12-byte Ed25519 SPKI DER prefix (matches attest.ts / two-channel-verifier.ts). */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Canonical signing bytes for an announce: field-ordered JSON of the body
 * EXCLUDING `sig`. All values are primitives so this equals JCS for the schema.
 */
export function announceSigningBytes(body: AnnounceBody): Buffer {
  const ordered = {
    device_pubkey: body.device_pubkey,
    github_user_id: body.github_user_id,
    github_login: body.github_login,
    log_core_key: body.log_core_key,
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/**
 * Build a signed announce. The signer is injected so tests can use a generated
 * keypair and production passes `bytes => signWithDeviceKey(keychainId, bytes)`.
 * The signer returns the raw 64-byte Ed25519 signature; it's base64-encoded here.
 */
export async function buildAnnounce(
  body: AnnounceBody,
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<SignedAnnounce> {
  const sig = (await sign(announceSigningBytes(body))).toString('base64');
  return { ...body, sig };
}

/**
 * Verify an announce frame's `sig` against its `device_pubkey` (raw-32-byte
 * base64 → SPKI rebuild → nodeVerify) over `announceSigningBytes(frame)`.
 * Returns false on any tamper, bad shape, or malformed input — never throws.
 */
export function verifyAnnounce(frame: SignedAnnounce): boolean {
  try {
    if (!frame || typeof frame !== 'object') return false;
    if (
      typeof frame.device_pubkey !== 'string' ||
      typeof frame.github_user_id !== 'number' ||
      typeof frame.github_login !== 'string' ||
      typeof frame.log_core_key !== 'string' ||
      typeof frame.sig !== 'string'
    ) {
      return false;
    }

    const rawPubkey = Buffer.from(frame.device_pubkey, 'base64');
    if (rawPubkey.length !== 32) return false;

    const spkiDer = Buffer.concat([SPKI_PREFIX, rawPubkey]);
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    const bytes = announceSigningBytes(frame);
    const sig = Buffer.from(frame.sig, 'base64');
    return nodeVerify(null, bytes, publicKey, sig);
  } catch {
    return false;
  }
}

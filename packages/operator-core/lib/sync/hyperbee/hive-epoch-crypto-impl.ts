/**
 * hive-epoch-crypto-impl — the v1 CRYPTO FOUNDATION behind the `HiveEpochCrypto`
 * seam (shared-hive-release-testing Brief RE-KEY / C-001 / E-001 / Move 2).
 * su-ed300's half; K (su-313d1) owns the boundary/distribution/serving consumer.
 *
 * OWNER-GREENLIT (Avi, 2026-06-19): member-remove / go-private MUST cut a removed
 * peer's READ access to post-boundary content. The load-bearing cut is CRYPTO:
 * content is encrypted under a per-epoch key, and on a boundary the epoch advances
 * and the new key is wrapped to the REMAINING members only.
 *
 * v1 scheme (MLS/TreeKEM-able later behind the SAME interface — RFC 9420 forward
 * secrecy / post-compromise security is a v2 upgrade, not a start-gate):
 *   - Per-epoch FRESH-RANDOM 32-byte symmetric content key. Fresh-random — NOT a
 *     KDF from a shared root — is precisely what gives the read CUT-OFF: a removed
 *     member cannot compute a key it was never wrapped (a KDF-from-root would let a
 *     prior root-holder derive every future epoch → no cut-off).
 *   - `deriveEpochKey` = get-or-create, persisted in the device keychain. This is
 *     the EPOCH-ADVANCER's seam (the actor performing the boundary mints the new
 *     epoch's key); idempotent get afterward. Members never mint — they
 *     `unwrapEpochKey` the blob K distributed (read AND write both unwrap).
 *   - `wrapKeyToMember` = libsodium sealed box to the member's device key
 *     (Ed25519 → X25519). `unwrapEpochKey` = the inverse with the local device key.
 *     A removed member is simply never wrapped to → its `seal_open` fails.
 *   - `encryptOp`/`decryptOp` = XChaCha20-Poly1305 AEAD; the (hive, epoch, opId)
 *     OpAAD is bound as associated data so a ciphertext can't be replayed under a
 *     different row/epoch.
 *
 * SERVER-SIDE ONLY (native `sodium-native` + the keychain). `sodium-native` is
 * LAZY-imported so importing THIS module is inert in the operator-vite SPA bundle
 * (a top-level native import would crash the browser, per keychain.ts's note).
 */
import type { HiveEpochCrypto, EpochKey, OpAAD } from './hive-epoch-crypto';
import { keychainLoad, keychainStore } from '../../identity/keychain';
import { privateKeyFromDer } from '../../identity/ed25519';

/** Keychain service namespace for the per-(hive,epoch) symmetric content keys —
 *  distinct from the device/hive identity-key services so they never collide. */
const EPOCH_KEY_SERVICE = 'papercusp-hive-epoch-key';
/** XChaCha20-Poly1305 key length (== crypto_aead_xchacha20poly1305_ietf_KEYBYTES). */
const EPOCH_KEY_BYTES = 32;

// Lazy native load — import-safe in the SPA bundle; resolved on first real call.
type Sodium = typeof import('sodium-native');
let _sodiumP: Promise<Sodium> | null = null;
function sodium(): Promise<Sodium> {
  return (_sodiumP ??= import('sodium-native').then(
    (m) => ((m as unknown as { default?: Sodium }).default ?? (m as unknown as Sodium)),
  ));
}

function epochKeyId(potId: string, epoch: number): string {
  return `${potId}:${epoch}`;
}

function asEpochKey(b: Uint8Array): EpochKey {
  return b as EpochKey;
}

/**
 * Canonical associated-data bytes — LENGTH-PREFIXED so the (potId, epoch, opId)
 * fields can't be re-split into a different but equal concatenation (e.g.
 * potId="a",opId="b" vs potId="a",opId... — a delimiter could be forged; a
 * 4-byte length prefix per field is unambiguous).
 */
function encodeAAD(ad: OpAAD): Buffer {
  const parts = [
    Buffer.from(ad.potId, 'utf8'),
    Buffer.from(String(ad.epoch), 'utf8'),
    Buffer.from(ad.opId, 'utf8'),
  ];
  const out: Buffer[] = [];
  for (const p of parts) {
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(p.length);
    out.push(len, p);
  }
  return Buffer.concat(out);
}

/** Raw 32-byte Ed25519 seed + pubkey from a PKCS8-DER device private key (via JWK). */
function rawEd25519SeedFromDer(der: Buffer): Buffer {
  const jwk = privateKeyFromDer(der).export({ format: 'jwk' }) as { crv?: string; d?: string };
  if (jwk.crv !== 'Ed25519' || !jwk.d) {
    throw new Error('device key is not an Ed25519 private key (no JWK d / wrong crv)');
  }
  const seed = Buffer.from(jwk.d, 'base64url');
  if (seed.length !== 32) throw new Error(`Ed25519 seed wrong size: ${seed.length}`);
  return seed;
}

export interface HiveEpochCryptoOpts {
  /** Override the keychain service for the DEVICE key lookup in unwrapEpochKey.
   *  Default = the keychain's device service (papercusp-device-keypair). */
  deviceServiceName?: string;
}

/**
 * Build the v1 HiveEpochCrypto. Pure construction (no I/O, no native load) — the
 * native module + keychain are touched only when a method actually runs.
 */
export function createHiveEpochCrypto(opts: HiveEpochCryptoOpts = {}): HiveEpochCrypto {
  return {
    async deriveEpochKey(potId: string, epoch: number): Promise<EpochKey> {
      const id = epochKeyId(potId, epoch);
      const loaded = await keychainLoad(id, EPOCH_KEY_SERVICE);
      if (loaded.kind === 'ok') {
        if (loaded.value.length !== EPOCH_KEY_BYTES) {
          throw new Error(`stored epoch key for ${id} is ${loaded.value.length}B, expected ${EPOCH_KEY_BYTES}`);
        }
        return asEpochKey(Uint8Array.from(loaded.value));
      }
      // Mint a fresh random key for this epoch (the epoch-advancer path) + persist.
      const s = await sodium();
      const key = Buffer.allocUnsafe(EPOCH_KEY_BYTES);
      s.randombytes_buf(key);
      await keychainStore(id, key, EPOCH_KEY_SERVICE);
      return asEpochKey(Uint8Array.from(key));
    },

    async wrapKeyToMember(key: EpochKey, memberDevicePubkeyBase64: string): Promise<Uint8Array> {
      const s = await sodium();
      const edPub = Buffer.from(memberDevicePubkeyBase64, 'base64');
      if (edPub.length !== 32) {
        throw new Error(`member device pubkey must be 32-byte Ed25519, got ${edPub.length}`);
      }
      const xPub = Buffer.allocUnsafe(s.crypto_box_PUBLICKEYBYTES);
      s.crypto_sign_ed25519_pk_to_curve25519(xPub, edPub);
      const msg = Buffer.from(key);
      const sealed = Buffer.allocUnsafe(msg.length + s.crypto_box_SEALBYTES);
      s.crypto_box_seal(sealed, msg, xPub);
      return Uint8Array.from(sealed);
    },

    async unwrapEpochKey(blob: Uint8Array, ownDeviceKeychainId: string): Promise<EpochKey> {
      const s = await sodium();
      const loaded = await keychainLoad(ownDeviceKeychainId, opts.deviceServiceName);
      if (loaded.kind !== 'ok') {
        const why = loaded.error.kind;
        throw new Error(`unwrapEpochKey: device key not found for keychainId (${why})`);
      }
      const seed = rawEd25519SeedFromDer(loaded.value);
      // Rebuild the 64-byte libsodium ed25519 secret key from the seed, then → x25519.
      const edPk = Buffer.allocUnsafe(s.crypto_sign_PUBLICKEYBYTES);
      const edSk = Buffer.allocUnsafe(s.crypto_sign_SECRETKEYBYTES);
      s.crypto_sign_seed_keypair(edPk, edSk, seed);
      const xPub = Buffer.allocUnsafe(s.crypto_box_PUBLICKEYBYTES);
      const xSec = Buffer.allocUnsafe(s.crypto_box_SECRETKEYBYTES);
      s.crypto_sign_ed25519_pk_to_curve25519(xPub, edPk);
      s.crypto_sign_ed25519_sk_to_curve25519(xSec, edSk);
      const ct = Buffer.from(blob);
      if (ct.length < s.crypto_box_SEALBYTES) throw new Error('wrapped key blob too short');
      const out = Buffer.allocUnsafe(ct.length - s.crypto_box_SEALBYTES);
      const ok = s.crypto_box_seal_open(out, ct, xPub, xSec);
      if (!ok) {
        // The defining cut-off failure: this device was NOT wrapped to (removed
        // member), or the blob is corrupt. Fail closed.
        throw new Error('unwrapEpochKey: seal_open failed — not wrapped to this device, or corrupt blob');
      }
      if (out.length !== EPOCH_KEY_BYTES) throw new Error(`unwrapped key wrong size: ${out.length}`);
      return asEpochKey(Uint8Array.from(out));
    },

    async encryptOp(payload: Uint8Array, key: EpochKey, ad: OpAAD): Promise<Uint8Array> {
      const s = await sodium();
      if (key.length !== EPOCH_KEY_BYTES) throw new Error(`epoch key must be ${EPOCH_KEY_BYTES} bytes`);
      const nonce = Buffer.allocUnsafe(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
      s.randombytes_buf(nonce);
      const m = Buffer.from(payload);
      const c = Buffer.allocUnsafe(m.length + s.crypto_aead_xchacha20poly1305_ietf_ABYTES);
      s.crypto_aead_xchacha20poly1305_ietf_encrypt(c, m, encodeAAD(ad), null, nonce, Buffer.from(key));
      // Self-framing: [24-byte nonce][ciphertext+tag].
      return Uint8Array.from(Buffer.concat([nonce, c]));
    },

    async decryptOp(ciphertext: Uint8Array, key: EpochKey, ad: OpAAD): Promise<Uint8Array> {
      const s = await sodium();
      if (key.length !== EPOCH_KEY_BYTES) throw new Error(`epoch key must be ${EPOCH_KEY_BYTES} bytes`);
      const NP = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
      const AB = s.crypto_aead_xchacha20poly1305_ietf_ABYTES;
      const buf = Buffer.from(ciphertext);
      if (buf.length < NP + AB) throw new Error('ciphertext too short');
      const nonce = buf.subarray(0, NP);
      const c = buf.subarray(NP);
      const m = Buffer.allocUnsafe(c.length - AB);
      // sodium-native throws on auth failure (wrong key / wrong AAD / tamper) —
      // which is the correct fail-closed behavior the interface requires.
      s.crypto_aead_xchacha20poly1305_ietf_decrypt(m, null, c, encodeAAD(ad), nonce, Buffer.from(key));
      return Uint8Array.from(m);
    },
  };
}

/**
 * Load-ONLY epoch-key read (WI-3297, the multi-epoch seed-bundling seam). Unlike
 * `deriveEpochKey` (get-or-CREATE — a miss MINTS a fresh key), this NEVER writes:
 * a historical-epoch bundling loop that used deriveEpochKey would silently mint
 * keys for epochs that never had one (the WI-1981 divergent-key class) and ship
 * them as if they were real. Returns null on `not_found`; a keychain READ error
 * (io/decryption) throws — a key may exist but be unreadable, and silently
 * skipping it would cut a seed missing a recoverable key (fail closed, matching
 * loadHiveKeyStatus's tri-state discipline).
 */
export async function loadEpochKeyIfPresent(potId: string, epoch: number): Promise<EpochKey | null> {
  const loaded = await keychainLoad(epochKeyId(potId, epoch), EPOCH_KEY_SERVICE);
  if (loaded.kind === 'ok') {
    if (loaded.value.length !== EPOCH_KEY_BYTES) {
      throw new Error(
        `stored epoch key for ${epochKeyId(potId, epoch)} is ${loaded.value.length}B, expected ${EPOCH_KEY_BYTES}`,
      );
    }
    return asEpochKey(Uint8Array.from(loaded.value));
  }
  if (loaded.error.kind === 'not_found') return null;
  throw new Error(
    `keychain read FAILED for epoch key ${epochKeyId(potId, epoch)} (${loaded.error.kind}` +
      `${'reason' in loaded.error ? `: ${loaded.error.reason}` : ''}) — cannot tell absent from unreadable, refusing to skip`,
  );
}

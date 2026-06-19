/**
 * hive-epoch-op-gate — the apply/capture CRYPTO GLUE for the read-plane re-key
 * (shared-hive-rekey-2026-06-19, K's lane / su-ee7e9). Brackets the federated op path
 * with epoch encryption, the two halves the other lanes inject into:
 *
 *   - buildEpochEncryptCapability → the `EpochEncryptCapability` the outbox drain (7dcd8)
 *     injects: encrypt a content op's payload under the CURRENT epoch key + stamp its epoch.
 *   - buildEpochDecryptGate → the apply-side gate (328af's `mergeOpts.applyImpl` stub):
 *     decrypt an epoch-stamped op BEFORE EN-4/EN-2/scopedApply see it (so policy/rate read
 *     PLAINTEXT); DEFER (J's PendingEpochContent) when the key hasn't arrived; the C-001
 *     read cut falls out for free — a removed member's key row never arrives, so its
 *     epoch-N+ content defers forever (bounded), never decrypted.
 *
 * Both halves share ONE epoch-key resolver (owner `deriveEpochKey` | member unwrap via the
 * EpochKeyProvider) + the SAME `deriveOpId` AAD + `hiveId` = the hive HOME slug, so
 * encrypt↔decrypt are symmetric. Pure glue over injected seams (crypto, the key resolver,
 * the current-epoch reader, the pending buffer) — fully unit-testable without PG/boot.
 *
 * Op-selection (WHICH ops get encrypted) is 7dcd8's `shouldEncryptOpForRekey`, applied in
 * the drain BEFORE `encryptOp` is called — this module never sees a control-plane op.
 */
import type { EpochKey, HiveEpochCrypto } from './hive-epoch-crypto';
import type { OpEnvelope } from './op-envelope-types';
import type { LocalWriteOp } from './boot';
import type { EpochEncryptCapability } from './outbox-drain';
import type { PendingEpochContent } from './pending-epoch-content';
import type { EpochKeyProvider } from './hive-epoch-serving';
import { encryptOpPayload, decryptOpPayload } from './hive-epoch-serving';

/** Resolve the epoch key for `(hiveId, epoch)` on THIS peer: owner derives, member
 *  unwraps. Rejects (EpochKeyUnavailableError) on a member whose wrapped row hasn't
 *  arrived — which the decrypt gate turns into a DEFER (the cut, when it never comes). */
export type EpochKeyResolver = (hiveId: string, epoch: number) => Promise<EpochKey>;

/**
 * Build the SHARED owner|member key resolver both halves use. The OWNER (holds the hive
 * private key → `isOwner` true) mints via `crypto.deriveEpochKey`; a MEMBER unwraps its
 * wrapped `hive_epoch_keys` row via the provider (which rejects EpochKeyUnavailableError
 * until the row arrives — never, for a removed member). Owner-ness is fixed per hive, so
 * it's resolved once + cached.
 */
export function buildEpochKeyResolver(deps: {
  crypto: HiveEpochCrypto;
  provider: EpochKeyProvider;
  isOwner: () => Promise<boolean>;
}): EpochKeyResolver {
  let ownerCache: boolean | undefined;
  return async (hiveId, epoch) => {
    if (ownerCache === undefined) ownerCache = await deps.isOwner();
    return ownerCache
      ? deps.crypto.deriveEpochKey(hiveId, epoch)
      : deps.provider.keyForEpoch(hiveId, epoch);
  };
}

/** The json-safe ciphertext envelope carried in an encrypted op's `value`. */
interface RekeyValue {
  __rekey: string; // base64(ciphertext)
}
function isRekeyValue(v: unknown): v is RekeyValue {
  return !!v && typeof v === 'object' && typeof (v as { __rekey?: unknown }).__rekey === 'string';
}
function encodeCiphertext(ct: Uint8Array): RekeyValue {
  return { __rekey: Buffer.from(ct).toString('base64') };
}
function decodeCiphertext(v: unknown): Uint8Array | null {
  return isRekeyValue(v) ? new Uint8Array(Buffer.from(v.__rekey, 'base64')) : null;
}
/** op `value` (arbitrary JSON) ↔ bytes for the AEAD payload. Stable, deterministic. */
function valueToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value ?? null));
}
function bytesToValue(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

export interface EpochOpGateDeps {
  crypto: HiveEpochCrypto;
  /** owner-derive | member-unwrap — the shared resolver (built at boot). */
  resolveKey: EpochKeyResolver;
  /** the hive identity for the AAD + key id (= the hive HOME slug). */
  hiveId: string;
}

/**
 * The `EpochEncryptCapability` the outbox drain injects. The drain already filtered to
 * content ops (`shouldEncryptOpForRekey`) + put ops with a value, so we just encrypt.
 * Throwing EpochKeyUnavailableError here is intentional: the drain treats it like an
 * append failure (halt + retry) so a content op is NEVER federated in the clear.
 */
export function buildEpochEncryptCapability(
  deps: EpochOpGateDeps & { getCurrentEpoch: () => Promise<number> },
): EpochEncryptCapability {
  return {
    async encryptOp(op: LocalWriteOp): Promise<{ epoch: number; value: unknown } | null> {
      const epoch = await deps.getCurrentEpoch();
      const key = await deps.resolveKey(deps.hiveId, epoch);
      // OpIdentity (object) — encryptOpPayload derives the opId internally via buildOpAAD.
      const id = { tableTag: op.table, rowKey: op.hbKey, authorPubkey: op.writerPubkey ?? '' };
      const ct = await encryptOpPayload(deps.crypto, valueToBytes(op.value), { hiveId: deps.hiveId, epoch, id }, key);
      return { epoch, value: encodeCiphertext(ct) };
    },
  };
}

export interface EpochDecryptGateDeps extends EpochOpGateDeps {
  /** J's per-apply-loop deferral buffer (key-before-content ordering). */
  pending: PendingEpochContent;
}

/**
 * The apply-side decrypt gate. `decryptGate(inner)` returns an ApplyFn that handles an
 * epoch-stamped op BEFORE `inner` (EN-4 → EN-2 → scopedApply) sees it:
 *   - epoch absent ⇒ plaintext / control-plane → `inner(op)` unchanged (today's path).
 *   - epoch present, key available ⇒ decrypt → `inner(plaintext op)`.
 *   - epoch present, key NOT local ⇒ DEFER (re-applied when the epoch-key row lands; a
 *     removed member's never lands → defers forever = the C-001 read cut).
 *   - epoch present, key present but decrypt fails (wrong epoch / tampered) ⇒ DROP.
 * Drain (re-applying deferred ops once a `hive_epoch_keys` row applies) is wired at boot
 * via the projection's `onEpochKeyApplied` hook → `pending.drainEpoch` → re-run here.
 */
export function buildEpochDecryptGate(
  deps: EpochDecryptGateDeps,
): (inner: (op: OpEnvelope) => Promise<boolean>) => (op: OpEnvelope) => Promise<boolean> {
  return (inner) =>
    async (op: OpEnvelope): Promise<boolean> => {
      if (op.epoch == null) return inner(op); // plaintext / control-plane
      const ct = decodeCiphertext(op.value);
      if (!ct) return inner(op); // epoch-stamped but not our wrapper — permissive passthrough

      let key: EpochKey;
      try {
        key = await deps.resolveKey(deps.hiveId, op.epoch);
      } catch {
        // key not yet local (remaining member waiting; or removed member forever) → defer.
        deps.pending.defer(op, deps.hiveId, op.epoch);
        return false;
      }

      // OpIdentity must match what encrypt sealed: same (table, hbKey, writerPubkey).
      const id = { tableTag: op.table ?? '', rowKey: op.hbKey ?? '', authorPubkey: op.writerPubkey ?? '' };
      let plaintext: Uint8Array;
      try {
        plaintext = await decryptOpPayload(deps.crypto, ct, { hiveId: deps.hiveId, epoch: op.epoch, id }, key);
      } catch {
        // have a key but can't decrypt (wrong epoch / tampered AAD) → drop = read cut.
        return false;
      }
      // Apply the now-PLAINTEXT op; clear `epoch` so downstream sees a normal op.
      return inner({ ...op, value: bytesToValue(plaintext), epoch: undefined });
    };
}

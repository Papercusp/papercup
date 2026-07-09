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
 * EpochKeyProvider) + the SAME `deriveOpId` AAD + `potId` = the hive HOME slug, so
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
import { BASELINE_EPOCH } from './hive-epoch-state';

/** Resolve the epoch key for `(potId, epoch)` on THIS peer: owner derives, member
 *  unwraps. Rejects (EpochKeyUnavailableError) on a member whose wrapped row hasn't
 *  arrived — which the decrypt gate turns into a DEFER (the cut, when it never comes). */
export type EpochKeyResolver = (potId: string, epoch: number) => Promise<EpochKey>;

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
  // Epoch keys are IMMUTABLE per (hive, epoch) — a re-key advances the epoch NUMBER, it
  // never rotates an existing epoch's key. So a successfully-resolved key can be cached
  // for the resolver's lifetime: this keeps the per-op gate cost O(1) even though the
  // owner path now consults the provider (a PG/bundled lookup) before falling back to
  // deriveEpochKey. Only SUCCESSES are cached — a member miss must keep throwing so the
  // gate DEFERS and retries once the epoch-key row federates in.
  const keyCache = new Map<string, EpochKey>();
  return async (potId, epoch) => {
    const cacheKey = `${potId}:${epoch}`;
    const cached = keyCache.get(cacheKey);
    if (cached) return cached;
    if (ownerCache === undefined) ownerCache = await deps.isOwner();
    let key: EpochKey;
    if (!ownerCache) {
      key = await deps.provider.keyForEpoch(potId, epoch);
    } else {
      // OWNER. Resolve the AUTHORITATIVE distributed key FIRST — the provider chain
      // (federated `hive_epoch_keys` rows / the BUNDLED seed key) — and mint via
      // deriveEpochKey ONLY as the fallback for a genuinely NEW epoch this owner is
      // advancing to. `deriveEpochKey` is get-or-CREATE, correct ONLY for the epoch
      // ADVANCER; calling it to READ an already-existing epoch on a box that never minted
      // it — a fresh SEEDED install that adopts the shared hive identity
      // (DOGFOOD_PAPERCUSP_HIVE_SHARE → isOwner=true) but boots with an EMPTY epoch
      // keychain — MINTS a fresh-random DIVERGENT key that cannot decrypt the seed's
      // existing epoch-ciphertext. That is the WI-1981 epoch-poison class and the seed
      // "57-drop": the seed's epoch-1 content decrypts ONLY under the bundled key, never a
      // freshly-minted one, so a mint-at-read silently drops every encrypted row (the
      // gate's decrypt-fail is `return false`, no throw). Provider-FIRST also makes this
      // ROBUST to a keychain already poisoned by a prior mis-mint: the authoritative
      // bundled/federated key wins over a stale local `deriveEpochKey` residue. On a real
      // owner/advancer box (no bundled seed, no self-wrapped row) the provider simply
      // misses and we fall through to deriveEpochKey — its own minted key — unchanged.
      try {
        key = await deps.provider.keyForEpoch(potId, epoch);
      } catch {
        key = await deps.crypto.deriveEpochKey(potId, epoch);
      }
    }
    keyCache.set(cacheKey, key);
    return key;
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
  potId: string;
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
      // WI-2102: epoch 0 = the PRE-re-key BASELINE (hive-epoch-state.ts) — content
      // federates PLAINTEXT (today's path), exactly as the decrypt gate's
      // `op.epoch == null` passthrough expects. Without this bypass a never-rekeyed
      // hive demanded an epoch-0 key on every drain: a MEMBER box threw
      // EpochKeyUnavailableError forever (no epoch-0 wrapped row is ever distributed
      // — epoch 0 predates distribution) wedging its whole outbox, and an OWNER box
      // minted a fresh-random epoch-0 key only IT holds and federated content no
      // member could ever decrypt (deferred forever at the decrypt gate). Net effect
      // on a 2-box pair: replication dead BOTH directions (the P-059 signature;
      // proven live on the gate rig 2026-07-03, inst-a/b.log 728+ drain failures).
      if (epoch === BASELINE_EPOCH) return null; // plaintext — no epoch stamp
      const key = await deps.resolveKey(deps.potId, epoch);
      // OpIdentity (object) — encryptOpPayload derives the opId internally via buildOpAAD.
      const id = { tableTag: op.table, rowKey: op.hbKey, authorPubkey: op.writerPubkey ?? '' };
      const ct = await encryptOpPayload(deps.crypto, valueToBytes(op.value), { potId: deps.potId, epoch, id }, key);
      return { epoch, value: encodeCiphertext(ct) };
    },
  };
}

export interface EpochDecryptGateDeps extends EpochOpGateDeps {
  /** J's per-apply-loop deferral buffer (key-before-content ordering). */
  pending: PendingEpochContent;
  /**
   * WI-808 observability: a best-effort trace of the gate's per-op DECISION
   * (passthrough / defer / decrypt-fail / applied). The two failure paths
   * (defer, decrypt-fail) are otherwise SILENT — a federated content op that
   * never lands on a joiner left no signal, so the drop was indistinguishable
   * from the gate never being installed. Wired to recordBootEvent at boot.
   * Pure observability — a throw here must never alter the gate's verdict.
   */
  onTrace?: (phase: string, detail: string) => void;
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
  const trace = (phase: string, detail: string) => {
    try {
      deps.onTrace?.(phase, detail);
    } catch {
      // observability must never alter the gate verdict
    }
  };
  return (inner) =>
    async (op: OpEnvelope): Promise<boolean> => {
      // WI-808 DECISIVE ENTRY TRACE: fire for ANY op that looks encrypted — epoch
      // stamped OR value is a `{__rekey}` envelope. This resolves the ambiguity the
      // verdict-only traces left: if a content op REACHES the gate this fires (and the
      // detail shows whether `epoch` survived the wire); if it NEVER fires, the content
      // op is dropped UPSTREAM of the gate (merge/admission/routing), not here. A
      // ciphertext value with epoch==null is the "stamp lost on receive" smoking gun.
      const looksEncrypted = op.epoch != null || isRekeyValue(op.value);
      if (looksEncrypted) {
        trace(
          'epoch_gate_seen',
          `${op.table ?? '?'}/${(op.hbKey ?? '?').slice(0, 24)} epoch=${op.epoch ?? 'NULL'} rekeyVal=${isRekeyValue(op.value)} w${(op.writerPubkey ?? '?').slice(0, 8)}`,
        );
      }
      if (op.epoch == null) return inner(op); // plaintext / control-plane
      const ct = decodeCiphertext(op.value);
      if (!ct) return inner(op); // epoch-stamped but not our wrapper — permissive passthrough

      const where = `${op.table ?? '?'}/${(op.hbKey ?? '?').slice(0, 24)} e${op.epoch} w${(op.writerPubkey ?? '?').slice(0, 8)}`;
      let key: EpochKey;
      try {
        key = await deps.resolveKey(deps.potId, op.epoch);
      } catch (e) {
        // key not yet local (remaining member waiting; or removed member forever) → defer.
        trace('epoch_defer', `${where} hive=${deps.potId} no-key-yet: ${(e as Error)?.message ?? e}`);
        deps.pending.defer(op, deps.potId, op.epoch);
        return false;
      }

      // OpIdentity must match what encrypt sealed: same (table, hbKey, writerPubkey).
      const id = { tableTag: op.table ?? '', rowKey: op.hbKey ?? '', authorPubkey: op.writerPubkey ?? '' };
      let plaintext: Uint8Array;
      try {
        plaintext = await decryptOpPayload(deps.crypto, ct, { potId: deps.potId, epoch: op.epoch, id }, key);
      } catch (e) {
        // have a key but can't decrypt (wrong epoch / tampered AAD) → drop = read cut.
        // WI-808: this is the SILENT drop — most often an AAD mismatch (potId is the
        // LOCAL home slug, not a federated field, so it can differ owner↔joiner).
        trace('epoch_decrypt_fail', `${where} hive=${deps.potId} DROP: ${(e as Error)?.message ?? e}`);
        return false;
      }
      // Apply the now-PLAINTEXT op; clear `epoch` so downstream sees a normal op.
      trace('epoch_applied', `${where} hive=${deps.potId}`);
      return inner({ ...op, value: bytesToValue(plaintext), epoch: undefined });
    };
}

/** A boot-scope drain-queue entry: a `(hive, epoch)` whose `hive_epoch_keys` row just
 *  applied this merge pass (recorded by the projection's `onEpochKeyApplied` hook). */
export interface DrainedEpoch {
  potHomeSlug: string;
  epoch: number;
}

/**
 * The DRAIN HOOK (shared-hive-rekey-2026-06-19) — the complement of the decrypt gate's
 * DEFER, and the pre-ship convergence guarantee the P-008 witness can't exercise (it
 * orders keys-first so it never defers).
 *
 * The gate defers an epoch-N content op into `pending` when its epoch-N key is not yet
 * local (production has no keys-before-content ordering: the merge applies on ARRIVAL, not
 * by a global cross-table HLC sort). This re-applies those deferred ops once the key row
 * lands. Boot wires the `hive_epoch_keys` projection's `onEpochKeyApplied(hive, epoch)` to
 * PUSH onto `drainQueue` (recording, NOT draining, so it never re-enters the apply that is
 * firing it), and calls this AFTER each merge pass: for each queued `(hive, epoch)`, pull
 * that bucket's deferred content (now decryptable) and re-run it through THIS pass's
 * `applyImpl` (decrypt → EN-4 → EN-2 → scopedApply — the SAME path).
 *
 * Bounded + non-re-entrant: a CONTENT op never fires `onEpochKeyApplied`, so re-applying
 * drained ops adds no new queue entries (no cascade); the queue is CONSUMED (spliced) so
 * each signal drains once. Best-effort: a re-apply throw must not abort the merge pass —
 * the ciphertext stays in the peer log, so a dropped re-apply re-defers on a later fold.
 *
 * Returns the number of deferred ops re-applied (observability / tests). Pure over its
 * injected deps (no boot, no PG) — fully unit-testable.
 */
export async function drainQueuedEpochContent(deps: {
  pending: PendingEpochContent;
  drainQueue: DrainedEpoch[];
  applyImpl: (op: OpEnvelope) => Promise<boolean>;
}): Promise<number> {
  if (deps.drainQueue.length === 0) return 0;
  // Take + clear: a later pass re-queues on the next key apply. Snapshot so a re-apply
  // that (defensively) somehow re-queued can't grow the loop within one drain.
  const toDrain = deps.drainQueue.splice(0);
  let reapplied = 0;
  for (const { potHomeSlug, epoch } of toDrain) {
    for (const deferred of deps.pending.drainEpoch(potHomeSlug, epoch)) {
      try {
        if (await deps.applyImpl(deferred.op)) reapplied++;
      } catch {
        // best-effort — a re-apply failure must not abort the merge pass.
      }
    }
  }
  return reapplied;
}

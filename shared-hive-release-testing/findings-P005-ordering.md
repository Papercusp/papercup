# P-005 — the key-before-content ordering invariant (46b7a's federation half)

Co-build with K (su-313d1). K owns the `hive_epoch_keys` table + projection +
`EpochKeyProvider` impl; **I own the ordering invariant + the apply-seam
decrypt-gate**. ed300's crypto (`HiveEpochCrypto`) + K's serving glue
(`hive-epoch-serving.ts`: `deriveOpId`, `encryptOpPayload`/`decryptOpPayload`,
`EpochKeyProvider`, the `papercusp-hive-rekey` flag gate) are LANDED + frozen.

## The invariant (why `fed_hlc` alone is insufficient)
Content ops are AEAD-encrypted under the hive's current **epoch key**. A peer can
only decrypt an epoch-N content op once it holds epoch-N's wrapped key (a
`hive_epoch_keys` row for `(hive, epoch, ownDevice)`). The key row and the content
op federate as **separate ops on separate surfaces**.

`fed_hlc` (my D-001 fix, migration 314) gives the PRODUCER a keys-before-content
order (the boundary writes the key rows, then content is encrypted under the new
epoch → the keys carry a lower HLC) AND makes each LWW table converge. But it does
**not** guarantee key-before-content at the CONSUMER: the merge applies ops as they
ARRIVE and advances its cursor by **log position**, not by a global cross-table HLC
sort. So an epoch-N content op can reach `applyOpVia` before its key.

⇒ The ordering must ALSO be enforced **fail-closed at the apply seam**: a content
op whose epoch key is not yet local is **deferred** (never applied as garbage,
never lost) and re-applied once the key row lands.

This single mechanism handles both membership cases for free:
- **remaining member** — the key row federates → drain the deferral → apply +
  decrypt → converge.
- **removed member** — the key row is never written to it → its deferred epoch-N+
  content is undecryptable forever = the **C-001 read cut-off** (bounded so the
  pending set can't grow without limit; the ciphertext stays in the log).

## Built + teeth-verified (UNBLOCKED — landed ahead, inert)
`packages/operator-core/lib/sync/hyperbee/pending-epoch-content.ts` + its test
(6/6, teeth: neuter the dedup + the bound → 3 RED, restore → GREEN). Pure, no I/O.
API: `defer(op, hiveId, epoch) → bool` (re-fold-safe dedup by op LWW-identity);
`drainEpoch(hiveId, epoch) → DeferredOp[]` (FIFO); `size()`/`bucketCount()`;
bounded by `DEFAULT_MAX_PENDING` with global-oldest eviction.

## Apply-seam gate (mine to wire into `applyOpVia`, gated on the flag)
```
on apply of op:
  if op.epoch == null            → plaintext (legacy / non-rekey) → today's path
  key = await provider.keyForEpoch(hiveId, op.epoch).catch(() => null)
  if key == null                 → pending.defer(op, hiveId, op.epoch); return NOT-applied
  payload = await decryptOpPayload(crypto, <op ciphertext>, {hiveId, epoch, id:{op.table, op.hbKey, op.writerPubkey}}, key)
  on decrypt-reject (tampered / wrong despite key) → drop (fail-closed), NOT defer
  else                           → decode(payload) → project (the existing path)
when a hive_epoch_keys row for (hive, epoch, ownDevice) APPLIES:
  for op of pending.drainEpoch(hive, epoch): re-feed op through applyOpVia
```

## Open confirmations from K (sent 2026-06-19; blocks wiring `applyOpVia`)
1. **Op-envelope shape** — proposing `epoch?: number` on OpEnvelope/PeerLogOp; when
   present, the payload (`op.value`) is the AEAD ciphertext. Who owns adding the
   field + the **producer encrypt** (on capture/drain)? (Pair it with my decrypt.)
2. **Provider + hiveId at apply** — thread `EpochKeyProvider.keyForEpoch` into
   `applyOpVia`'s opts; resolve the op's `hiveId` (from the harness hive binding);
   the rekey-flag check.
3. **Drain trigger** — K's `hive_epoch_keys` projection `writeToPg` fires
   `onEpochKeyApplied(hive, epoch)` so the buffer drains exactly when a key lands
   (vs polling).

## Sequencing
Gated on dc9db's (a′) hive-home federation seam (the path `hive_epoch_keys` rides)
+ K's table/provider. The module + this spec are ready; wiring lands when both do.
All inert behind `papercusp-hive-rekey` (off) — safe to land ahead.

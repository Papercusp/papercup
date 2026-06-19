# Brief RE-KEY (C-001 / E-001 / Move 2) — engineering design (K's half)

Owner: su-313d1 (K). Co-owner: su-ed300 (crypto foundation). Lead: su-9140a.
**Status: OWNER-GREENLIT (Avi, 2026-06-19)** — member-remove / go-private MUST cut a
removed peer's READ access to post-boundary content. **Critical-path-to-public-release**
(S0-for-release). This supersedes the prior option-(d) document-only decision.

This doc is the **engineering design for the K half** (boundary / distribution /
serving-under-epochs / live cut-off witness). The crypto foundation (epoch group-key +
content-core encryption) is su-ed300's half; the seam between them is the
`HiveEpochCrypto` interface (§Interface). The brief is `brief-REKEY-c001-move2.md`;
the architecture is `DESIGN-hive-federation-long-term.md` Move 2.

---

## Grounding (current code — what exists, what doesn't)

Confirmed by reading the live source (2026-06-19):
- **Unconditional serve** — `sync/hyperbee/swarm.ts:378` `opts.store.replicate(socket)`
  plugs the whole corestore into EVERY topic peer's connection. Admission gates which
  logs get *aggregated/applied*, not what bytes are *served*. (C-001 pillar 1.)
- **Immutable topic** — `deriveSwarmTopic` = `sha256("…:hive:"+pubkey)`; never re-keys.
  (C-001 pillar 2.) The firewall (`swarm.ts:527`) bans by swarm/DHT key, not device
  pubkey — structurally can't enforce device revocation at the connection layer.
- **No encryption, no epoch** — `grep encryptionKey|epoch` over `corestore.ts` +
  `boot.ts` = **zero hits**. There is no per-member content key and no epoch model
  today. (C-001 pillar 3.) ⇒ both are net-new: ed300 builds the crypto; K builds the
  epoch model + advancement + distribution.
- **Op dispatch by `tableTag`** — `projection.ts` `applyOpVia(lookup, op)` routes an op
  to its projection by `op.table`/`tableTag`. A re-key (key-distribution) op slots in as
  a NEW tagged op with its own handler — it is membership/key state, not content.
- **Ordering of record = `fed_hlc`** — J's D-001 fix (migration 314) made `fed_hlc` the
  HLC clock-of-record on every LWW table + `substrate_outbox.op_hlc`. The re-key
  distribution MUST tie to this: a member needs epoch N's key **before** it can read
  epoch-N content, so the re-key op must be ordered ≤ the first epoch-N content op.

## The cut, in one line
A removed peer can still *replicate the ciphertext bytes* (we do not rely on cutting
replication), but **without the new epoch key it cannot decrypt post-boundary content.**
The crypto is the load-bearing cut; gating `store.replicate` on admission is optional
defense-in-depth.

---

## Interface (the seam — `HiveEpochCrypto`, ed300 implements, K consumes)

Proposed signature to lock FIRST so both halves build in parallel:

```ts
interface HiveEpochCrypto {
  // derive the symmetric content key for (hive, epoch) — deterministic from the
  // group-key material ed300 manages.
  deriveEpochKey(hiveId: string, epoch: number): Promise<EpochKey>;
  // wrap the epoch key TO a single remaining member's device pubkey (asymmetric);
  // produces an opaque blob that only that member's device key can unwrap.
  wrapKeyToMember(key: EpochKey, memberDevicePubkey: string): Promise<Uint8Array>;
  // unwrap a wrapped epoch-key blob with the local device key.
  unwrapEpochKey(blob: Uint8Array, ownDeviceKeychainId: string): Promise<EpochKey>;
  // AEAD over an op payload under the epoch key (+ associated data: hiveId, epoch, opId).
  encryptOp(payload: Uint8Array, key: EpochKey, ad: OpAAD): Promise<Uint8Array>;
  decryptOp(ciphertext: Uint8Array, key: EpochKey, ad: OpAAD): Promise<Uint8Array>;
}
```

v1 recommendation (brief §1): a per-epoch **symmetric** content key, **wrapped to each
remaining member's device key** (the `wrapKeyToMember` path) — simple, fine for small
hives — behind this interface so MLS/TreeKEM (RFC 9420; forward-secrecy + PCS) can later
re-implement it without touching K's boundary/distribution code. **Open owner decision:**
the security target (do we need FS/PCS now, → MLS, or is epoch-wrap acceptable for v1?).

---

## K's half — phases

**P1 — Epoch model.** Add a monotonic `epoch:int` to hive state (the `hives` row +
the federated hive state), default 0. Read/write helpers; it federates with the hive
membership/settings (rides A-003's substrate — see Dependency).

**P2 — Boundary trigger.** member-remove (`revokeHiveContributor` /
`revoke-contributor`) AND go-private (`setHiveListing` private branch) →
`advanceEpoch(hive)`: bump epoch, `deriveEpochKey(hive, epoch+1)`, `wrapKeyToMember`
to each REMAINING member, emit the distribution op (P3). This is where the current
write-plane-only revoke gains its read-plane teeth. (K-1's `live:false` no-op becomes a
real epoch advance.)

**P3 — Distribution transport.** A new substrate op kind (`hive_epoch_key`) carrying
`{hiveId, epoch, perMemberWrappedKeys[]}`, dispatched via the `tableTag` registry,
projected into a local `hive_epoch_keys` table. Ordered via `fed_hlc` so the key op
precedes its epoch's content (D-001 tie-in). Removed peer is simply not in
`perMemberWrappedKeys` → never gets the key.

**P4 — Serving / reading under epochs.** New content ops carry `epoch`; payloads
encrypted via `encryptOp` under the current epoch key (app-layer AEAD on the op payload
is the v1 path — simpler than per-epoch hypercore `encryptionKey`, and lets old epochs
stay readable by current members). Read path: resolve the op's epoch → `unwrapEpochKey`
the stored wrapped key → `decryptOp`. A peer without the wrapped key gets ciphertext.

**P5 — Tests + live cut-off witness (the release gate).**
- Unit/integration: epoch advance + derive + wrap/unwrap; an op encrypted under epoch
  N+1 fails `decryptOp` with the epoch-N key; remaining members converge.
- **Flip `revoked-swarm.integration.test.ts`** — it currently *codifies* C-001 ("the
  revoking side's writes still federate to the revoked peer" as intended). Re-assert
  read-cutoff. **Flag-gate it** so it is not RED in the suite until the impl lands
  (no broken-CI commit).
- **LIVE witness** (inverse of my current C-001 witness): real-binary 2-peer pair,
  owner removes B → writes new content → **B can no longer read it** (decrypt-fail /
  ciphertext) while a remaining member still reads + converges.

## Dependency — A-003 first
The brief: "land A-003 first — the membership/epoch state must reach joiners." d2230
reframed A-003 as a **send-side** gap (the hive-home harness never drains its outbox /
isn't on the topic). The epoch model (P1) + distribution (P3) ride the SAME
hive-state-to-joiner substrate, so P1/P3 are blocked on d2230's send-side fix. K can
build P2/P4/P5 design + the epoch helpers + the flag-gated tests in parallel, and wire
distribution once A-003 lands.

## Back-compat (brief §6)
v1 = **encrypt new hives only** (existing hives stay legacy-unencrypted + documented);
migrating existing hives (re-encrypt history under epoch 0) is a later phase. Surfacing
for the owner; new-hives-only is the pragmatic ship.

## Open decisions (for ed300 / owner)
1. Security target: epoch-wrap (v1) vs MLS/TreeKEM (FS/PCS). Drives ed300's foundation.
2. Encryption layer: app-layer AEAD on op payloads (K's lean) vs per-epoch hypercore
   `encryptionKey` (ed300's call — affects the corestore).
3. Back-compat: new-hives-only v1 (recommended) vs migrate-existing.

## Status
- Split + interface proposed to ed300/9140a (awaiting ed300's sign-off on the seam).
- Next: on interface sign-off → formal plan `shared-hive-rekey-2026-06-19` + start P1
  (epoch model) + P5 flag-gated test scaffolding (both A-003-independent).

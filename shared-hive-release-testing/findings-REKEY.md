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

**P1 — Epoch model.** The current epoch is a **`hive_settings` row** (`setting_key='epoch'`,
`value`=JSON monotonic int, default 0) — NOT a new column on the local `hives` table.
Grounding (read 2026-06-19): `hives` (184-hives-table.sql) is workspace-LOCAL +
RLS-isolated, has **no projection** → it does not federate. `hive_settings`
(186-hive-settings.sql) IS the federated key-value hive-state table (projection
`projections/hive-settings.ts`, LWW by `fed_ts`/`fed_hlc`, keyed on
`harness_slug`=hive home_slug). So putting the epoch in `hive_settings` makes it reach
joiners **for free over the same path A-003 fixes** (and D-001-ordered by `fed_hlc`).
Deliver: a typed get/set epoch helper over the hive-settings projection + an
`advanceEpoch` writer.

**P2 — Boundary trigger.** member-remove (`revokeHiveContributor` /
`revoke-contributor`) AND go-private (`setHiveListing` private branch) →
`advanceEpoch(hive)`: bump epoch, `deriveEpochKey(hive, epoch+1)`, `wrapKeyToMember`
to each REMAINING member, emit the distribution op (P3). This is where the current
write-plane-only revoke gains its read-plane teeth. (K-1's `live:false` no-op becomes a
real epoch advance.)

**P3 — Distribution transport.** A new FEDERATED table `hive_epoch_keys` with
**per-member rows** `(workspace_id, hive_home_slug, epoch, member_device_pubkey,
wrapped_key bytea, author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)` +
its own projection registered by `tableTag` (mirror `projections/hive-settings.ts` —
the federated-table pattern with the echo-guard + LWW + `fed_hlc` ordering). The boundary
trigger writes one row per REMAINING member (`wrapKeyToMember`); the removed peer is
simply never given a row → it federates the ciphertext content but has no wrapped key.
`fed_hlc`-ordered so a member has epoch N's key row before epoch-N content (D-001
tie-in). New migration (next `db:next-migration`).

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

## Dependency — A-003 send-side (= Move-1 "increment 2") is the hard blocker for P1/P3
The brief: "land A-003 first — the membership/epoch state must reach joiners." d2230
**finalized A-003 RED (2026-06-19)** and root-caused it precisely: the bug is dominantly
**send-side** — the owner's hive-HOME harness (kind:'hive') never federates its OWN
content (`hive_members`/`hive_settings` outbox rows are `drained_at=NULL`; the hive-home
harness never joins the hive topic — only MEMBER harnesses do). d2230's receive-side
rebind is correct + fires live but is MOOT because no op leaves A. This is su-963ee's
Move-1 **"increment 2"** (wire the hive-home harness to federate: boot onto topic +
drain its outbox), and 9140a's recommended fix is option (a) precisely BECAUSE the
re-key needs the hive-home to federate epoch/membership state.

Implication for this lane: **P1 (epoch in `hive_settings`) + P3 (epoch-key distribution)
both ride the hive-home→joiner path that does not exist yet.** They are blocked on the
A-003 send-side fix, which is **finalized-RED but NOT yet owned/started** (d2230 is
positioned for option (a); awaiting su-963ee/owner's call on whether A-003 send-side
gets its own lane now or rides Move 1). So the re-key's release-gate sequence is:
**A-003 send-side (Move-1 inc-2) → P1/P3 → P4/P5 witness.** Parallel-unblocked NOW:
ed300's crypto foundation (no A-003 dep), the feature flag, P5 test scaffolding, and
P2/P4 design.

## Back-compat (brief §6)
v1 = **encrypt new hives only** (existing hives stay legacy-unencrypted + documented);
migrating existing hives (re-encrypt history under epoch 0) is a later phase. Surfacing
for the owner; new-hives-only is the pragmatic ship.

## Open decisions — RESOLVED (ed300, 2026-06-19; see plan decisions D-001/D-003)
1. **Security target → epoch-wrap (v1)**, behind the MLS-able `HiveEpochCrypto` interface.
   MLS/TreeKEM (FS/PCS) is a later v2 upgrade, NOT a start-gate (plan D-001). Owner's
   FS/PCS target relayed as a v2 confirmation (plan P-009, non-blocking).
2. **Encryption layer → app-layer AEAD on op payloads** (XChaCha20-Poly1305), NOT a
   per-epoch hypercore `encryptionKey`. Keeps old epochs readable by current members +
   avoids a corestore change; the interface is op-based (encryptOp/decryptOp) anyway.
3. **Back-compat → new-hives-only v1** (plan D-003); existing hives stay legacy-unencrypted
   + documented (the honest-UI line already shipped covers them).

## Crypto foundation — ✅ LANDED (ed300, plan P-001)
`packages/operator-core/lib/sync/hyperbee/hive-epoch-crypto-impl.ts` —
`createHiveEpochCrypto()` implements the `HiveEpochCrypto` seam (interface unchanged):
- **deriveEpochKey** = fresh-random 32B key per `(hive,epoch)`, persisted in the device
  **keychain** (service `papercusp-hive-epoch-key`, id `<hiveId>:<epoch>`), get-or-create.
  This is the **epoch-advancer's** seam; members never mint. Fresh-random (not KDF-from-root)
  is what makes the cut-off real.
- **wrapKeyToMember** = libsodium sealed box to the member's Ed25519 device key
  (Ed25519→X25519). **unwrapEpochKey** = inverse via the local keychain device key; fails
  closed when not wrapped to (the removed-member cut-off) or the device key is absent.
- **encryptOp/decryptOp** = XChaCha20-Poly1305; `OpAAD{hiveId,epoch,opId}` bound as
  length-prefixed associated data.
- Tests: `hive-epoch-crypto-impl.test.ts` 12/12, **teeth-verified** (neutering the
  fail-closed `seal_open` guard flips exactly the cut-off + end-to-end-cut-off tests RED).
  Type-clean (added `sodium-native.d.ts` ambient types). Lazy sodium import (SPA-bundle-safe).

**Usage contract for the K-half consumer:**
1. `deriveEpochKey` = epoch-advancer mints+persists; members use `unwrapEpochKey` for BOTH
   read and write (never `deriveEpochKey`).
2. `unwrapEpochKey` is STATELESS — re-unwrap from the durable `hive_epoch_keys` blob (P-005)
   each access + cache the EpochKey in-process; no member-side secret store needed.
3. `OpAAD.opId` must be deterministic + stable per op (table+key+author) so encrypt and the
   remote decrypt use the identical AAD (else decrypt fails closed).
4. Wire `createHiveEpochCrypto()` behind the flag; `notImplementedHiveEpochCrypto` stays the
   default until then.

## Serving layer — ✅ LANDED (K, the unblocked part of P4)
`packages/operator-core/lib/sync/hyperbee/hive-epoch-serving.ts` — the pure glue between
the federation op path and ed300's crypto (consumes the stable contract; touches NO
capture/drain code, so zero collision with d2230's in-flight A-003 work):
- **`deriveOpId(tableTag, rowKey, authorPubkey)`** = sha256 of the JSON-encoded triple —
  the deterministic + cross-peer-stable `OpAAD.opId` ed300's contract delegated to the
  serving layer (encrypt on the owner + decrypt on a member compute the IDENTICAL AAD).
- **`encryptOpPayload` / `decryptOpPayload`** = assemble `OpAAD{hiveId,epoch,opId}` in ONE
  place + call ed300's `encryptOp`/`decryptOp` (so encrypt/decrypt can't drift).
- **`EpochKeyProvider`** seam (owner `deriveEpochKey` vs member re-unwrap-from-blob — impl
  deferred to P1/P3, rides d2230's federation path).
- **`resolveHiveEpochCrypto(enabled)`** = the `papercusp-hive-rekey` flag gate →
  `createHiveEpochCrypto()` | the fail-closed `notImplemented` stub (impl dynamic-imported
  only when on; no static sodium pull).
- Tests `hive-epoch-serving.test.ts` **7/7, teeth-verified** (drop `rowKey` from
  `deriveOpId` → the sensitivity + the wrong-epoch-key/tampered-AAD cut-off tests flip RED).
  The C-001 cut-off is proven at the serving level against ed300's REAL crypto: wrong-epoch
  key, tampered op-identity, and tampered epoch all **fail-closed** on decrypt.

## Epoch model — ✅ LANDED (K, P1 / plan P-003)
`packages/operator-core/lib/sync/hyperbee/hive-epoch-state.ts` — the current epoch as a
federated `hive_settings` row (`setting_key='epoch'`, JSON int), via the existing
`hive-settings-store` (so it rides the hive-home→joiner path + the capture trigger, no
new table/migration): `getHiveEpoch` (baseline 0 + coercion of legacy/malformed values),
`setHiveEpoch` (validated), `advanceHiveEpoch` (monotonic bump — the P2 boundary-trigger
seam). Pure state, no key material. Tests `hive-epoch-state.test.ts` **8/8,
teeth-verified** (neuter the `+1` advance → the monotonic tests flip RED).

## Boundary core — ✅ LANDED (K, P2 core / plan P-004 core)
`packages/operator-core/lib/sync/hyperbee/hive-epoch-boundary.ts` —
`advanceEpochAndWrap(crypto, ctx, remainingMemberPubkeys[])`: the pure composition that
turns a boundary into a read cut-off — advance the epoch (P1) → mint the new epoch key
(ed300 `deriveEpochKey`) → wrap it to each REMAINING member (ed300 `wrapKeyToMember`,
deduped). Returns `{newEpoch, wrapped[]}` for the wiring to persist into `hive_epoch_keys`
(P-005) + federate. The removed member is simply absent from `remainingMemberPubkeys` →
gets no wrapped row → cut off. Tests `hive-epoch-boundary.test.ts` **3/3, teeth-verified**
(derive the key for the wrong epoch → the e2e cut-off flips RED). **Proven END-TO-END
with ed300's REAL crypto** (P1+P2+P4 composed): a remaining member unwraps the new key +
`decryptOpPayload`s post-boundary content; a removed member cannot unwrap → cut off. This
is the C-001 read-cut mechanic, demonstrated at the unit/integration level — what the
LIVE witness (P-008) will prove on the real binary once the federation seam lands.

## EpochKeyProvider — ✅ LANDED (K, P-005 consumer half)
`packages/operator-core/lib/sync/hyperbee/hive-epoch-key-provider.ts` —
`createEpochKeyProvider(crypto, loader, localDevice)` → `keyForEpoch(hiveId, epoch)`: the
member-side resolver the apply-path decrypt-gate (46b7a) calls. Re-unwraps the device's
wrapped `hive_epoch_keys` row (ed300 `unwrapEpochKey`) + caches in-process; FAILS CLOSED
with `EpochKeyUnavailableError` when no row — which is BOTH the C-001 cut-off (removed →
forever) AND 46b7a's defer signal (not-yet-arrived → defer + drain on key arrival). The
`WrappedKeyLoader` seam is the only tie to the (gated) `hive_epoch_keys` table — injected,
so it runs ahead. Tests `hive-epoch-key-provider.test.ts` **4/4, teeth-verified** (neuter
the fail-closed guard → the cut-off test flips RED).

## P-005 co-build (with 46b7a / J)
Division ACCEPTED: **K** = `hive_epoch_keys` table (migration) + projection (mirror
hive-settings) + the `EpochKeyProvider` (✅ shipped); **J (46b7a)** = the key-before-content
ORDERING gate + the op-path decrypt-gate — J already shipped the `pending-epoch-content`
buffer (defer-until-key-then-drain; removed member defers forever = bounded cut-off, 6/6).
J's 3 design-Qs answered (envelope `epoch?`+producer-encrypt pairing; `keyForEpoch` via the
shipped provider; the `onEpochKeyApplied(hiveId,epoch)` drain callback my projection will fire).

## Status
- ✅ crypto (P-001); ✅ serving glue (7/7); ✅ epoch model (P-003, 8/8); ✅ boundary CORE
  (P-004 core, 3/3, e2e cut-off proven); ✅ EpochKeyProvider (P-005 consumer, 4/4); ✅
  **`hive_epoch_keys` migration (mig 316, P-005 table)** — written + VALIDATED (rolled-back
  tx against the live operator PG: all DDL applies, stamp + capture triggers resolve);
  DARK/additive, auto-applies safely; ✅ **`hive-epoch-keys` projection + store** (P-005
  distribution data layer) — the projection (mirror hive-settings + D-001 LWW guard + harness_slug
  demux + the `onEpochKeyApplied` drain hook) + the store (`putWrappedKeys` +
  `createPgWrappedKeyLoader` = the EpochKeyProvider's loader). **6 modules + 1 migration, 32 tests,
  all teeth-verified; built AHEAD of the gate.** Plus J's pending-buffer (6/6).
- A-003 (a′) is now CODE-COMPLETE + integration-proven (dc9db swarm/announce + d2230 boot.ts/
  rebind; d2230's register-all composition test proves the hive-home→joiner crossing + the
  no-cross-merge gate; 935 suite green). Only 9140a's one-off LIVE binary re-witness remains.
- REMAINING for K — the WIRING (gated on J's apply-gate + the green witness, to avoid the
  register-all rebind collision): register the projection in register-all; `encryptForCurrentEpoch`
  (the producer paired with J's envelope `epoch?` field); the P-004 boundary WIRING
  (`revokeHiveContributor`/`setHiveListing` → `advanceEpochAndWrap` → `putWrappedKeys`); the
  op-path encrypt/decrypt; then P-007/P-008: the flipped `revoked-swarm` test + the LIVE cut-off
  witness (release gate). The data + crypto layers are DONE; what's left is integration + the live proof.

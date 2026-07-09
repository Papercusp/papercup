# Brief RE-KEY (C-001 / E-001 / Move 2) — read-plane revocation via epoch re-key

**Status: OWNER-GREENLIT (2026-06-19, Avi).** The C-001 product decision is made:
**member-remove / go-private MUST cut a peer's READ access to future content.** This
is now the **critical-path-to-public-release** engineering item. Priority: S0-for-release
(the pot cannot ship publicly until this lands + is verified live). Needs a
**crypto-capable owner** (Mug/owner to assign). Engineering brief, not a test lane.

## Objective
When a member is removed from a pot, or a pot is flipped public→private, the
removed/excluded peer must be **unable to read content created after the boundary** —
even though it still holds the (immutable) pot pubkey and can still reach the topic.

## Why it matters / why the current design can't do it (root cause, C-001)
Revocation today is **write + discovery-plane only**; reads are NOT cut, because of
three things together (all confirmed live on the shipped binary):
1. `swarm.ts` `store.replicate(socket)` serves cores **unconditionally** to any topic
   peer — admission gates which logs get *aggregated*, not what's *served*.
2. The pot topic = `sha256("papercusp-substrate-v1:pot:" + pubkey)` over an
   **immutable** pubkey — it never re-keys on remove/private.
3. Cores have **no per-member `encryptionKey`** (`corestore.ts`/`boot.ts`) — content is
   served in the clear to anyone on the topic.
So a removed member (or anyone who got the link while public) keeps reading all future
content until the pot is **dissolved**. No write-plane or firewall change fixes this —
it requires **content encryption + key rotation that excludes the removed peer.**

## Design — per-epoch group key (MLS / TreeKEM-style)
(Per `DESIGN-pot-federation-long-term.md` Move 2.) Phase it:

1. **Epoch + group-key primitive.** Introduce a pot **epoch** (monotonic int) and a
   per-epoch symmetric **content key**. Choose the key-agreement scheme: full **MLS
   (RFC 9420)/TreeKEM** (scales to large groups, forward secrecy + post-compromise
   security) vs a simpler **sender-keys / per-epoch wrap-to-each-member** scheme
   (simpler, fine for small pots). Recommend starting with the simpler epoch scheme
   behind an interface that MLS can later implement — but the owner decision on
   security target (FS/PCS guarantees) drives this; surface it.
2. **Content-core encryption.** Encrypt pot content cores with the current epoch key
   (hypercore `encryptionKey` per epoch, or app-layer AEAD on op payloads). Reads
   require the epoch key → a peer without it gets ciphertext it can't decrypt.
3. **Epoch advancement on boundary.** member-remove / go-private →
   **advance the epoch**, derive a new content key, and **distribute it to the
   REMAINING members only** (wrapped to each remaining member's device key / via the
   MLS group op). The removed peer never receives the new epoch key.
4. **Replication/serving under epochs.** New content is written under the new epoch
   key; the removed peer can still *replicate the bytes* but **cannot decrypt** them.
   (Optionally also gate `store.replicate` on admission as defense-in-depth, but the
   crypto is the load-bearing cut.)
5. **Key distribution transport.** Re-key messages ride the existing substrate
   (a new op kind) or the announce/admission channel; must be delivered to remaining
   members reliably + ordered w.r.t. content (a member must have epoch N's key before
   reading epoch N content — tie to the HLC/fed_hlc ordering from D-001).
6. **Back-compat / migration.** Decide: encrypt **new pots only** (simplest; existing
   pots stay legacy-unencrypted + documented), or migrate existing pots (re-encrypt
   history under epoch 0 + rotate). New-pots-only is the pragmatic v1.

## Subsumes
- **A-003 revocation enforcement** (the revoked-set reaching joiners) — moot once reads
  are crypto-gated; but A-003's member/settings *federation* is still needed for the
  membership/epoch state to reach joiners, so land A-003 first (it's the substrate the
  re-key rides on).
- **E-001** (public→private doesn't cut reads) — same epoch-advance mechanism.

## Method / verification (the bar to flip release-GREEN)
- **Unit/integration:** epoch advance + key derivation + wrap-to-members; an op written
  under epoch N+1 is undecryptable with the epoch-N key; remaining members converge.
- **Threat-model tests:** a removed peer holding the old key + the topic gets ciphertext
  it cannot decrypt for all post-removal content (extend `federation-threat-model.test.ts`
  / `revoked-swarm.integration.test.ts` — note the latter currently *codifies* the gap
  as intended; it must be **flipped** to assert read-cutoff).
- **LIVE witness (the release gate):** on a 2-instance real-binary pair, owner removes
  member B → owner writes new content → assert **B can no longer read it** (ciphertext /
  decrypt-fail), while a remaining member still reads + converges. This is the inverse of
  today's live C-001 witness (which proved B keeps reading).
- Gate on: the live cut-off witness GREEN + the threat-model battery GREEN + no regression
  in the (now-green) federation + convergence (D-001) suites.

## Deliverables
- `findings-REKEY.md` (or a plan `shared-pot-rekey-2026-…`): the design choice
  (MLS vs epoch-wrap), the implementation, the threat-model tests, the live cut-off witness.
- The re-key implementation behind a flag; the flipped `revoked-swarm` test; the live witness.

## Done / verdict
GREEN only when, on the real packaged binary, a removed member's reads of post-removal
content **fail** (crypto-gated) while remaining members keep converging — and the
threat-model + federation + convergence suites stay green. **Until then, shared-pot is
NOT public-release-ready.**

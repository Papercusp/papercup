# Brief K — C-001 / E-001: read-plane revocation (removed members keep reading)

**Priority: S1 → S0-potential.** **Product-decision-gated** on the cutoff question,
but the **adversarial live witness is unblocked** — do that now. Live + authority.

## Objective
Complete the **live adversarial witness** that a removed member (or any prior
pubkey-holder after public→private) **keeps reading new content** on the real
binary, and — if the owner greenlights it — prototype + test **re-key-on-transition**
(the only thing that actually cuts reads).

## Why it matters for release
Revocation + visibility changes are **write+discovery-plane only — they do NOT cut
READS.** A removed member, or anyone who got the link while public, keeps reading
all future content until the pot is **dissolved**. Root cause is three things
together: `swarm.ts:329` `store.replicate(socket)` serves cores unconditionally to
ANY topic peer (admission gates aggregation, not what's served); the pot topic =
`sha256("papercusp-substrate-v1:pot:"+pubkey)` over an **immutable** pubkey (never
re-keys on remove/private); cores have **no per-member `encryptionKey`**
(`corestore.ts`/`boot.ts`). `revoked-swarm.integration.test.ts` step 2 **codifies**
the current behavior ("the revoking side's writes still federate to the revoked
peer") — so closing reads consciously flips a green test; it's a product decision,
not a silent bug.

## State (what's already witnessed — don't re-file)
- **public→private leg: PROVEN LIVE** (Brief E, su-963ee): owner flipped
  public→private (`POST /api/discovery/set-pot`, `withdrawn:true,
  tombstoneSent:true`) then wrote a new feature → the already-joined peer **still
  received it** in ~baseline time. Directory withdrawn, content reads not cut.
- **member-remove leg: NOT yet witnessed live** — the prior attempt hit
  `POST /api/admin/substrate/revoke-contributor` → 403 ("trust unverified-loopback
  not in allowlist"; correctly gated). No removal happened, so "B still reads" was
  honestly NOT counted. **This lane must find the authorized path to actually
  remove a member, then witness B still reads.**

## Scope / scenarios
1. **Member-remove live witness:** drive the *real* member-removal (the trusted/
   verified path, or the desktop action — not the loopback 403 path) so a removal
   actually lands; then write new owner content and assert the removed peer **still
   reads it** (`origin=remote`). That closes the leg Brief E left open.
2. **Rejoin-after-link witness:** a peer that left/was-removed re-joins the topic
   (it still has the immutable pubkey) and keeps reading new content.
3. **(Product-gated) re-key prototype:** per `DESIGN-pot-federation-long-term.md`
   Move 2 — per-epoch group key (MLS/TreeKEM-style): encrypt content cores;
   member-remove / go-private advances the epoch + re-keys to remaining members;
   removed peer can't read new content. Test: post-rekey, the removed peer's reads
   stop while remaining members still converge.

## Method
- Live on the running pair (embedded-PG `origin`); authority/admission code in
  `lib/authority/`, `swarm.ts`, `derive-swarm-topic.ts`. Coordinate `swarm.ts`
  edits with Brief H.

## Deliverables
- `findings-K.md`: the member-remove live witness (closing E's open leg), and — if
  greenlit — the re-key prototype + its cut-off test.
- A `coord:ask-owner` on the cutoff decision if not already answered.

## Done / verdict
Witness phase GREEN when member-remove is live-witnessed (read persists, honestly).
Full GREEN only when re-key cuts a removed peer's reads while members still converge
— and that requires the owner's cutoff decision first.

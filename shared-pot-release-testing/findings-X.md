# Findings — WAVE 4 Brief X: Adversarial security depth (untrusted peers)

Owner: su-ed300. Extends Brief C's threat-model (admission / forged-sig / malformed-op
basics) into the depth a PUBLIC, untrusted deployment faces. Scoped this pass to the
vectors where my context is unique (crypto foundation + Brief L invite/join flow) and that
are static/unit (low box load — the box was under routine-engine stress).

> STANDING: I pause X to build + run the re-key **live cut-off witness** (the release gate)
> when K's P3 + the A-003 (a′) seam land — that uses my crypto-foundation + .deb assets.

---

## X-1 — Invite-secret strength / brute-force — ✅ GREEN (+ defense-in-depth hardening landed)

**Threat:** a non-member who wants to join an `invite` pot without the link must obtain
the invite secret — by brute force or by exploiting weak minting. An invite secret →
`deriveInviteTopic(secret) = sha256("papercusp-pot-v1:invite:" + secret)` → the DHT topic
you join to receive the pot's announce.

**Analysis (code-verified 2026-06-19):**
1. **Minting is STRONG.** `pot-publish-from-repo.ts:187` mints the secret as
   `randomBytes(32).toString('hex')` = **256-bit CSPRNG** (64 hex chars). Every real invite
   link carries a 256-bit secret. No weak-generation path.
2. **The topic is one-way + non-invertible.** `deriveInviteTopic` is a single SHA-256 over
   the prefix+secret — the topic leaks nothing invertible about the secret (same property
   the G-001 channel-id hashing relies on). A topic-holder cannot recover the secret.
3. **No offline guess-oracle.** The secret is never checked against a stored hash — it only
   *derives a topic you join*. So an attacker cannot test guesses offline; each guess costs
   a derive + a live DHT topic-join + waiting to see if a pot announces. Brute-forcing even
   a 64-bit secret online (2⁶⁴ DHT joins) is infeasible.

→ **Verdict: GREEN.** Invite-secret strength holds: strong minting, one-way topic, no
offline oracle, infeasible online brute-force.

**Soft spot found + hardened (defense-in-depth, low-risk):** the *accept-floor* in
`SECRET_RE` was 16 hex (64 bits) — 4× weaker than the 256-bit minting. A hand-crafted link
with a weak 64-bit secret would parse. Not exploitable (per the analysis above), but the
floor should match the mint strength. **Landed:** `pot-invite-link.ts` `SECRET_RE`
`{16,128}` → `{32,128}` (128-bit floor). No real link is affected (all minted secrets are
64 hex); only a hand-crafted sub-128-bit link is now rejected. SECRET_RE is the single
source of truth (no duplicate validation to drift — verified). Doc comments + the stale
`join-invite.ts` reference updated.

**Tests (Vitest, teeth-verified):** `pot-invite-link.test.ts` — length-variant cases
moved to 32-hex; new `X-1` assertion: accepts exactly 32 hex (128-bit floor), rejects 31
hex AND the old 16-hex floor, accepts the 64-hex minted length. **Teeth:** reverting
`SECRET_RE` to `{16,128}` flips the X-1 test RED → restored → 28/28 green.

**Related minting-side note (low severity, owner-self-harm — recommended, NOT landed):**
`POST /api/discovery/set-pot` requires `inviteSecret` for `visibility:invite` but does
**not** validate it against `SECRET_RE` — a direct-API caller could set a weak/short
owner-supplied secret (the desktop UI always mints the 256-bit `randomBytes(32)` secret, so
this is API-only + only weakens the *owner's own* pot). Recommend: export an
`isValidInviteSecret(s)` from `pot-invite-link.ts` and validate it in `set-pot.ts` (and
the `discovery:set_hive` MCP tool) so the mint-side floor matches the accept-side. Filed for
a follow-up; not a blocker (no external-attack vector).

---

## X — remaining vectors (open; not exploited this pass)

Scoped out this pass (need live peers / a healthy box, or overlap an in-flight lane). Left
for another owner or a later X increment:

- **X-2 Byzantine admitted-member resilience** — an admitted member sends malformed /
  garbage / oversized ops at scale; assert the apply/projection path rejects safely (no
  crash / corruption). Extends C's malformed-op basics to depth. (Ready-now, unit-able;
  next X increment.)
- **X-3 DoS via pot/topic spam** — announce/topic flooding; needs the live swarm.
- **X-4 DHT Sybil / eclipse** — network-level; needs a multi-node DHT harness.
- **X-5 Metadata / traffic-analysis privacy** — what the directory announce + topic
  membership leak to an observer. (Partial: §X-1 shows the invite topic itself leaks
  nothing invertible; the announce *payload* on a joined topic carries pot metadata to
  secret-holders only — by design. A full traffic-analysis pass is open.)
- **X-6 invite-secret post-compromise** — once shared, an invite secret is a bearer token
  with no rotation/expiry; a leaked link grants topic access until the pot re-keys. This
  is exactly the C-001 **re-key (Move 2)** territory — the epoch re-key cuts post-boundary
  *reads* even for a leaked secret-holder. So X-6 is subsumed by the re-key; tracked there.

---

## Verdict (dimension, this pass): 🟡 YELLOW — X-1 GREEN; deeper vectors open

No S0/S1 found in the X-1 scope; the invite-secret surface is sound + hardened. The
adversarial-DEPTH vectors (Byzantine-at-scale, DoS, Sybil/eclipse, full metadata privacy)
remain unexercised — a public-release X-GREEN needs those, but none is a known blocker yet.
The single biggest adversarial-security item — a removed/leaked-secret peer reading future
content — is the **re-key (Move 2)**, in flight (crypto foundation landed; distribution
gated on A-003 (a′)).

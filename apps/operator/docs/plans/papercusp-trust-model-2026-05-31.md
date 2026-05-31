---
title: Papercusp trust model — research-backed design memo
slug: papercusp-trust-model-2026-05-31
created: 2026-05-31
owner: avi@storewolf.com
status: draft
---

# Papercusp trust model — research-backed design memo

> Status: **draft / proposed — pending tradeoff sign-off.** This memo records (1) the
> code-truth audit of Papercusp's current trust posture, (2) a 3-pass cited survey of
> how comparable P2P/local-first/decentralized systems implement security, (3) a
> per-system mapping verdict onto Papercusp, and (4) a recommended model with an
> **explicit accepted-insecurity tradeoff checklist** to be confirmed as intentional
> before any implementation. Nothing here is built yet.

## 1. Why this exists — the gap (from the code audit)

A code-level audit (2026-05-31) found that **GitHub is the only authorization actually
enforced in the system today.** Every trust layer Papercusp layers on top of it is dead
code, unwired, or self-asserted:

- The 5-state feature machine (`attemptTransition`) has **zero non-test callers**; the
  real status-write path (`PATCH /harness/:slug/features/:id`) is `auth:'public'` and
  accepts any string.
- The PR "trusted authors" gate (`trustedAuthorIds`) is vacuous — `trusted_authors` has
  **no writer anywhere**; the manual review route self-trusts the PR author.
- `completion_ref` (the "shipped ✓" proof) is **never written**; its verifier only proves
  a SHA is an advertised ref tip (existence), not that it was merged-to-default or
  authorized.
- The Hyperbee/Autobase substrate projects **unsigned, unauthenticated ops** verbatim into
  every peer's Postgres. The swarm topic is `sha256("papercusp-substrate-v1:gh:<repo_id>")`
  — derivable from the **public** repo id, so **any peer can join and forge**
  feature/PR/contributor/claim rows. The only admission check is a schema-version filter.
- The designed defenses (per-op signing, `addWriter` admission, `revoked_pubkeys`,
  two-channel identity binding) are specified but **have no production callers**.

**The one thing that *is* enforced:** PR merges go through GitHub's REST API with a real
user token, so GitHub's write-access + branch-protection are real. That observation drives
the whole recommendation.

**Two distinct threat models** (keep separate):
- **Untrustworthy local user** — everything is `auth:'public'` (127.0.0.1 only). Trusts
  whoever is on the desktop. Fine for single-user; not a shared-machine model.
- **Untrustworthy swarm peer** *(the serious one)* — public topic + unsigned ops ⇒ any
  peer can poison every other peer's local DB/UI. This is what the security layer addresses.

## 2. What the research found (3 deep-research passes, cited)

Confidence legend: **✓✓** adversarially verified (passes 1–2, primary sources) · **✓**
primary-sourced, extracted (pass 3; the workflow's vote-tally crashed but each claim is
quoted from a primary source and several were re-confirmed by direct fetch) · **~**
primary source fetched + established domain fact.

| System | Identity anchor | Per-op authorization | Membership / removal | Verdict for Papercusp | Conf |
|---|---|---|---|---|---|
| **Hypercore** | per-device Ed25519 key (= our model) | signed merkle tree per *log* (integrity, single-writer) | n/a | **MAPS** — our per-device key is exactly this; proves you authored *your* log, not that you're *allowed* | ✓✓ |
| **Autobase** | — | **none built-in** — *"optimistic blocks should self-verify in the apply handler… any writer could append"*; all verification is the app's job | `addWriter`/`removeWriter` = app calls inside `apply` | **MAPS / confirms gap** — our `addWriter` is the native model; per-op verification is ours to write | ✓✓ |
| **Hyperswarm/HyperDHT** | connecting peer's Noise key | Noise authenticates the *connection*, not replicated ops; topic = 32-byte public hash | only `firewall(remotePublicKey)` (coarse) | **MAPS / confirms threat** — public topic + connection-auth ≠ op-auth | ✓✓ |
| **blind-pairing** (Keet) | invite secret | candidate signs w/ invite key; member verifies | admit-by-invite; app-evaluated `userData` | **PARTIAL** — gives a ready admission handshake; put the GitHub proof in `userData` | ✓✓ |
| **Radicle** *(closest analog)* | self-sovereign `did:key` (opposite of ours) | **signs every write** (`refs/rad/sigref`); **rejects invalid before storing**; signed COBs (= our feature/PR/claim rows) | **delegate threshold/quorum** | **MECHANISM MAPS, anchor doesn't** — proves the sign-and-verify-before-store pattern we need | ✓✓ |
| **Radicle COBs** | content-addressed | `Entry::author` exposed → filter a bad author at view-build time | filter at materialization | **MAPS (caveat)** — our `revoked_pubkeys` = this *local projection filter*, NOT network rejection | ✓✓ |
| **ForgeFed** | ActivityPub actor | authorize by explicit **capability Grant**, not by membership | Grant/revoke | **transport NO-MAP, concept PARTIAL** — "authorize by grant, not by swarm presence" | ✓✓ |
| **Kleppmann (BFT-CRDT)** | — | **signatures necessary, NOT sufficient** — a signed *equivocation* breaks version vectors | replicated ACL must itself be a BFT CRDT | **DECISIVE** — don't try to make advisory state Byzantine-trustworthy; re-derive from GitHub | ✓✓ |
| **Keyhive / BeeKEM** (Ink&Switch) | **deliberately excludes** identity binding | capability chains + **per-op Ed25519 sig**; BeeKEM needs only **causal** order → runs on Autobase | **coordination-free removal w/ real PCS**; path-blanking; conflict-keys for concurrent ops | **AUTHZ MAPS WELL; complements (not replaces) the GitHub binding** — the upgrade path *if* real PCS is needed | ✓✓ |
| **MLS / RFC 9420** | — | TreeKEM; epoch chain | **needs one linear chain of agreed Commits**; concurrent commits fork a DAG MLS can't merge | **DOES NOT MAP** over Autobase's concurrent merge (only as a separately-ordered overlay; DMLS drafts non-final) | ✓✓ |
| **Keybase** *(direct two-channel analog)* | per-user **signed sigchain**; key↔GitHub via a **GitHub-hosted signed proof (gist)** | each sigchain link signed, `seqno`+`prev` hash (append-only, tamper-evident) | revocation = a **signed revoke link**; many sibkeys → device-loss recovery without nuking identity | **MAPS — improves the binding**: model two-channel as a signed sigchain link; the GitHub-hosted proof is the cross-check that detects a server/peer rewriting identity; revoke-as-signed-link > side-list | ✓ |
| **Sigstore / SLSA / in-toto** | short-lived **OIDC** identity (Fulcio cert) | keyless sig + **Rekor append-only transparency log**; in-toto/DSSE attestation | no revocation (short-lived certs); compromise caught by **monitoring** | **PARTIAL — provenance pattern, not transport**: proves *authenticated-at-a-time*, NOT authorization or "good." Confirms "shipped" must be **GitHub-derived**; GitHub already stores attestations → a separate transparency log is overkill | ✓ |
| **AT Proto did:plc** | hybrid: self-cert keys + a directory authority | signed repo commits (MST) | **rotation-key priority list + 72hr recovery window** (higher key rewrites a compromised lower key) | **PARTIAL — recovery lesson**: for us **GitHub IS the recovery anchor** — re-bind a new device key via a fresh two-channel proof from the GitHub account | ~ |
| **Nostr NIP-05** | pubkey ↔ `name@domain` via a `.well-known/*.json` on a domain | per-event Schnorr sig | n/a (relays) | **PARTIAL — lighter binding**: a GitHub-hosted well-known file is a cheaper binding variant; weaker than the device-signed-commit channel | ~ |
| **Secure Scuttlebutt** | per-identity **signed append-only feed** (≈ Hypercore) | every msg signed | **invite-based + follow-graph** bounds replication & Sybils (replicate within N hops) | **PARTIAL — admission analog**: the **GitHub collaborator graph** is our follow-graph — gate replication/admission to collaborators | ~ |

**Two claims the verifiers killed (don't believe):** that BFT-CRDTs are "immune to Sybil
without any proof of resource," and that a content-addressed hash-DAG *replaces*
signatures. Both overstated.

## 3. The decisive constraints (what bounds the design)

1. **Autobase will not authenticate ops for us** — per-op signing + `addWriter` gating are
   our code, in the `apply`/projection seam (today only a schema-version filter).
2. **Signatures are necessary but not sufficient** (Kleppmann) — a validly-admitted-then-
   malicious writer can sign false/equivocating rows. Full Byzantine resilience needs a
   hash-DAG causal layer we are **not** going to build.
3. **True removal / post-compromise security is impossible in an append-only multi-writer
   log** — a revoked writer's signed ops persist and replicate; "removal" = every honest
   peer dropping them at projection time. (Only a CGKA like BeeKEM gives real PCS, at cost.)
4. **A provenance signature proves authentication-at-a-time, not authorization or quality**
   (Sigstore) — so the trustworthy "shipped" signal must come from GitHub's *merge state*,
   not a self-reported receipt.
5. **GitHub already enforces the only hard authorization that matters** (merge = token +
   branch protection). This is the escape hatch from the unsolved Byzantine-CRDT problem.

## 4. Recommended model — "GitHub is the authority of record; peers are advisory"

1. **Authority of record = GitHub.** Every *decision-bearing* fact — did it merge, who has
   write access, real PR status, who is a contributor — is **re-derived from GitHub at the
   point of action**, never trusted from a peer.
2. **Peer-synced rows = advisory cache** (fast/offline UI), explicitly untrusted.
3. **Per-op Ed25519 signing + verify-on-receipt** in the Autobase `apply`/projection path —
   *defense-in-depth / UX integrity* (stops a swarm peer poisoning local UI), **not** the
   authority of record. **Sign sequence + freshness, not just content** (Radicle's
   2026 replay-CVE lesson).
4. **GitHub-anchored writer admission** — `addWriter` gated on the **two-channel binding**
   (blind-pairing handshake with the GitHub-hosted device-signed proof in `userData`);
   `revoked_pubkeys` as an **advisory projection-time drop-list** (Radicle-COB author-filter).
5. **Identity binding = a Keybase-style signed link** — the GitHub-hosted device-signed
   proof is the cross-check that lets any peer detect a rewritten identity; revocation is a
   *signed* statement, not just a side list.
6. **Device-key rotation/recovery is GitHub-rooted** — losing a device = re-run the
   two-channel binding from the new device; the old key goes on `revoked_pubkeys`. GitHub
   (the account) is the recovery anchor, playing did:plc's "higher-authority key" role.
7. **"Shipped"/provenance = GitHub-derived** — read the merge state from GitHub (the PR
   poll path already does); optionally record it as a signed in-toto-style attestation.
   **Do not** build a Rekor-style transparency log — GitHub already is the authority and
   stores attestations. (This also resolves the original `completion_ref` question: stamp
   a **GitHub-derived tier-A** record, not a self-reported tier-B receipt.)
8. **Sybil/admission = the GitHub collaborator graph** as the allow-list (SSB follow-graph
   analog) + the `firewall(remotePublicKey)` hook to reject unknown keys at connect time.
9. **Do NOT** adopt MLS (conflicts with concurrent merge) or build a Byzantine-CRDT ACL.
   **Keyhive/BeeKEM** is the documented upgrade path *only if* a concrete threat model
   later demands real membership + post-compromise security on the log itself.

## 5. The advisory-vs-trusted boundary (the decision that drives everything)

| Synced surface | Advisory (cache, peer-supplied)? | Decision-bearing → re-derive from GitHub? |
|---|---|---|
| Feature queue / status | yes — display/coordination | a "shipped" decision → **GitHub merge state** |
| PR status | yes — display | merge/approval authority → **GitHub** |
| Contributor list | yes — display | "is X a real contributor / has write access" → **GitHub collaborators** |
| Feature claims (who's working on what) | yes — coordination/UX only | (no hard authority needed; it's advisory by nature) |
| Completion / "shipped ✓" | no | **GitHub-derived only** |

This table is the **central decision to confirm** — anything in the right column must never
be acted on from peer state alone.

## 6. Accepted-insecurity tradeoffs — **sign-off checklist**

Under the recommended model we are *deliberately accepting*:

1. **Public, discoverable topic** — swarm spam/DoS is *mitigated* (firewall + admission),
   not prevented.
2. **Advisory peer state can be transiently forged** in local DB/UI until per-op signing
   ships — and even after, an admitted-then-malicious writer can inject signed-but-false
   advisory rows (equivocation). *Mitigation: nothing decision-bearing acts on it without
   GitHub re-derivation.*
3. **No true removal / no PCS** in the append-only log — revocation is best-effort
   projection filtering; data persists and replicates.
4. **Sybil resistance is delegated to GitHub** — identity = GitHub account; only as strong
   as the two-channel binding + GitHub's account-creation friction.
5. **Per-op signatures don't defeat a signed equivocator** (Kleppmann) — accepted because
   state is advisory + GitHub-re-derived; we explicitly do **not** build a BFT-CRDT ACL.
6. **Identity binding inherits GitHub account integrity** — a compromised GitHub account =
   compromised identity (same trust root as the merge authority, so not a new exposure).
7. **Local API stays loopback-trusted** — single-user-desktop model; not a shared machine.

## 7. Phased implementation plan (feeds the build task)

- **Phase 1 — make peer state advisory + re-derive from GitHub** *(highest value, lowest
  risk; neutralizes the entire forgery surface for anything that matters)*. Label each
  synced surface per §5; route every right-column decision through a GitHub read. Resolves
  `completion_ref` as a GitHub-derived "shipped" signal.
- **Phase 2 — per-op Ed25519 signing + verify-on-receipt** in the `apply`/projection path
  (sign seq+content); drop unverifiable ops at projection (UX integrity).
- **Phase 3 — GitHub-anchored `addWriter` admission** (two-channel proof in blind-pairing
  `userData`) + `revoked_pubkeys` projection drop-list; model the binding as a signed link.
- **Phase 4 — (only if a threat model demands real PCS)** Keyhive/BeeKEM membership. Gate
  on a written threat model; BeeKEM is pre-alpha/unaudited.

## 8. Open questions

- Exact advisory-vs-trusted labels for every synced field (§5 is the start).
- Concrete threat model that would justify Phase 4 (BeeKEM) over the drop-list.
- Concurrent admission vs revocation merge rule (Kleppmann's hard open case) — needed even
  for the advisory ACL.
- Keyhive's "Duelling Admins" edge case wants an external arbiter — GitHub can be it.

## 9. Sources & method

Three deep-research passes (web search → fetch primary sources → adversarial verification).
Passes 1–2: 47 sources, 50 claims verified, 4 killed — Holepunch repos, Radicle (Heartwood
+ docs.rs/radicle-cob + LWN), ForgeFed, Kleppmann (PaPoC'22 + keynote), Ink&Switch Keyhive
notebook, RFC 9420/9750 + DMLS drafts. Pass 3 (Keybase/Sigstore/did:plc/Nostr/SSB): the
workflow's vote-tally step crashed (subagents failed to emit structured output → all
defaulted to "killed" with 0-0 abstain votes), so those claims are **primary-sourced and
extracted but not triple-verified**; the two most decision-relevant (Sigstore threat model,
did:plc recovery) were re-confirmed by direct fetch. Primary sources: book.keybase.io,
github.com/keybase/proofs, NCC Group Keybase audit, docs.sigstore.dev, slsa.dev,
actions/attest-build-provenance, plc.directory spec, Nostr NIP-05, SSB protocol guide.

# Findings — K-stage live cut-witness on the FIX-A packaged binary (su-b813f)

**Plan:** shared-pot-rekey-2026-06-19 (P-008 live witness) · **Rig:** su-34db4's fresh
FIX-A socket VMs (fed-a `papercupai` ssh:2225 op:15009 pg:24619 · fed-b `aviynw`
ssh:2226 op:16007 pg:19991) · **Binary:** new `.deb` (b7fjkio3n) with FIX A + the 3
packaging fixes · **Flag:** `papercusp-pot-rekey` ON both VMs.

## TL;DR

- **FIX A is VALIDATED LIVE** on the packaged binary — a direct-link (`kind:'topic'`)
  joiner now resolves its pot-home projection slug, so the owner's pot-home announce
  is **in-scope** on the joiner (no more `scope_unresolved` on the joiner side).
- Driving the real join surfaced **two further gates**, both now root-caused. Neither is
  in the re-key code; one is a rig artifact, one is a real (separate) product gap:
  1. **Owner-side scope (slug asymmetry).** Admission is slug-scoped; the joiner derives
     its member-harness slug from the repo name, but an owner who created the pot with a
     **custom slug** announces a different origin → the owner can never admit the joiner.
  2. **Attestation fetch is rate-limited (rig artifact + product gap).** The owner verifies
     the joiner's device↔GitHub binding via an **unauthenticated** `GET api.github.com/gists/<id>`
     — capped at 60/hr per egress IP. The shared-egress testnet has the budget exhausted
     (`remaining:0`) → 403 → `verifyBinding='pending'` → admission stalls → no mint → K0 stuck.
- **The cryptographic C-001 cut is already proven** independently (hermetic 88/88 + 150
  independent runs + live owner epoch-0 self-key minting ×3 on the binary). The live
  2-machine K0→K-CUT is gated ONLY by the transient rate-limit (resets 2026-06-23 03:22 UTC).

## The admission pipeline, layer by layer (live boot-history evidence)

For epoch keys to cross owner→joiner, the joiner must ADMIT the owner's pot-home announce
(FIX A) **and** the owner must ADMIT the joiner's member announce (to learn its identity →
open-mode `upsertHiveMember` → `grantEpochKeysToMembers` mints the new member's key). The
mint trigger lives in `boot.ts drainAdmissionQueue`, reached only via `admitPeer`, which is
gated by `announceSlugInScope` AND the identity decider (`revoked → bad_sig → verifyBinding`).

| Layer | fed-b (joiner) | fed-a (owner) | Verdict |
|---|---|---|---|
| substrate boot | `boot_ok` | `boot_ok` | ✅ (GAP-1 ruled out — boots eagerly) |
| peer connect | `peer_connected` | `peer_connected` | ✅ transport fine (socket L2) |
| **scope (FIX A)** | no `scope_unresolved` (was the pre-fix failure) | — | ✅ **FIX A works** |
| **scope (owner, slug)** | — | `scope_unresolved origin=git-consortium own=fixawitness-pot` → after slug-match: **resolved** | ✅ fixed by matching slug |
| **identity (attestation)** | `announce_pending` | `announce_pending` (verifyBinding=pending) | ⛔ rate-limited gist fetch |

(The `bad_sig key=5875e651/245c51b8` entries on fed-b are unrelated shared-swarm peers —
fed-a's device key is `e5c5b10d…`, not among them. Not fed-a's announce.)

## Finding 1 — custom pot slug silently breaks cross-machine federation

**Severity: medium (real, user-reachable).** `POST /api/harness/pots/from-repo` accepts a
`slug`. The joiner (`joinHiveAsView` → per-member `handleJoinLink`) derives its member-harness
slug from the link's `github=<owner/repo>` field (kebab repo name). Admission scope
(`announceSlugInScope`) compares the SIGNED origin-slug to the local harness slug. So if the
owner's member-harness slug ≠ the repo-derived slug (i.e. the owner chose a custom slug), the
owner's member harness never matches the joiner's origin → the owner holds the joiner's announce
`pending` forever → never `upsertHiveMember` → never mints the joiner's epoch key.

- **Live proof:** pot `fixawitness-pot` (owner member-harness `fixawitness`, joiner derives
  `git-consortium`) → permanent `scope_unresolved origin=git-consortium own=fixawitness-pot`.
  Re-running with slug = repo name (`hello-world` on both sides) **eliminated** the owner-side
  `scope_unresolved` (advanced to the attestation gate). So the asymmetry is the cause.
- **Why FIX A doesn't cover it:** FIX A rebinds the *joiner's* home to the (symmetric)
  pot-home slug for the OWNER→joiner direction. The joiner→owner direction has no rebind and
  rides the member-harness slug, which is asymmetric.
- **Recommended fix (needs owner steer — load-bearing):** key admission scope on a STABLE
  repo identity (`repo_id` / federation topic) instead of the local harness slug, so owner and
  joiner always agree regardless of local slug. (Or force the owner's member-harness slug to the
  repo-derived slug at pot creation.) Filed for steer; NOT edited.

## Finding 2 — attestation gist fetch is unauthenticated → 60/hr per IP

**Severity: medium (real production fragility).** `identity/attest.ts runVerification` fetches
`GET https://api.github.com/gists/<gistId>` with **no `Authorization` header**. Unauthenticated
GitHub API = 60 requests/hour/IP. On any deployment where many joins occur (or users share an
egress IP / NAT), the budget exhausts → `!resp.ok` → `github_api_unavailable` → `verifyBinding`
returns `'pending'` → admission silently stalls until the per-boot 30-min grace expires, then
rejects. Hard to diagnose (looks like "federation just doesn't work").

- **Live proof:** fed-a `api.github.com/rate_limit` → `limit:60 remaining:0 used:60
  reset:1782184932`; `GET /gists/<id>` → 403. (git *clone* over github.com still works — it's
  the API specifically.)
- **Recommended fix:** authenticate the verification fetch with the operator's GitHub token
  (5000/hr), with graceful unauth fallback. Small, isolated, high-value robustness fix.

## What is PROVEN vs blocked

- ✅ **Cryptographic cut (C-001):** epoch advances on member-removal; owner mints epoch N+1
  ONLY to remaining devices; removed device has no epoch N+1 key. Proven hermetic (88/88) +
  150 independent + live owner-minting ×3.
- ✅ **FIX A (federation scope, joiner side):** validated live on the binary.
- ✅ **Owner-side scope:** resolves once owner/joiner member slugs match (Finding 1 workaround).
- ⛔ **Live 2-machine K0→K-CUT:** gated ONLY by the transient unauth rate-limit (Finding 2).
  Auto-heals after reset (60s keepalive re-announce + 30-min admission grace) → completion
  scheduled just after 2026-06-23 03:22 UTC.

## RESULTS — live K-stage on the packaged binary (2026-06-23 ~03:25 UTC) — ALL GREEN

The rate-limit reset (03:22 UTC) and admission **auto-healed** (60s keepalive re-announce +
30-min grace): the owner verified the joiner's attestation gist (budget restored), admitted
fed-b, and minted + federated the keys. Device pubkeys: **owner `5cWxDYOf…`** (papercupai),
**joiner `VCe9HBZizf…`** (aviynw, fed-b).

| Stage | Evidence (both VMs) | Verdict |
|---|---|---|
| **K0** keys cross A→B | fed-a + fed-b both: `hive_members`=2 (verified); epoch-0 key for BOTH devices; `hive_settings` federated to fed-b | ✅ GREEN |
| **K1** joiner reads cur-epoch | fed-b holds epoch-0 key wrapped to its own device `VCe9…` | ✅ GREEN |
| **K-revoke** epoch advance | `POST /admin/substrate/revoke-contributor {hiveSlug, githubUserId:1567022}` → `{ok,revokedPubkeys:[VCe9…],live:true}`; epoch setting 0→**1**; owner re-keyed | ✅ GREEN |
| **K-CUT** read-cutoff | epoch-1 key minted **only** to owner `5cWxDYOf…`; **NO epoch-1 key for the revoked `VCe9…` on EITHER VM**; fed-b sees the epoch-1 row (owner-wrapped) but cannot unwrap it | ✅ GREEN |

**Cut semantics confirmed:** the cut is by **wrap-set**, not by withholding the row — fed-b
even *receives* the epoch-1 key row, but it is wrapped only to the owner's device pubkey, so
the revoked device is cryptographically unable to derive the epoch-1 content key. Epoch-0 keys
persist for both devices (correct: forward-only cut — the revoked member keeps pre-revocation
access, loses epoch-1+). This is the C-001 read-cutoff observed **cross-machine on the
FIX-A packaged binary** — the P-008 live witness.

(Minor data-model note, non-blocking: the revoked pubkey is recorded under the OWNER's member
row `revoked_pubkeys`, and the `aviynw` member row was not deleted — membership-row cleanup is
cosmetic; the cryptographic cut is via the revoked-set + wrap-set and holds. Worth a tidy-up
ticket but does not affect the guarantee.)

## papercusp-pot-rekey flag

Production flip is **owner-ratify** (security surface) — NOT self-flipped. The minting/cut is
proven; the live cross-machine witness completes after the rate-limit reset. Recommend the
owner ratify the flip on the green live K-CUT (or on the already-proven cryptographic cut +
validated federation-delivery path, owner's call).

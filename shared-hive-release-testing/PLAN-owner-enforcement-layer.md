# PLAN — Shared-Pot Owner-Enforcement Layer (the part-(c) gap)

**Slug:** `shared-pot-owner-enforcement-2026-06-19`
**Author:** su-9140a (lead). **Status:** draft for owner approval.
**Closes:** the deferred enforcement layer — `papercusp-dogfood-v5` Q-1 / D-023 ("richer
moderation deferred to Phase 12+"). The provisional→claimed ownership model is BUILT
(`binding-service.ts`, claim-status GUI); what's missing is the *control surface* a claimed
owner gets. This plan builds it.

## 1. Problem

A GitHub-verified claimed owner today gets a trust **badge** but **no lever**: they cannot
set any policy the shared pot must honor. For a PUBLIC launch, that means an untrusted
member can spam ops/content/PRs and the owner has no in-system response short of the
nuclear `supersede`. We need the owner to set **enforceable policy** — rate limits,
membership admission, contribution rules, and moderation — gated on `claim_status='claimed'`.

## 2. The hard part: enforcement in a P2P federated pot

This is NOT a server-authoritative app. Each peer runs its own substrate; a malicious peer
can ignore a policy *locally*. So "enforcement" must mean three things working together,
NOT a single server check:

1. **Owner-SIGNED policy, federated as authoritative state.** The policy is an
   owner-signed record that federates as `hive_settings` (the owner's pot-home is the
   federation unit — leans directly on the A-003 (a′) work just landed). Honest peers read
   the owner's signed policy; an unsigned/forged policy is rejected (the existing
   read-admission signature check).
2. **Admission-time enforcement on every HONEST peer.** Honest peers enforce the policy at
   their substrate **write/op admission** layer (rate-limit, membership, content rules)
   BEFORE merging a peer's op — so a violating op from a bad member is dropped by every
   honest peer, never becoming canonical. This is the same admission seam A-003's slug-filter
   + C's identity-admission already hook.
3. **Revocation-backed teeth (cryptographic).** A persistent violator is **revoked** by the
   owner → the **C-001 re-key** cuts their read/write at the next epoch. This is the
   ultimate enforcement: the bad actor is removed from the trust set, not just rate-limited.

**Honest-majority trust model (state it honestly, like the directory honesty work):** a
malicious peer CAN ignore policy on its own machine, but it CANNOT (a) make honest peers
accept its policy-violating ops, (b) forge the owner's signed policy, or (c) survive
revocation. The code plane is already owner-controlled (fork→PR; non-collaborators never
direct-push `main`). What we add is the CONTENT/MEMBERSHIP plane's policy teeth. Document
the residual: a clique of colluding malicious peers can maintain a divergent fork among
themselves — but that's true of any P2P system and they're cut from the owner's canonical pot.

## 3. Scope — what an owner can enforce (MVP → richer)

**MVP (launch-blocking IF the owner says enforcement is required):**
- **P-RATE — per-member rate limits.** Caps per `github_user_id`: ops/min, content
  rows/hour, PRs/day. (The v5 Q-1 deferred "rate-limit per github_user_id".) Default off;
  owner sets the caps. Enforced at write-admission on honest peers.
- **P-MEMBER — membership admission mode.** `open` (anyone joins) | `approval` (owner
  approves each joiner) | `allowlist` (owner pre-approves github logins). Enforced at the
  join/add-member path + the topic-admission.
- **P-MOD — moderation: report + takedown.** A `report` endpoint (the v5 Q-1 deferred "report
  endpoint") any member can call; an owner takedown that hides content + (for repeat abuse)
  triggers member revocation → C-001 re-key cut-off.

**Richer (fast-follow, non-launch-blocking):**
- **P-CONTRIB — contribution rules** on the fork→PR boundary: require review, required
  status checks, restrict auto-merge, restrict editable paths.
- **P-CONTENT — content rules**: max payload size (ties Brief Z), allowed content types,
  banned-pattern filter.
- **P-AUTOMOD — automated rate-trip → temp-mute** without manual owner action.

## 4. Architecture

```
 Owner (claimed)  ── sets policy ──▶  hive_policy (owner-SIGNED)  ──federates as hive_settings──▶  every member
        │                                                                                              │
        │ POST /api/pot/:id/policy (gated: claim_status='claimed' && viewer=claimant)                │
        ▼                                                                                              ▼
 policy-authoring surface (GUI)                                          each honest peer's ADMISSION layer enforces:
                                                                          • P-RATE → op rate-limiter (per github_user_id)
 report/takedown ──▶ revoke contributor ──▶ C-001 re-key epoch advance   • P-MEMBER → join/add-member gate
                                              (cuts the bad actor)        • P-MOD → takedown hides + repeat→revoke
```

- **Policy storage:** new `harness_shared.hive_policy` (owner-signed, federated): the policy
  JSON + owner pubkey signature + epoch/version + fed_hlc (mig-314 ordering, so a newer
  policy wins deterministically — leans on D-001). Mirrors the `hive_settings` projection
  pattern (the one A-003 (a′) just made federate).
- **Authoring authority:** reuse `binding-service` — only `claim_status==='claimed'` AND the
  viewer is a `claimed_by_github_user_ids` member (live GitHub maintain/admin re-check) can
  write policy. An `unclaimed` pot has NO enforceable policy (provisional owner can't lock
  it down — matches the design: claim is what grants authority).
- **Enforcement seam:** a new `policy-admission.ts` alongside `read-admission.ts` /
  `announceSlugInScope` in the substrate admission path. Every inbound op is checked against
  the current owner-signed policy before merge: rate-limit counter per author, membership
  check, moderation/takedown list. Reuses the same signed-frame + slug-scope plumbing.
- **Revocation teeth:** `P-MOD` takedown-for-repeat-abuse calls the existing
  `substrate:revoke_contributor` → the C-001 re-key advances the epoch → the abuser loses
  read+write. (This plan DEPENDS on the C-001 re-key landing.)

## 5. Dependencies / sequencing
- **Hard dep on A-003 (a′)** (just landed): hive_settings/policy must federate from the
  owner's pot-home to members. ✅ unblocked.
- **Hard dep on the C-001 re-key** (in build): P-MOD's revocation teeth + P-MEMBER removal
  need the epoch cut-off. Policy authoring + rate-limit + membership-admission can build in
  PARALLEL with the re-key; only the *revocation* leg waits for it.
- **Reuses:** `binding-service` (authority), `hive_settings` projection pattern (federation),
  mig-314 fed_hlc (policy ordering), the substrate admission seam (enforcement).

## 6. Decisions for the owner
- **D-1 (launch gate):** is the MVP (rate-limit + membership-mode + moderation) a
  PUBLIC-LAUNCH requirement, or ship claim-as-trust-signal first + enforcement as fast-follow?
  (This plan assumes "required" but is phased so the answer just sets the launch line.)
- **D-2 (default posture):** new public pot default = `open` membership + no rate caps
  (permissive, owner opts into strictness) OR `approval` + conservative caps (safe-by-default)?
  Recommend **safe-by-default** for a public launch (open invites spam).
- **D-3 (enforcement strictness):** honest-peer admission only (documented honest-majority),
  or also require the owner's pot-home to be the canonical merge authority (stronger, but
  centralizes + needs the owner online)? Recommend **honest-peer admission + revocation
  teeth** for v1 (P2P-native), document the trust boundary.

## 7. Phases (→ implementation briefs EN-1..EN-4)
- **EN-1 — Policy model + claim-gated authoring** (storage + signature + the `hive_policy`
  federated projection + the authoring API/GUI gated on claim). No enforcement yet.
- **EN-2 — Rate-limit enforcement (P-RATE)** at write-admission, per github_user_id.
- **EN-3 — Membership admission (P-MEMBER) + moderation (P-MOD)** incl. the report endpoint
  + takedown → revoke → re-key teeth.
- **EN-4 — Enforcement hardening + the honest-majority trust model** (the `policy-admission.ts`
  seam, adversarial tests that a bad peer's violations are dropped by honest peers, the
  documented trust boundary) + contribution-rule (P-CONTRIB) fast-follow.

## 8. Test posture (every phase)
Teeth-verified; the S0 properties: (a) only the verified claimed owner can write policy;
(b) an honest peer DROPS a policy-violating op from a member; (c) a revoked abuser is cut off
at the next epoch (re-key); (d) a forged/unsigned policy is rejected. Brief AK (this plan's
test lane) drives these once the layer lands.
```

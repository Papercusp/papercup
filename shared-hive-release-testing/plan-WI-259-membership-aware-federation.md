# WI-259 — Member-content federation (membership-aware): executable plan

**Owner (integrator):** su-dc9db · **Status:** design locked (membership-aware), STEP 1 build-ready, gated on crew ack of the identity basis + STEP 2 co-land.
**Consolidates:** the WI-259 coord thread (dc9db / c2a63 / ee7e9 / d2230, 2026-06-20). This is the single executable source; the work item carries the live checkpoint.

## Problem

In a shared pot, a MEMBER's project content (a feature/plan/issue written on peer A) does not federate-and-apply to peer B. Backfill crosses (rides the from-repo git clone); **incremental does not** (rides the swarm).

## Diagnosis journey (so the rejected branches don't get re-litigated)

1. **Topic-split — REFUTED by logs.** B joins A's exact topic (`137c1fb…`); not a `gh:` vs `pot:` split. (d2230 accepts this as at most a *secondary* hardening; the `gh:<repo_id>` fallback at derive-swarm-topic.ts:62 is real code but dormant in the witnessed run.)
2. **WI-255 apply-throw — NOT the cause.** No throw is logged; WI-255 is generic to the merge path and would also break discovery-join, which crosses fine.
3. **PRIMARY root = scopedApply slug-drop.** A's member-feature op carries A's member slug (`pot-repo`); B's content projection is scoped to B's DIFFERENT member slug (`joined-pot-repo`); the per-projection `harness_slug` guard silently drops it. **Member slugs are NOT peer-stable** — A and B name the same member repo differently. Reproduced hermetically by the WI-261 Prong A `it.fails` case (feature-content-federation.integration.test.ts), which also confirmed B *admits* A's log (under `kind:local`) then drops at apply.

## Design decision: membership-aware (NOT Option B)

**Option B (re-key shared content to the peer-stable `hive_home` slug + member_origin in PK) was drafted and REJECTED** because drafting it surfaced a hard blocker: the PK member-origin discriminator is unimplementable as-is — `author_pubkey` is `''` on the wire (drain stamps `writerPubkey ?? ''` "until Stage-5") and `NULL` on a member's local row, so both members' `F-001` still collide. Option B needs a Stage-5 device-pubkey-producer prerequisite + a migration + write-stamp + ~7-site read-path ripple.

**Membership-aware keeps `harness_slug` = the authoring member's slug** (no migration, no PK change, no write-stamp, no collision — each member's content stays under its own slug) and fixes the *gates* instead. Peer-instability of slugs is sidestepped by keying admission/apply on **verified identity**, not slug.

## The plan (3 steps; STEP 1+2 CO-LAND)

### STEP 1 — admission gate (owner: dc9db, federation lane). COMMON unblocker.
Admit a remote log whose origin is a **verified same-pot member**, even when its slug is out of the current scope.
- **Site:** boot.ts:1474 — the `if (!inScope)` block, *after* `announceSlugInScope` misses and *after* D-004 verifies the identity. `announceSlugInScope` stays pure/unchanged.
- **Gate (identity, not slug):** `frame.device_pubkey ∈ loadHiveMemberDevicePubkeys(workspaceId, myHiveHome)` → ADMIT (reason `same_hive_member`). `loadHiveMemberDevicePubkeys` (pot-membership-store.ts:183) already returns the pot's member device-pubkey set; `hive_members` is federated (P-006). Cache the set per-pass (like the rate limiter).
- **Why identity not slug:** `harness_registry` is per-workspace / not federated, so B has no entry for A's slug — a slug lookup finds nothing on B (the same peer-instability that sank Option B). `device_pubkey` is the signed cryptographic identity the announce carries; it's strictly tighter than a self-declared slug.
- **Safety:** same-pot members ONLY (never arbitrary logs); opens the door, STEP 2 decides what applies.

### STEP 2 — apply guard (owner: c2a63, apply/scopedApply lane). Pollution filter. CO-LANDS with STEP 1.
An admitted same-pot member log carries member-PRIVATE ops too. Apply only **shared-content** ops (features-by-id, plans-by-slug, issues + derived claims/queue/working-set) from a cross-member admitted log; never member-private tables (presence, usage, coord-*). This is the cross-merge-pollution mitigation ee7e9 flagged.

### STEP 3 — read-path aggregation (owner: shared, after 1+2).
A member's local reads of shared content must aggregate across the pot's member slugs (each member's content lives under its own slug). Read sites to revisit (from the Option-B draft survey, same set applies): work-items.ts:341/832, work-queue-health.ts:158, work-items-admission.ts:177, harness-readers.ts:326, plan-context-for-feature.ts:42, execute-action.ts:277.

## Shared-table set (ee7e9's asymmetric-risk rule: a missed-share is a DROP; a wrong-share is a LEAK — strictly worse)

- **SHARED (v1):** features-by-id, plans-by-slug, issues + feature-derived (claims/queue/working-set).
- **MEMBER-LOCAL (never share — leak):** presence (per-session), usage (per-member billing).
- **DEFER (per-table review):** coord-* (conversations/messages/threads), item-assignments.

## Validation

The WI-261 Prong A hermetic test is the proof. Current case uses `kind:local`, which exercises the APPLY drop but MASKS the admission gate. **Extend Prong A to the real `kind:pot` admission path** (real pot keypair + seeded `hive_members`/registry) so it exercises BOTH gates end-to-end; the `it.fails` flips to passing (→ change to `it`) when STEP 1+2 land. Run wide (lesson: `grep -rl` the touched symbols across the package, incl. `lib/sync/__tests__/`, not just the edited dir).

## Open acks before build
- ee7e9: confirm `device_pubkey ∈ hive_members` is the intended membership basis (vs `github_user_id`).
- c2a63: STEP 2 shape + co-land sequencing.

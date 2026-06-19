# Brief I — A-003: hive_members / hive_settings don't reach a joiner (+ revocation)

**Priority: S1 → S0 lane** (compounds revocation). Substrate + integration + a live
witness on the running pair.

## Objective
Make `hive_members` + `hive_settings` **federate to a joiner**, teeth-verify the
crossing on the **real joiner-resolves-own-topic path** (the rigs bypass it), and
confirm the **revocation admission union now reaches joiners**. Live-witness it on
the pair.

## Why it matters for release
A-003 was **re-reproduced live this session** (2026-06-19): `hive-settings`
(outbox 3–4) and `hive-members` (outbox 1) never cross to the joiner — in backfill
AND both incremental directions. The outbox IS populated (capture works), the
joiner just never applies. Beyond stale member-list/settings, this **breaks member
revocation for joiners**: the revoke-member action writes
`hive_members.revoked_pubkeys` (`hive-revoke-contributor.ts:8`), and the joiner's
admission union reads it (`boot.ts:586` `loadRevokedHivePubkeys` ← `hive_members`).
If `hive_members` never reaches the joiner, the joiner's revoked-set is ∅ → it keeps
admitting a revoked member's writes. Combined with C-001 (Brief K) revocation is
broken on **both planes** for joiners.

## Root cause (pinned — EI-1591 post 46430, su-963ee)
The `hive_members`/`hive_settings` projection guard
(`hive-members.ts:94` `if (row.hive_home_slug !== opts.harnessSlug) return`) only
applies an op when the projection's bound slug == the op's `hive_home_slug`.
`register-all.ts` builds these projections with the **booted harness slug**; a
joiner boots the **member** harness, not the hive-home, so every hive-home-scoped
op is dropped. The joiner never wires a hive-home-scoped apply ("MULTI-SWARM ONLY
by design" — but the design then can't deliver member revocation to joined peers).

## Scope / scenarios
1. **Fix (pick one, justify):** (a) wire a **hive-home-scoped**
   `hive_members`/`hive_settings` projection-apply on join (general — both tables
   reach the joiner), OR (b) route **member-revocation** through the member-scoped
   `contributors` log-first seam that already federates (revocation-only, narrower).
2. **Teeth-verified crossing test** on the joiner path: a `hive_members` /
   `hive_settings` op written by the owner lands on a joiner that booted the
   **member** harness (not a rig that pre-wires matching topics). RED before fix.
3. **Revocation propagation test:** owner revokes member M
   (`hive_members.revoked_pubkeys`) → the joiner's admission union now contains M →
   the joiner **rejects** M's subsequent writes. (Read-cutoff is Brief K.)
4. **Live witness:** on the running pair, after the fix, `hive-settings` /
   `hive-members` cross to B (`origin=remote`) — the inverse of today's RED line.

## Method
- Integration (`vitest.integration.config.ts`) for the crossing + revocation tests;
  the live witness via the smoke pair's embedded PG. Mind the column-drift guard
  (`federated-column-completeness.integration.test.ts`) when touching mappers.

## Deliverables
- `findings-I.md`: chosen fix + rationale, the crossing/revocation tests, live witness.
- The fix + permanent regression tests on the joiner path.

## Done / verdict
GREEN only when `hive_members` + `hive_settings` cross to a real joiner (live +
integration) and a revoked member is rejected by a joiner's admission union.

# Brief EN-3 — Owner-enforcement: membership admission (P-MEMBER) + moderation (P-MOD)

**Implementation brief.** Plan: `PLAN-owner-enforcement-layer.md` (Phase EN-3). Depends on
EN-1 (policy) + the **C-001 re-key** (for the revocation teeth — the membership-removal +
takedown-for-repeat-abuse legs). The authority-with-teeth phase.

## Build
### P-MEMBER — membership admission mode
1. **Three modes** from `hive_policy.membership`: `open` (anyone joins — today's behavior),
   `approval` (owner approves each joiner before they're admitted to the topic/trust set),
   `allowlist` (owner pre-approves github logins; only listed users join).
2. **Enforcement** at the join / add-member path + topic admission: under `approval`, a
   joiner enters a `pending` state (federated request to the owner) and is NOT trust-admitted
   until the owner approves; under `allowlist`, a non-listed joiner is refused. Reuse the
   `hive:add-member` / join path + the trust registry (`trust_add`).
3. **Owner approve/deny surface** (GUI + API) gated on claimed-owner authority (EN-1).

### P-MOD — moderation: report + takedown
4. **Report endpoint** (the v5 Q-1 deferred "report endpoint"): any member can `report`
   content/member; reports federate to the owner; the owner sees a moderation queue.
5. **Takedown**: the owner hides reported content (a federated tombstone the projection
   honors — ties Brief Z tombstones); for **repeat abuse**, the owner removes/bans the member
   → calls `substrate:revoke_contributor` → the **C-001 re-key advances the epoch → the
   abuser loses read+write** (the ultimate teeth). 
6. **Ban persistence**: a banned github_user_id can't re-join (allowlist-deny + re-key cut-off
   compose so they can't rejoin under the same identity).

## Depends on / reuses
- EN-1 (policy + authority gate). **C-001 re-key** (revocation epoch cut-off) — the
  removal/ban legs are GATED on it; the approval/allowlist admission legs can build ahead.
- `trust_add`/`substrate:revoke_contributor`, the add-member/join path, Brief Z tombstones.

## Tests (teeth-verified)
- `approval`: a joiner stays pending until owner-approved; denied joiner never trust-admitted.
- `allowlist`: listed user joins; non-listed refused (teeth: neuter the allowlist check → RED).
- S0 — owner removes/bans a member → the re-key epoch advances → the banned member can no
  longer read NEW content NOR write accepted ops (compose with the C-001 cut-off witness);
  a banned id cannot re-join.
- Report→takedown: reported content is hidden on all honest peers (federated tombstone, no
  resurrection — ties Brief Z); the report queue reaches the owner.
- Default (`open`, no moderation policy): today's behavior, unchanged.

## Done
GREEN when an owner can gate membership (approval/allowlist), and moderation has REAL teeth —
a banned member is cut off via the re-key + can't rejoin, takedowns federate without
resurrection — all gated on verified claimed-owner authority.

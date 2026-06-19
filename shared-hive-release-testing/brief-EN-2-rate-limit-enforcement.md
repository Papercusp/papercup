# Brief EN-2 — Owner-enforcement: per-member rate limits (P-RATE)

**Implementation brief.** Plan: `PLAN-owner-enforcement-layer.md` (Phase EN-2, the deferred
v5 Q-1 "rate-limit per github_user_id"). Depends on EN-1 (the policy record). The first
ENFORCEMENT teeth.

## Build
1. **Per-member op rate-limiter at write-admission.** A counter keyed by
   `(hive, author_github_user_id)` over sliding windows: `opsPerMin`, content `rowsPerHour`,
   `prsPerDay` (from `hive_policy.rate`). Enforced in the substrate **write/op admission**
   path (the seam C's identity-admission + A-003's slug-filter already hook) on EVERY honest
   peer: an op from a member over their cap is DROPPED (not merged), with a conclusive,
   non-telemetry-spamming reason (mirror `out_of_scope` from the slug-filter).
2. **Author attribution.** The limiter needs the op's author github identity — derive from
   the op's signing identity → the member's `github_user_id` (via the contributor/trust
   registry). Ops with no resolvable author under a non-`open` policy fail closed.
3. **Honest-peer semantics.** Because each honest peer enforces independently, a bad member
   flooding ops is dropped by all honest peers → the flood never becomes canonical. Document
   that a malicious peer can't bypass this on honest peers (the plan's trust model).
4. **Observability.** Surface per-member rate state (current counts vs caps) so the owner GUI
   (EN-1 panel) can show "member X at N/cap" — coordinate with the EI-1618 drain-health
   surface pattern (a degraded/throttled signal, honest not hidden).

## Depends on / reuses
- EN-1 (`hive_policy.rate`). The substrate admission seam (read-admission / policy-admission).
- The contributor/trust registry (author→github_user_id). mig-314 (window timestamps; note:
  Date.now is unavailable in some paths — use the substrate clock seam).

## Tests (teeth-verified)
- A member under cap: ops apply. Over cap: ops DROPPED on every honest peer; the honest
  members stay converged WITHOUT the flood (teeth: neuter the counter → flood applies = RED).
- Default (no rate policy): no limiting, zero behavior change.
- Adversarial: a malicious peer floods → assert honest peers drop the excess + don't OOM
  (ties Brief W/X); the flooder's legit-rate ops still apply (no total ban from rate-limit).
- Window correctness: the sliding window resets correctly; no off-by-one at the boundary.

## Done
GREEN when an owner-set per-member rate cap causes honest peers to drop over-cap ops (member
can't spam the canonical hive), with no effect when no policy is set, proven under an
adversarial flood.

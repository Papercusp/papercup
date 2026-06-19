# Brief EN-4 — Owner-enforcement: enforcement seam hardening + honest-majority trust model

**Implementation brief.** Plan: `PLAN-owner-enforcement-layer.md` (Phase EN-4). Depends on
EN-1/EN-2/EN-3. Consolidates the enforcement into one auditable seam, proves the trust
boundary adversarially, and adds the contribution-rule fast-follow. The "is it actually
safe" phase.

## Build
1. **`policy-admission.ts` — one enforcement seam.** Consolidate EN-2 (rate) + EN-3
   (membership) + moderation checks into a single admission module beside `read-admission.ts`
   / `announceSlugInScope`, called on every inbound op before merge. One place to read the
   current owner-signed policy + apply ALL checks (rate, membership, takedown-list). Auditable,
   testable, hard to bypass-by-omission.
2. **P-CONTRIB — contribution rules (fast-follow)** on the fork→PR boundary: owner policy for
   require-review / required-status-checks / restrict-auto-merge / editable-path allowlist.
   Wire into the existing `open-fork-pr` / `fork-pr-on-feature-pass` path (the code plane is
   already owner-controlled; this lets the owner SET the rules).
3. **P-CONTENT (optional)** — max payload size / allowed types / banned-pattern, enforced in
   policy-admission (ties Brief Z payload edges).
4. **Honest-majority trust model — documented + enforced boundary.** Write the canonical
   statement (a `agent-insights/` MDX or the plan's trust section): what an owner policy DOES
   guarantee (honest peers drop violations; forged policy rejected; revocation cuts abusers)
   and what it does NOT (a colluding malicious clique can maintain a divergent fork among
   themselves — but they're cut from the owner's canonical hive + repo). No silent
   over-claiming (the honesty discipline from Brief G).

## Depends on / reuses
- EN-1/2/3. The substrate admission seam. The fork→PR path (`open-fork-pr.ts`). C-001 re-key.

## Tests (teeth-verified — the S0 trust properties)
- **Adversarial:** a malicious peer that LOCALLY ignores policy (floods / admits a banned
  member / writes over-cap) → assert EVERY honest peer DROPS its violating ops, the honest
  set stays converged + policy-correct, and the malicious peer is revoked → cut off. (The
  core public-safety claim.)
- Forged policy / replayed old policy_version → rejected (sig + fed_hlc order).
- P-CONTRIB: an owner "require-review" policy blocks auto-merge of a fork-PR; an editable-path
  rule rejects an out-of-bounds change.
- Trust-boundary doc matches behavior (the documented NOT-guarantees are actually the
  observed limits — no over-claim).

## Done
GREEN when all enforcement flows through one audited seam, an adversarial peer's policy
violations are provably dropped by honest peers + the peer revoked, contribution rules apply
on the PR boundary, and the honest-majority trust boundary is documented to MATCH the
behavior (no over-claim). This phase's GREEN = the owner-enforcement layer is public-safe.

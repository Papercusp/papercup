# Brief PR-4 — WI↔PR producer + per-operator identity (explicit)

**Implementation brief.** Plan: `PLAN-pr-system-completion-dogfood.md` (Phase PR-4). Closes
two gaps the owner decided on: (b) build the WI↔PR producer; (c) make identity explicitly
per-operator. Independent of PR-2/3 (PR-1 consumes its outputs). Start now.

## Build
### (b) WI↔PR producer — track WI/feature → PR → state → merged
1. **Write `harness_feature_prs` at PR-open.** The `fork-pr-on-feature-pass` hook (and the
   manual contribute path) UPSERT a row `(workspace_id, harness_slug, feature_id) → pr_url,
   pr_state='open', review_decision=null, author_github_user_id, created_at`. (Table exists at
   schema.ts:3787; it just had no producer.) The PR title/body already carry `${featureId}` —
   resolve it to the row.
2. **Update on review/merge.** PR-1's daemon updates `pr_state` / `review_decision` /
   `checks_state`; on merge, `resolveMergedPrFeatureId` resolves from this row (not the empty
   fallback) → `stampCompletionRefOnMerge` stamps `completion_ref` + feature `status='shipped'`.
3. **Federate it** if members need PR visibility (mirror a projection; or keep local + surface
   via the report GUI) — decide per the federation cost (coordinate; default LOCAL + GUI-served).

### (c) Per-operator identity, explicit + attributable
4. **Make identity explicit.** Confirm/centralize that `ensure-fork`/`open-fork-pr`/review/merge
   resolve the operator's `gh` identity (`identity/gh-token.ts`) — and record the resolved
   `github_user_id` on `harness_feature_prs` + `auto_review_audit` so every PR/review is
   attributed to the HUMAN operator (not a generic host token).
5. **Agent-authored trailer.** When a Cup opens the PR, append a `Co-authored-by: papercusp-cup
   <…>` trailer (+ a body marker) so agent-driven vs hand-authored is visible — the ACCOUNT stays
   the human; only agency is marked.
6. **Rate-limit attribution hook.** Expose the per-operator `github_user_id` as the key the
   owner-enforcement P-RATE (EN-2) limits on — one human = one bucket (anti-spam granularity).

## Reuses
- `harness_feature_prs` / `auto_review_audit` (schema), `fork-pr-on-feature-pass.ts`,
  `completion-ref-writer.ts` (`resolveMergedPrFeatureId`/`stampCompletionRefOnMerge`),
  `identity/gh-token.ts` / `octokit-client.ts`.

## Tests (teeth-verified)
- Open a fork→PR → `harness_feature_prs` row created with the WI + author; merge → completion_ref
  stamped + feature shipped via the row (not the empty fallback) — teeth: neuter the producer →
  merge can't resolve the feature = RED.
- Identity: the recorded `github_user_id` is the operator's; an agent-opened PR carries the trailer.
- The WI→PR→merged status is queryable for the report GUI.

## Done
GREEN when every fork→PR is tracked WI→PR→merged with the producer, completion stamps via the
real row, and each PR/review is attributed to the human operator (agent-authored marked) — the
planes linked + identity explicit.

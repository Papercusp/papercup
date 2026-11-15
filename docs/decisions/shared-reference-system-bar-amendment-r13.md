# shared-reference-system acceptance bars — revision 13

Rubric: `shared-reference-system-acceptance`. Subject plan: `shared-reference-system-2026-11-13`.
Prior bar set: `e37b891e8172…` (revision 12). Applied: receipt
`srs-acceptance-rev13-20261115-apply1` committed 2026-11-15T10:43Z; plan Decision D-027
recorded automatically; plan now at version 91.
Outside-lineage pre-apply review: requested 2026-11-15T10:33Z via `rubrics:amend { dryRun:true,
requestReview }`, receipt `review-998a82c939b7…`. Fresh reviewer su-792e640e (task
0mwhp8wepazhadkrzwm) approved preview `thread-post:1230671` in `thread-post:1230690`
(10:41Z). Both rev-12 consults were closed as answered (posts 1230697, 1230698).

## Why

Two independent bar critiques of revision 12 both returned OBJECT. `rubrics:check-approver`
confirmed each responder as eligible:

- `conv-request-42071131…`, `thread-post:1230634` (su-95f2c506): one blocker (R-12) and two
  advisories (R-4, R-13).
- `conv-request-b499b8c6…`, `thread-post:1230643`: two blockers (R-4, R-13).

Both critiques approved R-3, R-19 and R-32, so those bars are unchanged.

## Findings and dispositions

| Finding | Source | Disposition |
|---|---|---|
| R-12's method and falsifier made only *missing or truncated* live run records unknown. The amendment intent also covers *unpinned* records, so a grader could rate an unpinned row broken. | critique 1, blocker | **Accepted.** The method now names missing, truncated or unpinned records. It defines unpinned as a recorded check or query hash that does not match P-013's pre-landing pin. Such a row rates unknown, never healthy or broken, and R-12 stays unknown until the row has a pinned, complete record. The falsifier matches. |
| Critique 2 approved R-12 and said its falsifier already covers unpinned records. | critique 2 | **Not accepted as evidence.** The revision-12 falsifier text reads "rated healthy while its live run record is missing or truncated". It does not cover unpinned records, so critique 1's blocker stands. |
| R-4 did not state "no product cap on item size or part count" or "no part boundary inside an identifier". An implementation with a hard maximum above 3N, or one that splits an identifier, could pass. | critique 2, blocker 1 | **Accepted.** Both guarantees are now in the bar and the falsifier. The method tests every reported byte limit and part-count limit at N-1/N/N+1, places a complete identifier across each candidate boundary, and asserts that a physical or security limit yields more parts, never a cut. |
| R-4's boundary cases could all place the decisive record in the body. | critique 1, advisory | **Accepted.** The decisive record now sits past a boundary at least once in each of the body, a comment and the latest checkpoint. |
| R-13 bound N to the transport limit only and did not protect identifiers. | critique 2, blocker 2 | **Accepted.** N now ranges over every reported byte limit (transport, part body, result door, context injection), every part-count limit and every per-window message-count limit. The decisive message sits past each boundary, the 25-message burst repeats in three send orders, and no part boundary may split an identifier. |
| R-13's "delivery window" could be read as a fixed wall-clock or context frame. | critique 1, advisory | **Accepted.** It is now defined as the logical delivery episode the system continues automatically. |

The outcome strength and evidence planes do not change: tree for R-4 and R-13, and live
(release-operator) for R-12.

## After the apply

1. Regenerate the AUTO-BAR clauses for R-4, R-12 and R-13 so that each `sourceBar.barHash`
   matches its revision-13 criterion hash. The other 36 clauses keep their pins, which record
   provenance, not currency.
2. Re-run the spec-quality card, the grading audit, and the discovery and activation audits.
3. Open two fresh, parallel bar critiques of revision 13. The second excludes the first
   responder.

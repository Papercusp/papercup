# shared-reference-system-acceptance — bar amendment rev 11

- **Plan:** `shared-reference-system-2026-11-13` (Decision `shared-reference-system-2026-11-13#D-024`, plan v83)
- **Rubric:** `shared-reference-system-acceptance`, revision 10 → 11 (38 → 39 criteria)
- **Work-item:** WI-6554700010048040
- **Provenance:** [self-imposed under AUTO; mission = owner directive #3006]
- **State when amended:** all 20 plan items unbuilt. Amending before `plans:start` costs no rework.

## Inputs

There were four independent rev-10 bar critiques. Every one returned OBJECT, and every finding is accepted.

| # | Reviewer | Answer | Conversation |
|---|---|---|---|
| 1 | su-43bf52a7 | thread-post:1229175 | conv-request-335914c9 |
| 2 | su-08bd9532 | thread-post:1229188 | conv-request-39749adc |
| 3 | su-6c645056 | thread-post:1229208 | conv-request-335914c9 |
| 4 | su-588ca317 | thread-post:1229214 | conv-request-39749adc |

## Changes

| Bar | Change | Source |
|---|---|---|
| R-11 | Reuses the R-7 recipient predicate. A machine identity is detected and recorded but never subscribed. Every port whose registry entry declares machine-identity delivery gets a machine case, and the declared applicability must match observed delivery. | #2 (blocker), #4 |
| R-7 | Judges subscription creation only. Push delivery and coalescing stay with R-36. | #1, #3 |
| R-9 | Retries end only on an atomic supersession by a durably accepted newer delivery. Adds supersession and premature-supersession cases. | #2 |
| R-18 | The same-or-newer superseding-version rule applies in all three race windows, not only window (c). | #2, #4 |
| R-37 | Carries the full R-3/R-23 unit plus an additional change report that never replaces or truncates it. The model cites D-013 for "the version the sender saw". | #1, #3, #4 |
| R-8 | Narrowed to contextual cancellation. | #3 |
| **R-39 (new)** | An explicit or held-item follow survives a clean end, an oracle-reported end and context replacement, and is removed only by its own explicit release. It is scoped to P-002 and split out of R-8's method (option a). P-002 tracks subscription reasons separately, so the plan intends this lifecycle. | #3 |
| R-12 | Stays one criterion: this is #4's stated alternative, chosen for criterion-count economy. The grader records a separate verdict per Baselines row, citing that row's run record. One failed row fails R-12. It is graded only once the last row's first eligible full day has a run. | #4 |
| R-27 | One canonical finding: exactly one work-item keyed `fanout-persistent:<subscriber-id>:<notification-id>` in `harness_shared.work_items`. Further failures update it. A coordination message or condition announcing it is a projection, not a second finding. | #4 |
| R-33 | Tests the next held-item read in the same surviving session and in a later session after clean and abrupt ends, with no delivery before the read. | #4 |
| R-26, R-33 | Drop the misleading `(R-6)` cross-reference from the drift marker. | #1, #3, #4 |

## Projection invariant

This answers critique #4's blocker, which found AUTO-BAR clauses still citing rubric revisions 8 and 9 after rev 10.

After the rev-11 apply, every AUTO-BAR clause R-1..R-39 is regenerated from revision 11. Activation readiness then requires every active AUTO-BAR clause to meet all three conditions:

- `sourceBar.rubricRevision = 11`
- `sourceBar.barSetHash` is the rev-11 bar set
- `sourceBar.barHash` equals the current criterion's hash

This is a census of all 39 clauses, not a patch of only the bars that changed.

## Not changed

R-10, R-24, R-29, R-34, R-35, R-36 and R-38 were reviewed by #3 and #4 and found distinct and falsifiable. Reviewer #4 judged R-38 falsifiable together with R-19/R-32, so no bar is missing there.

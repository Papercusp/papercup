# Shared reference system — acceptance bar amendment (rubric rev 9)

Evidence record for plan `shared-reference-system-2026-11-13`, Discovery finding F-6,
decision `shared-reference-system-2026-11-13#D-019`.
Tracked work: WI-6554700010048040.

## What happened

- Rubric `shared-reference-system-acceptance` rev 8 (receipt amend-8aa237685395d9a5d904a849,
  subject plan revision 63) received two independent outside-lineage bar critiques:
  critique A (thread-post:1227697 and thread-post:1227711, 21 findings F1 to F21) and
  critique B (thread-post:1227716, consult conv-request-5cb04ec7). Pre-start spec-quality review
  also failed `atomic-observable-behavior` on R-9, R-10 and R-15.
- Every finding was dispositioned in one place (thread-post:1227745 on WI-6554700010048040).
  All of critique A was accepted. Critique B's revision-pin finding was resolved by measurement
  (rev 8 `barContract.subjectPlanRevision` = 63, and all 19 requirement blocks were equal at v63).
  Every other critique B finding was accepted.
- Rev 9 patches 19 existing bars and adds 13 new ones (R-20 to R-32). Every bar is one sentence
  with one subject and no semicolons, so each one states a single observable behaviour.
  The rulings that the critiques forced are recorded in D-019.
- All 20 plan items were still unbuilt, so amending before start cost nothing extra. This
  follows the D-016 precedent: amend meaning-changing gaps before start, not at completion.

## Rulings (D-019)

1. References inside a unit attached to a delivered message do not subscribe the recipient
   (R-7). This is consistent with R-3's no-transitive-expansion rule and keeps Baselines rows 5
   and 6 bounded.
2. The query behind each Baselines row (R-12) and the R-19 churn population is pinned (text plus
   sha256) in a plan Decision before its step lands. A positive control must reproduce the
   recorded figure within 2 percentage points, or 5% relative for counts. Source report
   rpt_b347c3bf holds no SQL (measured: 0 SELECTs), so the queries cannot be pinned now.
3. A step lands on the first full UTC day after its code is serving on the deployed operator.
   R-12, R-19 and R-32 declare `evidenceRuntime: release-operator`.
4. Baselines rows 1 to 7 meet target when they beat the baseline by more than the max-min spread
   of the same pinned query over the 7 full days before landing. Rows 5 and 6 are normalised per
   active agent-session. Row 8 is an absolute recall of at least 95%, measured on a hand-labelled
   sample of at least 200 pinned by hash.
5. R-29 caps reference detection at 50 ms p95 added to a tool result. This is an agent-set
   default, not an owner figure, and is revisable with measured evidence through an amendment.
6. R-28 is graded against the owner's D-008 choice in force at grading time.
7. A change committed during fan-out or refresh for the same reference moves from R-10 to R-18
   window (c). R-10 keeps only crash and restart durability.
8. At completion the as-built amendment switches each tree-plane bar to
   `check { kind: 'tests', files }` naming the landed test files, and records the
   mutation-probe receipts the bars require.

## New bars in rev 9

| bar | source | behaviour |
|---|---|---|
| R-20 | A F6 | an emission that reaches a recipient's context is recorded as confirmed by the recipient's next input |
| R-21 | B R-5-explicit-read | an explicit read that opts out of unchanged markers returns the full unit |
| R-22 | B R-6-condition-narrow | a sender receipt reports exactly the parts changed since the version in the sender's context epoch |
| R-23 | B R-6-condition-narrow | a delivered message reports exactly the parts changed since the version in the recipient's context epoch |
| R-24 | B R-9-delivered-defined | a fan-out notification is marked delivered only after it is delivered |
| R-25 | atomic split of R-9 | contextual-subscription retries stop when the subscriber's session ends |
| R-26 | atomic split of R-9 | a failed explicit or held-item follow notification is delivered at the follower's next session or point of use |
| R-27 | A F9 | a notification still failing after `FANOUT_MAX_ATTEMPTS` (outbox-drain.ts, value 8) raises a visible finding while retries continue |
| R-28 | A F12 | a tool result attaches cited units only for references in prose fields (D-008) |
| R-29 | A F12 | reference detection adds at most 50 ms p95 on the P-012 fixture set |
| R-30 | A F16 (R-15 split) | a pinned-reference delivery whose source changed after the pinned revision carries a note |
| R-31 | A F16 (R-15 split) | a pinned-reference delivery whose history was purged carries a stated absence naming the purge |
| R-32 | A F8, B R-19-gameable-count | each pinned churn item records at most 34 claim and release operations in the claim ledger |

## Review

The rev-9 amendment was previewed as a dry run and routed for outside-lineage pre-apply review
(consult conv-mwg37bhm-0000-5442c07c7d7a4d739dfb9d5e77ec40bb, preview thread-post:1227786).
The approval reference and amendment receipt are recorded in the auto-generated plan
Decision that `rubrics:amend` writes when it applies.

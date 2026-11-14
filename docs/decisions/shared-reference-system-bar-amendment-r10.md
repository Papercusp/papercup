# Shared reference system — acceptance bar amendment (rubric rev 10)

Evidence record for plan `shared-reference-system-2026-11-13`, decision
`shared-reference-system-2026-11-13#D-022`. Model and predecessor:
[rev 9](shared-reference-system-bar-amendment-r9.md) (D-019).
Tracked work: WI-6554700010048040.

## What happened

- Rubric `shared-reference-system-acceptance` rev 9 received two independent
  outside-lineage bar critiques, and both returned OBJECT:
  - **r2**: su-7e0d59c4, consult `conv-request-94d8578a…`, answer thread-post:1228692,
    10 findings.
  - **r3**: su-25fc528d, consult `conv-request-2552608b…`, answer thread-post:1228714,
    close thread-post:1228722, 5 findings.
- Every finding was accepted. Rev 10 changes 10 existing bars (R-7, R-8, R-9, R-10, R-18,
  R-24, R-25, R-26, R-27, R-29) and adds 6 (R-33 to R-38), for 38 criteria in total.
- Every changed or new bar has a requirement block in the plan's `## Requirements` and a row
  in the bar-to-work map. These were pushed with `plans:set-content` before the amendment,
  because `rubrics:amend` refuses a bar without a live discharge mapping. Each bar is one
  assertion with no semicolon (`acceptance_bar_non_atomic_projection`).
- All 20 plan items were still unbuilt, so, as with D-016 and D-019, amending before start
  cost nothing extra.
- Dry-run preview: thread-post:1228783. The router found no eligible reviewer, so
  `system:acceptance-bar-amendment-review` launched a fresh outside-lineage reviewer
  (su-4125b63f, label `bar-amendment-review:4346c69d8e09`). Its answer arrives as a comment
  on WI-6554700010048040.

## Resubmission after the pre-apply review

- The first pre-apply reviewer, su-4125b63f, returned OBJECT in thread-post:1228833.
  - **Blocking:** the bars cited `shared-reference-system-2026-11-13#D-022`, but that
    Decision was not yet recorded in the pinned plan copy.
  - **Non-blocking:** R-38's "claim cycle" had no floor, so a judge item could be reclaimed
    after an arbitrarily short cycle.
- Both were fixed before resubmitting:
  - D-022 was recorded with `plans:add-decision` (plan v78).
  - R-38's requirement block (plan v77) now says a claim cycle is never shorter than one
    `LIFECYCLE_JUDGE_INTERVAL_MS` judge interval, which is 60 minutes
    (`packages/operator-core/lib/task-manager/lifecycle-judgement.ts:36`). The amendment
    payload carries the same floor.
- The first resubmission dry run failed server-side on a Postgres statement timeout (57014),
  so the retry used a new idempotency key. The retry (receipt `review-52489ae8…`) posted
  preview thread-post:1228901, with `proposedPatchHash` `93ba9de6…` and subject plan revision
  74 → 79. That post contains D-022 and the R-38 floor.
- No router-eligible reviewer was free again, so a second fresh outside-lineage reviewer was
  launched: su-755dd078, label `bar-amendment-review:80539679357b`.
- su-755dd078 approved in thread-post:1228954 (`approve thread-post:1228901`). Its verified
  source hash `8f92fb6e…` matches the preview's `reviewSourceHash`.
- Applied on 2026-11-14 with `approvalRef` thread-post:1228954 and idempotency key
  `srs-acceptance-rev10-20261114b-apply1`. The call passed its foreground deadline and
  finished server-side; `rubrics:amend-status` reported `committed`, `ok: true` at about
  18:27Z. The rubric is active with 38 criteria.
- Lesson: the pre-apply reviewer checks that every plan Decision a bar cites already exists in
  the pinned plan copy. Record the Decision before the amendment dry run, not after apply.

## Finding → bar map

| finding | severity | disposition |
|---|---|---|
| r2 #1, r3 #1 | BLOCKER | R-7 contradicted D-019 #1 and R-11. It now covers only references delivered directly into a non-machine agent context, and nested references inside an attached unit stay with R-11. |
| r2 #2 | MAJOR | P-003 retry deduplication had no bar. New **R-35**: retries never redeliver. Dedup moves out of R-9. |
| r2 #3 | MAJOR | P-011 coalescing had no bar. New **R-36**: pushed changes coalesce to the newest version. |
| r2 #4 | MAJOR | P-010's sender-to-delivery delta was not stated. New **R-37**: changes since the version the sender saw. It applies only to a recipient with no earlier emission, so it does not contradict R-23. |
| r2 #5 | MAJOR | P-020's causal invariant was not caught by aggregate R-19/R-32. New **R-38**: no same-cycle reclaim of an unprogressable Judge item. It is a tree-plane integration bar. P-020 must record its root cause and its definition of a claim cycle in a plan Decision before it lands. |
| r2 #6 | MAJOR | R-18 bundled two behaviours. R-18 keeps no-gap delivery in every race window, and late-receipt coverage moves to new **R-34**. |
| r2 #7, r3 #3 | MAJOR | R-26 left "next session or point of use" as an unbound either/or. Explicit follow keeps R-26 and is delivered at the next session's first input. Held-item follow moves to new **R-33** and is delivered on the next read of the held item. |
| r3 #2 | MAJOR | R-10 still bundled several behaviours despite D-019 #7. R-10 is now restart durability only. Receives interleaving (i) moves to R-25 and (ii) to R-8. Dedup goes to R-35. |
| r2 #8 | MINOR | R-24 was circular. The bar now names the observable delivery boundary. |
| r2 #9, r3 #5 | MINOR | R-27 had two subjects and no uniqueness. It is now exactly one visible finding, and continued retry stays in R-9. |
| r2 #10, r3 #4 | MAJOR/MINOR | R-29's delta was undefined and its population unpinned. It is now a paired-difference p95 over a fixture manifest pinned by hash. The 50 ms default remains agent-set (D-019 #5). |

## Unchanged on purpose

R-4, R-13 and R-17 differ from their rev-8 wording only by rev-9 projection history. That
history is legitimate, so rev 10 leaves them unchanged.

## Consequences

- Any rubric revision voids execution start (`guard-rail:rubric-amend-voids-execution-start-20261114`).
  The activation audit, the spec-quality audit (if voided), the AUTO-BAR spec clauses, and two
  fresh bar critiques must all be redone for rev 10 before `plans:start`.
- `nextRepair: bar_snapshot_proof_stale`: no bound proof is invalidated (0 carried unchanged).
  Vetting and independent grading are refreshed for rev 10 at completion as usual.

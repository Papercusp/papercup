# Shared reference system — acceptance bar amendment (rubric rev 8)

Evidence record for plan `shared-reference-system-2026-11-13`, Discovery finding F-5,
decisions `shared-reference-system-2026-11-13#D-016` and `shared-reference-system-2026-11-13#D-017`.
Tracked work: WI-6554700010048040.

## What happened

- Rubric `shared-reference-system-acceptance` rev 7 (bar set 0739d859e204, plan rev 54) received
  two outside-lineage bar critiques: coord post 1227060 (round 1, 16 findings) and coord post
  1227083 (round 2, 18 findings). Both critiques advised against attesting rev 7 as-is.
- Round 2 showed that at least three gaps D-013 had deferred to completion change a bar's
  meaning, and one contradicts D-015. All 20 plan items were still unbuilt, so amending before
  start cost nothing extra. D-016 therefore adopts one batched amendment now and a fresh critique
  of the committed revision, superseding D-013's defer-to-completion for meaning-changing gaps.
- All 34 findings were dispositioned (coord post 1227364). The amendment-review objection
  (coord post 1227225) was answered point by point. The reviewed revision was committed as
  rubric rev 8: approval coord post 1227390, receipt amend-8aa237685395d9a5d904a849,
  bar set eb80a2a2. D-017 adopts rev 8.

## Cross-cutting decisions

- The rubric has no `mutationRequired` field, so the mutation-probe requirement is written into
  the verification method of R-5, R-9, R-10 and R-14: proof must include a
  `scripts/mutation-probe.sh` run showing that the test catches the mutant.
- Planned proof files are named in each method as
  `packages/operator-core/lib/shared-references/<topic>.integration.test.ts`. As each P-NNN lands
  its test, `rubrics:amend` swaps that criterion's `requirements` check for a `tests` check naming
  the real file.
- The DBOS finding is rejected. D-015 removed DBOS from the R-10 bar on purpose so that the bar
  stays independent of the implementation. The DBOS constraint is still enforced by D-004, the
  P-004 item text and the per-item code-truth audit.

## Round 1 (coord post 1227060)

| finding | sev | disposition |
|---|---|---|
| R3-contradicts-R5-R14 | blocker | FIXED: R-3 reworded so it no longer contradicts R-5/R-14 |
| R10-R16-clause-bar-divergence | blocker | FIXED: plan blocks R-10/R-16 match the criteria exactly (plan rev 56) |
| R10-dbos-constraint-unbarred | major | REJECTED: D-015 keeps R-10 implementation-independent; constraint enforced by D-004, P-004 and the code-truth audit |
| R10-duplicates-and-restart-kind | major | FIXED in R-10 |
| R12-not-falsifiable-at-acceptance | blocker | FIXED: direction-only targets for re-reads (below 68%) and slice re-asks (below 84%), and at least 95% detection for bare P-/D- citations |
| R9-unbounded-retry | major | FIXED: R-9 bounded; mutation probe in method |
| R7-tests-subscription-not-delivery | major | FIXED in R-7 |
| R11-route-population-hand-listed | major | FIXED in R-11 |
| R4-whole-undefined-vs-result-cap | major | FIXED in R-4 |
| R5-epoch-change-not-in-falsifier | major | FIXED in R-5 |
| R6-omitted-change | major | FIXED in R-6 |
| R13-continuation-loophole | major | FIXED in R-13 |
| R17-one-sided | major | FIXED in R-17 |
| P020-P001-unbarred | major | P-020: FIXED by new bar R-19 (live churn check, at most 34 change events per item per day). P-001: answered by D-011 (discovery item, no bar of its own) |
| R1-R2-R14-R15-R18-minor | major | FIXED in R-1, R-2, R-14, R-15, R-18 |
| R8-R16-wording | nit | FIXED in R-8, R-16 |

## Round 2 (coord post 1227083)

| finding | sev | disposition |
|---|---|---|
| r2-D013-gaps-change-meaning | blocker | FIXED: D-013's P-004 "accepted = outbox row commits" is superseded by the R-10 method ("accepted" = the trigger write returned success) |
| r2-R10-R16-plan-blocks-stale | major | FIXED (plan rev 56) |
| r2-R3-wording | major | FIXED in R-3 |
| r2-R5-wording | major | FIXED in R-5 |
| r2-R9-wording | major | FIXED in R-9 |
| r2-R10-accepted-undefined-for-change-pushes | major | FIXED: R-10 method defines "accepted" for change pushes |
| r2-no-outcome-threshold | major | FIXED: R-12 thresholds above |
| r2-R12-wording | major | FIXED in R-12 |
| r2-R7-outcome | major | FIXED in R-7 |
| r2-R13-cap-and-continuation | major | FIXED in R-13 |
| r2-R4-result-door | major | FIXED in R-4 |
| r2-R11-route-registry | major | FIXED in R-11 |
| r2-R14-scope | major | FIXED in R-14 |
| r2-R16-legit-read | major | FIXED in R-16 |
| r2-R1-R17-R15-additions | major | FIXED in R-1, R-15, R-17 |
| r2-P020-unbarred | major | FIXED by R-19 |
| r2-dbos-finding-answered-by-D015 | nit | ACCEPTED: agrees with the round-1 DBOS rejection |
| r2-evidence-readiness-label | nit | FIXED in rev 8 |

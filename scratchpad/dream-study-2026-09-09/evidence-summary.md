# Dream study evidence — interim

Measured 2026-09-14T05:26:47.538Z. **Inconclusive; final acceptance remains open.**

19 governed study attempts; $1.614729 accounted, including conservative reservations. This is not invoice cost.

| Model block | Arm | Attempts | Accounted USD |
|---|---|---:|---:|
| Haiku/Sol | structured-pair | 2 | 0.055139 |
| Haiku/Sol | structured-triple | 1 | 0.000000 |
| Haiku/Sol | uniform-pair | 1 | 0.014978 |
| Luna/Sol | structured-pair | 5 | 0.174601 |
| Luna/Sol | structured-triple | 5 | 0.351371 |
| Luna/Sol | uniform-pair | 3 | 0.962295 |
| Luna/Sol | blender | 2 | 0.056345 |

## Observed outcomes

Dream: 17 attempts, 0 accepted review rows, 14 unverified reviews, and 3 attempts without a completed review. Unverified results are not substantive proposal rejections.

Blender: 2 governed cycles, 5 generated ideas, 0 routed ideas. Routing was explicitly deferred in the newer block; its scored-idea artifacts report no survivors.

5 matched A/B pairs were verified against the stored unit IDs. Both members of every completed matched comparison remain unverified; these data do not establish an incremental benefit from C.

## Interpretation

- Four source units and one source snapshot; no domain-general inference
- Model blocks and pre/post infrastructure or prompt-contract windows must remain distinct
- Ordinary Blender uses its production corpus and one ideator, not the Dream source population
- Unequal spend so far; no matched-spend superiority claim
- All phase cost figures exclude unmeasured engineer/reviewer time and local compute dollar valuation
- No substantive rejection should be inferred from an unverified verdict or a missing judgment

- Historical timeout notes claiming never-admitted/local-governor starvation were retracted in EI-22769219749818913: the Codex adapter did not emit onAdmitted. These raw persisted strings do not establish the cause or prove no generation occurred.
- For the original Haiku cycle 36930ec0-0135-4c3d-8261-b9b8f8028545, the recovered driver log records four HTTP 429 rate_limit_error retries before the deadline. This contradicts its persisted never-admitted explanation. The responding hop, pool account, later retry progress and billed usage remain unestablished; retain the USD 0.039173 unknown-call reservation. Evidence is preserved in EI-22756328656642291 comment 203056; source /tmp/dream-study-pair-after-readiness-20260909.log, SHA-256 ea874cd3a74f97ec879eb9d490a8d1e257684a52f54dc487ccf716e080fe5e3c. This historical evidence does not prove current Haiku recovery.

## Infrastructure corrections

- EI-22762141222831537 is closed: the Scout production path now threads the explicit workspaceId through productionScoutRunner, buildScoutCycleDeps, and the default goal-dispatch path. Twelve focused adapter/runner tests passed. This prevents future runs from relying on ambient sentinel scope; it does not reclassify historical study outcomes.
- EI-22769219749818913 is closed: the deadline diagnostics now separate admission and generation budgets, with 49 focused tests passing at the recorded base and the relevant source unchanged at closure. The historical d536051b delay remains un-attributable, and no paid identity was retried.

## Independent calibration review

The six-case AI/domain review is frozen in [the verbatim review artifact](calibration-review-2026-09-14.json) with its exposure disclosure and source-quotation clarification. Original case labels: 4 rejected, 2 unverified, 0 accepted. These are calibration judgments, not executed outcomes.

The duplicate source-packing cases count as one unverified representative family. Across five families, two are intrinsically rejected and three remain unverified. Qualified families remain unknown pending separate novelty/integration assessment; zero accepted cases does not mean zero viable families.

This is exploratory AI review with disclosed incidental aggregate exposure, not pristine blindness, human validation or held-out confirmation. It used approximately 17 reviewer-minutes. No original study outcome, source pin, cost or unknown reservation is rewritten by this report.

## Remaining acceptance work

- Independent human validation; AI source-domain review is recorded with incidental aggregate exposure
- Separate unblinded novelty/integration review of three representative families
- Flat versus faceted offline outcome ablation
- Qualified family and feasibility adjudication
- Bounded downstream trials where qualified candidates exist
- Independent final acceptance and owner disposition

## Reproduction and evidence

`PAPERCUSP_WORKSPACE_ID=papercusp-workspace node --import tsx scratchpad/dream-study-2026-09-09/summarize.mts`

The companion [JSON evidence](evidence-summary.json) records each attempt, settled calls and conservative reservations, source-unit coverage, exact paired-run matching, Blender receipts, and outstanding work. The source ledgers are `harness_shared.dream_runs` and `harness_shared.scout_ticks`; `accounting.mts` owns cumulative budget accounting. Historic trial rows are not rewritten.

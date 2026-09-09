# Plan execution time and verification value — 9 September 2026

Owner-requested investigation, registered as **WI-10000908**. Evidence collected on 9 September, approximately 07:59–08:16 UTC. This is an investigation and recommendation; it does not change verification policy or operate the live release gate.

## Verdict

**There is real, avoidable verification overhead, but the retained evidence does not establish a general increase in plan execution time.** Among plans that shipped and have an observed work-start event, recent median turnaround improved. Tests common to both comparison periods also did not become slower. The strongest demonstrated problems are narrower: completion-form false rejections, a long acceptance/reviewer tail on some plans, stale runtime/schema versions, and repeated expensive integration attempts that mix real product discovery with fixture repair.

**Keep behavioral testing and independent review. Simplify how evidence is submitted, how reviewers are recruited, and when an unchanged result must be reviewed again.** I would not make a blanket reduction in tests or weaken the requirement that a claimed user outcome actually work.

## 1. What the timing evidence establishes

### Completed plans did not generally slow down

I reconstructed plan transitions from the append-only `coord_event_log`, joined to actual Papercusp plans, excluding rubric/template plans. “Start” is the first observed item transition to `wip`; “ship” is the first observed plan transition to `shipped`. The cohort includes plans created from 10 August onward and events before 9 September. These are lifecycle elapsed times, not agent CPU time or deployment times.

| Observed shipment week, UTC | Plans with a shipment event | Plans with an observed start | Median start → ship | Median last terminal item → ship |
| --- | ---: | ---: | ---: | ---: |
| 17–23 August | 24 | 17 | 26.8 h | 0.9 h |
| 24–30 August | 92 | 56 | 16.3 h | 1.1 h |
| 31 August–6 September | 73 | 49 | 12.1 h | 1.0 h |

The direction also holds within the two usable size bands. For 1–10-item plans, median start-to-ship fell from 8.5 h to 4.7 h (34 and 29 observed starts); for 11–25-item plans it fell from 43.6 h to 17.4 h (19 and 18). Item count is the current stored count, so this is a coarse sensitivity check, not historical scope matching. The larger-plan samples are too small for a reliable conclusion.

**Important limit:** completed plans are a survivor sample. A plan still trapped in acceptance contributes no completed duration. The event start is incomplete, plans can reopen after a first shipment, and historical item scope can change. These results reject a confident claim that *all* plans have become slower; they do not dismiss the owner's experience of particular unfinished plans.

Raw work-item counts are particularly unsuitable here. The recent population includes a large number of administrative tasks, and `kind` is not the work-type column: the live accessor reads `item_kind`. `first_claimed_at` is missing on much older work. I did not substitute `updated_ts` for completion time: the trigger-maintained `closed_ts` records the current terminal transition and deliberately remains unknown for some legacy rows.

### Neither ordinary test execution nor general tool latency explains a broad slowdown

For telemetry, the two complete retained comparison windows are **26 August–1 September** and **2–8 September**, UTC. The oldest invocation record observed was 25 August; this ledger cannot reconstruct an early-August before/after experiment.

| Measurement | Earlier window | Recent window | Interpretation |
| --- | ---: | ---: | --- |
| Median duration across the same 2,007 test-file paths | 30.0 ms | 30.5 ms | Median of each file's median duration; median paired duration ratio is 0.99 |
| Agent-origin MCP dispatch median | 180 ms | 191 ms | Similar typical service latency |
| Agent-origin MCP dispatch p95 | 12.159 s | 10.294 s | No general increase in the slow end of dispatch time |
| `testing:run` calls | 3,631 | 4,863 | More tool-mediated test launches; not a census of all native-shell launches |
| `work_items:complete` calls with non-OK dispatch status | 533 / 6,841 (7.8%) | 1,833 / 9,140 (20.1%) | A substantial rise in completion-call friction |

The paired test query uses `source='local'`, `branch='staging'`, positive duration, and excludes scratch configs. The underlying reporter writes **one row per test file**, using Vitest's module diagnostic duration. It does not measure dependency installation, admission wait, all process startup, or the whole plan. File durations can overlap and must not be added into elapsed plan time.

MCP dispatch status also has limits: a handler can return a business refusal inside an otherwise successful `status='ok'` call. Consequently the last row measures dispatch/schema failures, not every rejected completion. Native CLI tool calls are not comprehensively represented in this ledger. Hook-origin traffic was excluded from the agent comparison.

### A demonstrated waste mechanism: rejecting the wording of a valid experiment

Between 2 and 8 September, **1,429 completion calls from 339 distinct agent identities** were rejected with the `distinguishingTest must state ...` condition. The first observed instance in that window was 5 September at 14:49 UTC. This is about 78% of the recent non-OK completion-call records. It is **not** evidence that all 1,429 were false positives; I inspected concrete examples and reproduced one.

For **EI-22724510342773825**, the agent had isolated a PUI fixture's launch-context writes and checked that the real session file remained unchanged. Its completion said, in substance:

> If the missing fixture environment variable is the cause, setting it contains the writes; if the helper ignores it, the containment assertion fails or the real file changes.

The call at **20:34:48 UTC on 8 September** was rejected. The replacement at **20:37:18 UTC**, expressing the same experiment as `if H1 then ...; if H2 then ...`, succeeded. The durable item records `done` at 20:37:17.818 and preserves the rewritten statement. This is approximately **2.5 minutes between the failed and accepted calls**, not a claim that every second was spent exclusively on rewording.

The invocation ledger identifies serving build **e66be3c4ff**. I loaded that revision's actual parser and the current staging parser into an isolated JavaScript evaluation:

| Actual parser | Original statement | Reworded statement |
| --- | --- | --- |
| Serving revision e66be3c4ff | Rejected: zero parsed observables | Accepted: two observables |
| Current staging | Accepted: two observables | Accepted: two observables |

The old parser recognized `then` or an arrow as the separator, so conditional prose with commas was rejected. A broader parser was committed on **6 September** (`b29a0e0756`), while the cited 8 September call still used the older revision. This demonstrates **both an overly rigid evidence form and delayed availability of its repair**. It does not require inventing a new parser fix; one is already in staging. I did not inspect or operate the current release run.

Sources: `packages/operator-core/lib/coord-lifecycle/records.ts:439`; historical `git show e66be3c4ff:packages/operator-core/lib/coord-lifecycle/records.ts`; the item's completion payload and the three relevant invocation records.

### A demonstrated long tail: acceptance of the unified requirement UI

The **unified-requirement-contract-2026-09-05** plan was created at 21:39 UTC on 5 September. Its implementation and user-journey item **P-005 / WI-2146792** was marked done at **00:15 UTC on 6 September**. At the investigation snapshot, **P-006, the acceptance/shipment work, remained unfinished more than three days later**.

The plan's stored state and Decisions identify several distinct causes:

- Its acceptance rubric had reached revision 14; changing the revision invalidated the existing revision-13 grading and required another review/evidence sequence.
- **D-018** records an actual reviewer dependency cycle: grading needs current rubric vetting, but the only available grader cannot also be the sole vetting critic. It also records dead responders and a reviewer revival refused as `quota-blocked`. An additional independent critic is supported; this was not an impossible system with no escape route.
- **D-019/D-020** record a mistaken belief that the rubric could not be repaired. Source inspection disproved that belief and the rubric was amended. Some delay was agent misunderstanding of the system, not execution of tests.
- The linked `rubrics.integration.test.ts` check was not green in the plan's recorded state. That is a substantive verification problem, not something to relabel as paperwork.
- A final criterion explicitly required deployed evidence; the plan's note records a release dependency. That is distinct from demonstrating the UI on the current build. The deployment statement here is attributed to that checkpoint, not an independent current gate-status reading.

I cannot apportion those three-plus days into mutually exclusive percentages: the blockers overlap. But the timestamped record establishes where the tail sits and names concrete mechanisms. This is much stronger than assuming that slow plans are spending all that time running tests.

The source agrees with the eligibility mechanism: `packages/operator-core/lib/agent-tools/scorecards/grader-eligibility.ts:319` checks the current rubric revision, unions critic identities, and refuses when every critic is in the grader's lineage. `scorecards/emit.ts` also has a separate grading-integrity audit path, bounded to one level. Independence has a purpose; discovering incompatible reviewer assignments after the work is ready creates avoidable delay.

### Expensive test retries are concentrated, not universal

In recent `local` / `staging` records, `pui-e2e/agent-chat-pty.integration.test.ts` ran **85 times: 18 passing and 67 failing file results**, accumulating **4.57 file-hours**. Other costly files included the testing tool's integration tests (2.15 file-hours) and the `pc-heavy` tests (1.82). These are accumulated module durations across attempts, not exclusive wall-clock time and not counts of distinct defects.

The inspected PUI failures include a reply not appearing after an operator restart, a warning about lease teardown, missing persisted chat state, and fixture cleanup failure. They mix product behavior and test-environment reliability. That calls for better isolation and targeted reruns after a diagnosed failure; it does not justify declaring the entire suite ceremonial. The retained metrics do not quantify a general queue-delay or LLM-inference-delay contribution, so I do not attribute the slowdown to “high load.”

## 2. Does the verification produce real value?

**Yes, some of it demonstrably does.**

1. **Real UI journeys caught actual interaction bugs.** WI-2146792 records that the live current-build journey found full-page navigation when opening linked work and Escape closing the parent plan along with its popup. The implementation was corrected and a rendered regression now verifies that Escape dismisses only the nested dialog. I inspected the completion evidence, code, and the regression in `apps/operator/app/admin/plans/PlansClient.test.tsx:244`. I did not rerun the historical desktop session.
2. **Installed-agent restart tests exercise a promise users depend on.** The retained PUI failures show a missing correlated reply after an OS-process restart. The related investigation distinguished persisted model-configuration behavior from backend/resume failure. A helper unit test cannot demonstrate that the installed client resumes the same conversation and renders the next reply.
3. **Release coverage checks prevent a false success claim.** The verified repair on EI-21713782985040786 includes a regression for the historically observed shape where a release said GREEN despite skipped federation coverage. `packages/operator-core/lib/release/live-release-certification.test.ts` explicitly drives the consumer with missing, skipped and failed required legs and expects rejection. It protects a meaningful release property. This audit inspected that regression and its recorded verification, rather than launching a new release test.

**Some verification has low marginal value or a poorly chosen enforcement mechanism.**

- Rejecting equivalent experimental prose produces no additional product evidence. It encourages agents to optimize wording against a parser.
- Rebuilding rubric vetting, peer eligibility and review after every broad revision can consume scarce reviewers even when only a narrow criterion changed. A change to the actual promised outcome deserves renewed scrutiny; an unchanged outcome should reuse applicable evidence.
- Source-text tests are limited evidence. For example, `complete.live-drive-acceptance-wiring.test.ts` checks imports and exact source expressions with `toContain`/regular expressions. It is a cheap structural regression guard, but does not execute the handler and cannot by itself prove the warning reaches a real caller. Keep its role narrow or replace it with a handler-level behavioral test when that code is touched.
- A test that produces a pass only after unrelated fixture/environment repair spends engineering time without necessarily finding a product defect. Track that cost separately instead of treating every red as either a new product defect or a dismissible flake.

**A necessary correction to the tempting “duplicate audits” story:** audit rows contain mechanically carried evidence. Across 194 plans with completion audits in the two-week window, the earlier/recent snapshots had 5,401/3,310 item entries, but 3,443/2,044 were explicitly `carriedFrom` another audit. Those entries are reuse, not rework. Among genuinely submitted entries, only **29/1,958 (1.5%)** and **81/1,266 (6.4%)** repeated identical citation data and item-text hashes from the previous retained snapshot. Even these are candidates for review, not proven wasted effort: an independent review or a changed environment can justify revisiting unchanged source. The carry-forward mechanism already exists and should be preserved.

The same caution applies to tests: only **26 additional passing run groups across 19 file/SHA pairs** were observed in the recent strict subset with clean worktrees, known commit identities and staging/local provenance. Most rows do not provide an equally strong equivalence claim. It would be unjustified to label the much larger raw test volume redundant from filenames alone.

## 3. Recommended changes, in order

**First: eliminate false completion rejections and make runtime/schema behavior coherent.** Reuse the existing parser correction and ensure callers encounter the version that matches the advertised contract. Prefer structured hypotheses, predicted observations and evidence references over a natural-language grammar test. Preserve the requirement for real diagnosis on bug fixes; allow honest “already fixed” or investigation dispositions without manufacturing a post-hoc experiment. Validate and explain the entire applicable completion contract before the final close attempt.

**Second: shorten the routine acceptance workflow.** Use centrally vetted, reusable acceptance templates and one independent product-focused review as the default for ordinary changes. Reserve an additional rubric-quality/grading-integrity review for high-risk work, disputed evidence, material new rubric design or a targeted audit sample. This is a policy recommendation, not a change made by this investigation. Retain stronger independence for security, migration, data-loss, release and federation claims. Where three independent roles are required, recruit an eligible combination before the final stage; do not assign a reciprocal pair that the existing rules will disqualify.

**Third: invalidate evidence only for relevant changes.** Extend the existing per-item carry-forward and requirement/check identities. Pin evidence to the affected code/dependencies, environment, criterion and method. Recheck changed criteria and their dependent judgments; carry the unaffected ones forward with their original provenance. Do not treat a new global HEAD or an unrelated update as proof that a behavior must be re-demonstrated. A broader method or changed promise can legitimately require new evidence.

**Fourth: separate implementation acceptance from release certification.** Finish normal implementation and user-journey acceptance on the current build. Keep deployed-only properties at the final release stage, with an explicit dependency and one responsible operator. Record “implemented and accepted; release pending” when that is the truth, instead of allowing a release wait to trigger repeated implementation reviews. The existing workspace policy already distinguishes these planes; fix inconsistent criteria and readers rather than introducing a second release system.

**Fifth: target expensive testing by risk and the last observed failure.** Keep focused regressions, real persistence/integration checks, and representative live user journeys. Improve PUI fixture isolation and resume/cleanup reliability, then rerun the failed scenario before repeating the whole matrix. Preserve a full final matrix where the release promise needs it. Do not delete cheap unit tests to save the hours spent on reviewer recruitment or broken fixtures.

**Measure the pilot using existing ledgers.** Add or expose per-work stage timings for queue/admission, implementation, test startup/execution, environment repair, review wait, evidence repair and release wait. Associate each rejection or rerun with its disposition: genuine defect found, contract mismatch, invalid input, infrastructure failure, intentionally independent repetition, or stale relevant evidence. Compare similar work and include the age of unfinished plans. Track escaped defects and reopened acceptance alongside elapsed time. A useful pilot must reduce the acceptance tail and false rejections without increasing missed user-facing defects; raw test count or raw number of closed tasks is not the success measure.

## Evidence and reproducibility

Sources inspected include the current source and historical revision named above; `harness_shared.coord_event_log`, `harness_plans`, `plan_items`, `plan_audits`, `plan_decisions`, `tool_invocations`, `test_runs`, and the relevant work-item completion records. Scope is Papercusp, not every managed application. All SQL was read-only; only this report and its coordination record were authored. No test requirements, source behavior, peer assignments or release state were changed.

Metric writer checks:

- `projected-tool-deps.ts:548` and `:1029`: invocation time is dispatch settlement time, not batch flush time. `telemetry-call-origin.ts` defines agent versus hook attribution.
- `libs/test-config/src/admin-test-runs-reporter.ts:1011`: one diagnostic-duration record per completed module; source and branch can be absent. A workspace filter alone is not a valid census of CI/reporter rows.
- `plan-audits.ts:1533`: submitted entries get new provenance; inherited entries retain provenance and receive `carriedFrom`.
- `libs/papercusp/libs/db/sql/698-work-items-closed-ts.sql`: close-time semantics; no synthetic historical backfill.

Representative queries (run through `dev:pg_query` inside `code:run`, with bounded output):

```sql
-- Schema/dispatch friction, not every business refusal.
SELECT CASE WHEN invoked_at < '2026-09-02' THEN 'prior' ELSE 'recent' END period,
       count(*) calls, count(*) FILTER (WHERE status <> 'ok') non_ok
FROM harness_shared.tool_invocations
WHERE invoked_at >= '2026-08-26' AND invoked_at < '2026-09-09'
  AND harness_slug = 'papercusp' AND call_origin = 'agent'
  AND tool_name = 'work_items:complete'
GROUP BY 1;

-- The conditional-prose rejection population.
SELECT count(*) calls, count(DISTINCT coord_owner_id) owners,
       min(invoked_at), max(invoked_at)
FROM harness_shared.tool_invocations
WHERE invoked_at >= '2026-09-02' AND invoked_at < '2026-09-09'
  AND harness_slug = 'papercusp' AND call_origin = 'agent'
  AND tool_name = 'work_items:complete' AND status = 'invalid-input'
  AND error_message LIKE '%distinguishingTest must state%';

-- Equivalent-file duration comparison, avoiding the shifted test population.
WITH perfile AS (
  SELECT file_path,
         CASE WHEN started_at < '2026-09-02' THEN 'prior' ELSE 'recent' END period,
         percentile_cont(.5) WITHIN GROUP (ORDER BY duration_ms) median_ms
  FROM harness_shared.test_runs
  WHERE started_at >= '2026-08-26' AND started_at < '2026-09-09'
    AND source = 'local' AND branch = 'staging' AND duration_ms > 0
    AND is_scratch_config IS NOT TRUE
  GROUP BY 1,2
)
SELECT count(*) matched_files,
       percentile_cont(.5) WITHIN GROUP (ORDER BY p.median_ms) prior_ms,
       percentile_cont(.5) WITHIN GROUP (ORDER BY r.median_ms) recent_ms,
       percentile_cont(.5) WITHIN GROUP (ORDER BY r.median_ms/p.median_ms) paired_ratio
FROM perfile p JOIN perfile r USING (file_path)
WHERE p.period = 'prior' AND r.period = 'recent';

-- First observed work-to-shipment lifecycle, excluding rubric/template plans.
WITH ev AS MATERIALIZED (
  SELECT ts, body->>'plan_slug' slug, body->>'event' event, body->>'after' after
  FROM harness_shared.coord_event_log
  WHERE workspace_id = 'papercusp-workspace' AND surface = 'plan-events'
    AND ts >= '2026-08-10' AND ts < '2026-09-09'
    AND body->>'event' IN ('status_changed','item_status_changed')
), ship AS (
  SELECT slug, min(ts) shipped FROM ev
  WHERE event = 'status_changed' AND after = 'shipped' GROUP BY 1
), measured AS (
  SELECT p.plan_slug, s.shipped,
         min(e.ts) FILTER (WHERE e.event='item_status_changed' AND e.after='wip') first_wip,
         max(e.ts) FILTER (WHERE e.event='item_status_changed' AND e.after IN ('done','dropped')) last_terminal
  FROM ship s JOIN harness_shared.harness_plans p
    ON p.plan_slug=s.slug AND p.workspace_id='papercusp-workspace'
   AND p.harness_slug='papercusp' AND p.template IS NULL AND p.created_at >= '2026-08-10'
  JOIN ev e ON e.slug=s.slug AND e.ts<=s.shipped
  GROUP BY 1,2
)
SELECT to_char(shipped,'IYYY-IW') week, count(*) shipments,
       count(*) FILTER (WHERE first_wip IS NOT NULL) observed_starts,
       percentile_cont(.5) WITHIN GROUP (ORDER BY extract(epoch FROM shipped-first_wip)/3600) median_h,
       percentile_cont(.5) WITHIN GROUP (ORDER BY extract(epoch FROM shipped-last_terminal)/3600) tail_h
FROM measured GROUP BY 1 ORDER BY 1;
```

Outstanding measurement limits: no complete historical attribution of native-shell execution, model inference, queue waiting or reviewer idle time to individual plans; no randomized counterfactual for removing verification; no fleet-wide escaped-defect census. The conclusions above distinguish measured facts, attributable case histories and policy recommendations accordingly.

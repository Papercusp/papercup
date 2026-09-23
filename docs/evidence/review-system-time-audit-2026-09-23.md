# Review-system time audit: plan codex-gateway-live-model-catalog-2026-09-22

Author: su-1bb6850b, 2026-09-23 ~03:50Z. Requested by Avi (owner, interactive): "what specifically is taking up all the time? How can we improve our system to tackle these bottlenecks without hurting the functionality?"

## Read this first: improvement → plan item

Five independent audits are appended below, so the 26 numbered improvements are spread across five tables. Plan `review-system-rework-reduction-2026-09-23` merged overlapping items under D-005 (36 → 20). This index gives each improvement's **surviving** item. A dropped item id cited further down still resolves: its plan entry reads "merged into P-xxx per D-005".

| # | improvement (short) | plan item |
|---|---|---|
| 1 | clause identity keyed to the clause's own meaning; carry-forward in amend | P-001, P-002 |
| 2 | shift-left contract completeness; vet before proof | P-003, P-004 |
| 3 | emit-ready evaluator as one certify verb | P-005 (absorbed P-006) |
| 4 | quarantine notice; git-sync dispatch slot | P-009 (absorbed P-010) |
| 5 | parallel copy-out probes; re-measure on fingerprint move | P-018 (absorbed P-011) |
| 6 | `glance_stale` key; gate `coord:glance` hooks | P-012 |
| 7 | compact-by-default review reads | P-007 |
| 8 | schema-friction pass on review tools | P-008 |
| 9 | stop the wake storm to dead sessions | P-013 |
| 10 | review is pull, not push | P-014 |
| 11 | silent consult → work item at 50% TTL | P-014 (absorbed P-015) |
| 12 | sweep the existing awaiting-acceptance backlog | P-016 |
| 13 | drive 8 by measured failure rate, `rubrics:propose` first | P-008 (absorbed P-017) |
| 14 | pin proof to its commit; re-measure only touched paths | P-018 |
| 15 | supersede-on-bind; name the dragging binding | P-019 |
| 16 | `coord:send` chunks; `rubrics:amend` commit observable | P-008 (absorbed P-020) |
| 17 | amend dry run: carried vs invalidated proof | P-002 (absorbed P-027) |
| 18 | nested git-sync installs honour live locks | P-009 (absorbed P-028) |
| 19 | seed-time check.files ⇄ requiredTestLayers | P-003 (absorbed P-029) |
| 20 | supersede cascade for carrier items | P-030 |
| 21 | re-evaluate BAR readiness on every scope write | P-030 (absorbed P-031) |
| 22 | parked cold-loop fire falls back to inbox wake | P-013 (absorbed P-033) |
| 23 | non-actionable wakes cost no turn | P-024 (absorbed P-034) |
| 24 | handoff brief lists verbs that succeeded | P-035 |
| 25 | cross-session directive close needs `force`; `orders:reopen` | P-036 |
| 26 | per-plan efficiency read, before/after | P-032 |

Items with no numbered improvement come from audit prose: P-021, P-023 (→ P-012), P-022 (→ P-008), P-025, and P-026 (→ P-024).

## Sources (all measured, re-runnable)

- `harness_shared.tool_invocations` for su-cfa16b20 (implementer) and su-1bb6850b (acceptance), 2026-09-22 21:00Z onward: `.papercusp/scratch/codex-review-audit.sql`.
- Card/audit/binding/test-run timeline: `.papercusp/scratch/codex-review-audit2.sql`.
- `plan_revisions` for the plan; the rubrics:amend dry runs (`.papercusp/scratch/codex-bar-amend2-dry.out`).

## Headline

The fix was implemented and working by about 23:50Z (plan revision 5). Acceptance has run from 00:29Z to 03:50Z (3h20m) and is not finished. Most of that time went to **rework** caused by the review machinery, not to the checks themselves. The independent audits took about 7 minutes. Rubric vetting took 17 minutes and found real gaps. The rest was redoing proof after the contract changed underneath it, plus four tooling and pipeline defects hit mid-flow.

## Where the 3h20m went (acceptance session, UTC)

| window | min | what happened | category |
|---|---|---|---|
| 00:29–01:11 | 42 | Recorded live evidence, ran 24 mutation probes, bound 53 proofs, evaluated adequacy | real proof work |
| 01:11–01:46 | 35 | First 10 adequacy cards: 7 failed audit. The evaluator writes `replaySnapshot:true` into its own rerun recipe, which the auditor cannot reproduce. Stripped it by hand and re-emitted 6 cards | tooling defect |
| 01:46–02:20 | 34 | 44 of 53 proofs went test-stale. git-sync's secrets detector had silently quarantined the test file for about an hour; a peer renamed a literal and the fingerprint moved. Re-ran 10 probes sequentially (about 1 min each) | pipeline defect |
| 02:20–02:39 | 19 | The rubric seeded at plan creation lacked METHOD/check/test-layers, so an amendment was required. Its dry run showed the amendment would erase refined clauses (bug WI-10002563), found and fixed. Co-sign took 5 min | late contract gap + tooling bug |
| 02:39–03:00 | 21 | Waited for the fix to reach origin. The routines scheduler starved git-sync for 20+ min with no alarm; the push rides the same tick. MCP tools run the release build, so review-tool fixes need a staging restart and an mcp-call workaround | pipeline |
| 03:00–03:19 | 19 | Applied the amendment. Every clause got a new revision, so I hand-built a 53-row re-bind, re-evaluated, re-emitted 10 cards, and waited on audits (7 min) | revision churn |
| 03:19–03:32 | 13 | Completed the three work-items and the code-truth audit, in parallel with vetting (17 min) | real |
| 03:32– | pending | Vetting found 2 blocking rubric defects, so a second amendment is needed. Its dry run invalidates current proof on **all 10 clauses** (34 current-run refs) although only R-1, R-5 and R-6 change, so another full proof cycle follows | sequencing + over-invalidation |

Agent-side overhead in the same window:
- 3,247 tool calls. 1,934 were hook-driven: 1,269 `activity:report` and 665 `coord:glance`.
- **622 `activity:report` calls failed** with `invalid_args: hook_bundle: Unrecognized key: "glance_stale"`, a hook/schema mismatch.
- Tool execution was 67 of 196 minutes; the rest was model turns and waiting.
- 3 carry-respawns (4 sessions).
- The ~1,500-token tool-result cap forced repeated spill-file re-reads.

## Deeper pass (04:00Z): exact time decomposition and fleet-wide evidence

Source: timestamped transcript parts (`harness_shared.session_turn_parts`; corpus rows live under `workspace_id='default'`), `.papercusp/scratch/codex-review-audit3.sql` and `codex-review-audit4.sql`.

**My 4 sessions, 00:28–03:54Z (199 min):**
- model time 105 min (53%) over about 1,500 model steps (~4 s each)
- tool latency 58 min (29%) over 657 tool calls
- idle waiting 32 min (16%)
- 6 min lost between sessions to respawn

About 950k characters of tool output entered context (180–280k per session), which is what forced 3 carry-respawns in 3.3 h.

**Agent minutes by phase** (active = model + tool):

| phase | active | idle | calls | nature |
|---|---|---|---|---|
| 1 proof generation 00:28–01:11 | 42.2 | — | 156 | needed |
| 2 card-audit failure 01:11–01:46 | 20.7 | 14.1 | 87 | tooling defect (replaySnapshot) |
| 3 quarantine re-stale 01:46–02:20 | 34.0 | 0 | 139 | pipeline defect |
| 4 amendment + bug fix 02:20–02:39 | 18.6 | 1.1 | 91 | late contract gap + tooling bug |
| 5 wait for origin 02:39–03:00 | 12.4 | 1.8 | 50 | scheduler starvation |
| 6 re-proof cycle 03:00–03:19 | 18.8 | — | 81 | revision churn |
| 7 complete + vetting 03:19–03:40 | 5.6 | 15.5 | 22 | needed (waiting on a peer) |
| 8 amendment 2 + owner audit 03:40– | 14.3 | — | 50 | vetting after proof |

About 48 of the 199 minutes (24%) were needed proof and closure work. About 120 minutes (60%) were rework and defect handling, and the rest was waiting.

**Implementer epoch (su-cfa16b20, codex):**
- One session, 21:25–23:59Z (154 min, 332 tool uses): investigation, plan, implementation, tests and live verification. The code was working by about 23:50Z.
- A second session, 23:59–00:14Z, did gate/promotion work.
- Then **ten one-prompt wakes, one per minute, 00:15–00:25Z, each with zero responses**: the platform kept waking a codex session that could not act. The owner then had to start me by hand at 00:28Z. This relates to directives #189–#192 (revive dead or walled agents, including on another backend).

**Fleet-wide, last 7 days (this is not specific to one plan):**
- **60% of proof bindings were invalidated; about 41% had to be replaced.** *(Corrected 04:40Z; see "Fourth pass" at the end. This line originally read "59% of all proof bindings created were thrown away". That counted bindings the amendment carried forward automatically as if they were lost.)*
- **106 BAR amendments on 57 plans**, up to 6 on one plan. Each invalidates that plan's proof (root cause 1 below).
- `rubrics:amend` failed on 250 of 772 calls: 165 handler_error, 55 invalid_input, 17 timeout, 13 other (~32%).
- Review-tool schema friction: `invalid_input` on `work_items:complete` 301 (76 agents), `plans:bind-spec-evidence` 200, `plans:evaluate-spec-test-adequacy` 129, `scorecards:emit` 104, `plans:audit` 57.
- `plans:evaluate-spec-test-adequacy` was called 2,252 times by 176 agents. One evaluation of one spec returned ~138 KB, so the evaluator itself floods context.
- Adequacy-card audits: 20 failed of 151 (13%), 12 pending.

## Root causes, ranked by time cost

1. **Proof is keyed to a volatile identity (measured).** Each projected clause embeds the whole rubric's `barSetHash` (`acceptance-bar-amendment.ts:439,558`); `check` and `requiredTestLayers` are also barHash inputs (EI-24017202481731775). Any rubric edit, even adding an unrelated criterion, gives every clause a new revision and makes all bound evidence ineligible *(overstated; see the fourth pass. Unchanged bars' proof is carried forward, so the cost is a new card and audit per clause, not re-proof)*. Two amendments mean two full proof cycles (re-bind, evaluate, cards, audits: about 40 min each), and the re-bind has no tool, so I hand-wrote a 53-row builder. *Reproduced independently on a second plan* (third audit below): on `turn-start-memory-two-class-2026-09-21` the rev 9→10 amendment changed **only** bar R-4, yet every AUTO-BAR clause on that plan received a new revision in the same transaction, at 03:33:31Z.
2. **Wrong order.** Contract completeness (METHOD/check/layers) and rubric vetting are checked after proof is bound and cards are emitted. A vetting critique should cost a text edit; today it costs a proof cycle.
3. **Review-tool defects hit in flight.** The evaluator's rerun recipe is not auditor-reproducible (`replaySnapshot`; fix WI-10002320 not yet deployed), and the amendment clause-erasure bug (WI-10002563, fixed today). Emitting cards requires a hand-stripping script; the "evaluate and emit terminal cards" recipe has been re-run 4 times instead of being a verb.
4. **Pipeline stalls with no alarm.**
   - Secrets quarantine held a file uncommitted for about 1 hour and told nobody (EI-24015486799447670).
   - routines-tick HELD dispatch starved git-sync for 20+ minutes (EI-22489500008234936); `origin_freshness.alerted` stayed false.
5. **Re-measure is slow.** Mutation probes run sequentially in the shared tree, about 1 minute each, 34 today. Nothing re-measures automatically when a bound test file's fingerprint moves — and nothing watches the measured **source** files at all, which was the dominant staleness cause on the second plan (third audit below, P-018). This decay runs *between* amendments, so it is independent of cause 1 rather than a symptom of it.
6. **Agent overhead.** The glance_stale hook bug, per-turn `coord:glance` hooks, and the result cap.

## Improvements that keep every check

| # | change | removes | functionality kept |
|---|---|---|---|
| 1 | Key clause identity to that clause's own meaning (behavior, falsifier, its own layers and check); drop the rubric-wide `barSetHash` from clause identity. ⚠ The second half of this row as originally written — *"`rubrics:amend` carries forward bindings for unchanged clauses in the same transaction and reports only the delta"* — **already ships**: `shouldCarryBarEvidence` / `carryUnchangedBarEvidenceBindings` (`packages/operator-core/lib/acceptance-bar-amendment.ts:593,648`), called at `rubrics.ts:4341` and counted as `evidenceCarriedForward`. Verified in source; see the third audit below. The remaining work is the **identity half only** | ~2 proof cycles here (~80 min), plus the hand re-bind | evidence for a changed clause still invalidates; the set hash stays on the rubric for ship-time integrity |
| 2 | Shift left: `plans:start` / rubric seed refuses a BAR without METHOD, check and layers; the runbook order becomes amend → vet → attest → bind → cards → grade | the late amendment and the vetting-triggered cycle | same vetting and attestation, earlier |
| 3 | Deploy WI-10002320 (emit-ready drafts). Promote the evaluate-and-emit recipe to one server verb. Add an evaluator→auditor round-trip test so an emitted card is reproducible by construction | ~35 min of failed audits and supersession | same independent audit |
| 4 | Quarantine: notify the file's last editor on the first quarantined tick, and alarm at N ticks. Scheduler: reserve a dispatch slot for git-sync and alarm when `missed_intervals` > 3 | ~55 min of stalls | same secrets gate |
| 5 | Run copy-out mutation probes in parallel. Auto re-measure bindings when a bound test file's fingerprint moves | ~15 min per re-measure | same falsifiability proof |
| 6 | Fix the `glance_stale` hook key (EI-24022555028936462). Gate `coord:glance` hooks on change | ~1,900 noise calls per 3h | none lost |
| 7 | Compact-by-default review reads: evaluate / get-spec-evidence / rubrics:get return a per-clause verdict table plus a ref, with the full body on request | the ~950k chars that forced 3 respawns | full detail still one call away |
| 8 | Schema-friction pass on the review tools: accurate inline examples, and accept the unambiguous near-miss shapes seen in the ledger (e.g. string-vs-array text fields) instead of refusing | ~790 refused calls/week | same validation of meaning |
| 9 | Stop the wake storm: after N unanswered wakes to a session, revive or re-home it (another account or backend) instead of re-waking (directives #189–#192) | the 00:15–00:25 dead time and the manual restart | same wake contract |

Estimate [inferred]: with 1 and 2 alone, today's acceptance would have needed one proof cycle instead of three. Adding 3 and 4, it would likely have finished in about an hour. *(Revised in the fourth pass: improvement 2 does most of this work. Improvement 1 saves the per-clause card cycle, not re-proof.)*

---

# Second audit, independent: review RECRUITMENT

Author: su-ae3c4989, 2026-09-23 ~04:05Z. Requested by Avi (owner, interactive): *"Do a thorough audit of your session including from prior epoch and analyse what is taking so long"* (directive #247), then *"Update the referenced plan and report by integrating your own findings"* (directive #254).

**Why this counts as corroboration.** This section was measured from a different session, a different subject plan (`goal-agent-behavior-feedback-2026-09-06`) and different queries, with no coordination: the plan above was created 03:58:49Z and this author filed escalation `mudku06s` at 04:02:12Z. Per CLAUDE.md, corroboration requires independent *evidence*, not independent recall — that condition is met here. Recorded as plan decision `review-system-rework-reduction-2026-09-23#D-001`.

## Independently confirmed

| claim above | reproduced here | note |
|---|---|---|
| `rubrics:amend` fails ~32% | **32.3%** (250/773, 7d) | exact match, separate query |
| ~790 input-shape refusals | 782 `invalid_input` across 29 tools | different populations (review tools vs one whole session), same defect class |
| hook noise (622 failed `activity:report`) | `activity:report` 6,326 + `coord:glance` 3,610, both `call_origin='hook'` = **63.6% of that session's 15,612 MCP calls** | the report above measures the FAILURE half; this measures the VOLUME half. Improvement 6 should fix both |
| rubric seeded incomplete (improvement 2) | confirmed on an unrelated plan | `goal-agent-behavior-feedback-2026-09-06` has **seven** bars declaring `check={kind:'instrument',instrumentKey:'none'}` ("explicitly manual") *and* a non-empty `requiredTestLayers` of llm/e2e/integration. A bar cannot be both; that plan is blocked on it today |

## Not reproduced — flagged, not disputed

The headline **"59% of 4,428 proof bindings were thrown away"** did not reproduce cleanly. Independent count over the same window: **4,288 bindings, of which 1,210 retracted = 28.2%**. The remaining ~31% is presumably superseded-by-amendment, but the join required to measure it fans out across duplicate `spec_id` rows per plan item and returned an untrustworthy 50,714.

The **direction** is strongly confirmed; the **number** is unverified. Since 59% is the headline justifying Phase 1, the exact query should be published alongside it so it is re-runnable.

## New finding: the review gates are not mis-ordered, they are unanswerable

The audit above measures how expensive a proof cycle is. It does not measure whether review ever *arrives*. Workspace-wide, last 7 days:

| consult outcome | n | of which `exchanges_used = 0` |
|---|---|---|
| expired | 309 | **304** |
| closed_answered | 31 | 28 |
| no_qualified_responder | 25 | 25 |

**304 of 309 expiries had zero exchanges** — the responder never took a single turn. Effective live-peer answer rate ≈ 1%; mean ~29h open per expired consult. This is systemic, not per-agent: `su-3d6cba40` 15 consults/0 answered, `su-52501ad8` 15/0, and even `system:acceptance-grading-sweep` 15/1.

Improvement 2 makes a vetting critique cost a text edit instead of a proof cycle. That is correct and worth doing — but it does not help when no critique ever arrives. A live instance: consult `conv-mudhpqwp` has cascaded through **four** responders with `exchanges_used=0` throughout, ~5h elapsed, still unanswered. Each cascade hop costs a full TTL and produces nothing.

**The downstream number is the one that matters: 208 plans sitting in `awaiting-acceptance`, median age 68 days, oldest 111 days**, against 723 shipped (avg 30.8 days to ship). Every improvement in the table above makes *future* plans cheaper; none drains the queue already stuck behind this gate.

⚠ Improvement 9 (wake storm) targets a **different population** and must not be treated as covering this. It re-homes *dead* sessions; these 304 consults went to *live* sessions that simply never prioritized the inbox. Merging the two would leave the larger population unfixed while looking addressed.

## One tool worse than any named above

Measured 7d, workspace-wide, by failure rate:

| tool | calls | failed | % |
|---|---|---|---|
| `rubrics:propose` | 62 | 46 | **74.2%** |
| `rubrics:amend` | 773 | 250 | 32.3% |
| `plans:audit` | 386 | 61 | 15.8% |
| `scorecards:emit` | 863 | 110 | 12.7% |
| `plans:set-plan-status` | 294 | 14 | 4.8% |

`rubrics:propose` is more than twice as bad as `amend` and is unnamed in improvement 8. A 74% first-call failure rate on the verb that *creates* a rubric is the most expensive possible location for schema friction: it sits at the head of every plan's acceptance path, and every retry re-pays a full model turn. Improvement 8 should be driven by this ranking rather than by which tool was hit during one session.

Corroborating instance, from writing this very section: filing one `coord:escalate` card cost **three** `invalid_input` round trips (`severity` enum, `title`→`summary`, `plan`→`plan_slug`, `options[]` wanting objects not strings). Each refusal printed a perfect corrected call — the information was always present. The cost is purely the round trip, which is exactly what improvement 8 should remove.

## Added improvements

| # | change | removes | functionality kept |
|---|---|---|---|
| 10 | Make review **pull, not push**: promote the existing `vettingWorkItem` + critique-posts channel (`agent-tools/scorecards/emit.ts`) from escape hatch to a first-class claimable backlog item, so review is pulled by agents already polling `work_items:claimable` | the ~99% of consults that expire unanswered | the independence predicate is unchanged — still ≥1 comment by neither emitter nor rubric author |
| 11 | Convert a consult with `exchanges_used=0` to a review work-item at 50% TTL instead of cascading; rank responders by historical answer rate and recency, not relevance alone | ~29h per silent consult, and one TTL per cascade hop | same routing contract; relevance still gates eligibility |
| 12 | Deliberate sweep of the 208 `awaiting-acceptance` plans: classify by blocking gate code, batch the recruitment-blocked ones behind 10, and supersede the genuinely abandoned | a 68-day median queue currently counted as work-in-progress | nothing — abandoned plans are identified, not force-passed |
| 13 | Drive 8 by the measured per-tool failure ranking, `rubrics:propose` first | ~46 failed rubric creations/week at the head of the path | same validation of meaning |

Items 10–13 are filed as **P-014, P-015, P-016** (new *Phase 4 — Unstarve review recruitment*) and **P-017** (Phase 2) on `review-system-rework-reduction-2026-09-23`.

**Ruling carried in D-001, for anyone picking this up:** do not weaken a bar to make it passable. The `requiredProofFloor='none'` exemption (`spec-test-adequacy.ts:742`, downgrade at ~`:1656`) is the sanctioned route for genuinely non-code work and fires only on `behaviorClass==='non-automated'` **and** empty `requiredTestLayers`. Reaching it by deleting a layer that was deliberately authored is gaming the gate, not satisfying it.

---

# Third audit, independent: a second CASE of the proof-churn mechanism

Author: su-c03852cb, 2026-09-23 ~04:30Z. Integrated on owner directive (interactive), verbatim: *"okay integrate your findings into both the plan and report"* — after the owner asked how this report compares with my own audit of `turn-start-memory-two-class-2026-09-21`.

**What this section adds.** The second audit corroborates the *tooling* and *recruitment* halves from a different session. This one is a second **case of the proof-churn mechanism itself**: a different plan (`turn-start-memory-two-class-2026-09-21`, 26 BARs, 36.7 h old), a different agent, different queries — arriving at the same root cause 1, and finding two further decay mechanisms that stack on top of it. It also **corrects one row of the fix list**.

## Sources

`harness_shared.spec_evidence_bindings`, `plan_spec_clauses`, `plan_spec_clause_revisions` and `tool_invocations` for the su-c03852cb lineage, 2026-09-21T15:27Z onward; plus one bar repair (R-11) executed end to end by hand, checkpointed on WI-10002415.

## Independently confirmed

| claim above | reproduced here | note |
|---|---|---|
| root cause 1 — a rubric edit re-revisions every clause | rev 9→10 changed **only** bar R-4; every AUTO-BAR clause got a new revision at 03:33:31Z | separate plan, separate query; mechanism is `acceptance-bar-amendment.ts:439,558` as cited |
| "most of the time is rework, not the checks" | 737 bindings created, **345 retracted (47%)**; 476 binding refs literally record RE-BOUND / RE-RUN / RE-PROBED / RE-MEASURED; 55 clauses → **389 clause revisions** over 10 rubric revisions, by 6 distinct binders | 47% against their 59% — same order, different plan and window |
| root cause 2, vet-after-proof | rev 8→9→10: each amendment cost an approval round trip *after* proof was already bound | — |
| `rubrics:amend` failure rate (32%) | two amendments **timed out having already committed** | the ledger's 17 `timeout` rows may understate the harm: a committed-then-timed-out call reads as a failure and invites a retry that double-applies |

## Correction to the fix list: improvement 1's carry-forward half already ships

**Verified in source, not inferred.** `shouldCarryBarEvidence` (`packages/operator-core/lib/acceptance-bar-amendment.ts:593`) and `carryUnchangedBarEvidenceBindings` (`:648`) carry an unchanged BAR's bindings onto the revision an amendment mints, inside the amendment transaction; `rubrics.ts:4341–4347` calls it and counts the result as `evidenceCarriedForward`. It preserves `observed_at`/`created_by`, recomputes `binding_fingerprint` over the new revision, refuses retracted rows, and requires the contract edge to exist at the new revision. It landed as `acceptance-machinery-seam-fixes-2026-09-16` P-008.

That matches what I had observed before reading the code: R-11's bindings at the new revision carry `created_at` = the amendment transaction (03:33:31Z) while keeping `observed_at` = the original measurement (2026-09-22 19:26–19:41Z).

**So P-002 should be rewritten as "verify and report the existing carry", not "build it"** — the residue is the identity half (P-001) alone. The carry moves proof *onto* the new revision; it does not stop every clause getting a new revision in the first place.

**And it sharpens the diagnosis.** On this plan the carry worked and the proof still died. What killed it was not lost bindings but the two mechanisms below — which is why fixing cause 1 alone would not have rescued this plan.

## Addendum (04:45Z): the same clause measured revision by revision

su-ae3c4989 accepted the correction above, retracted their own `test_run_pruned` explanation, and handed over a replacement hypothesis: that `changedBarKeys` might contain every bar on a rubric-wide re-key, making the carry correct but never *eligible*. I measured it rather than probing it. **Both the hypothesis and the premise behind it are false**, and the same query quantifies cause 1 exactly. Recorded as `review-system-rework-reduction-2026-09-23#D-003`.

R-11's clause on `turn-start-memory-two-class-2026-09-21`, all seven revisions:

| rev | created | bar hash | set hash | bindings | live |
|---|---|---|---|---|---|
| 1 | 09-21 17:19:36Z | 124ada6a | 790cd5e6 | 0 | 0 |
| 2 | 09-22 05:05:19Z | 124ada6a | 790cd5e6 | 11 | 11 |
| 3 | 09-22 14:49:04Z | **572c9216** | c0a11564 | 0 | 0 |
| 4 | 09-22 18:44:48Z | 572c9216 | 56e1c0ed | 20 | 11 |
| 5 | 09-22 23:14:15Z | 572c9216 | c67a8798 | 11 | 11 |
| 6 | 09-23 02:07:33Z | 572c9216 | aeeef5b5 | 11 | 11 |
| 7 | 09-23 03:33:31Z | 572c9216 | 4826d21e | 16 | 2 |

- **The hypothesis is falsified twice.** By construction: `rubric-loss-guard.ts:467–481` diffs per criterion over `ACCEPTANCE_BAR_MEANING_FIELDS` (`:289–301`, which contains `barHash` but not `barSetHash`), and `rubrics.ts:3825–3827` keeps only `added|removed|meaning`. By data: the bar hash is byte-identical across revisions 3–7 while the set hash moves at every one of them, and the carry fires each time.
- **The premise is falsified too.** Revisions 5 and 6 hold the *same* 11 bindings — identical evidence refs, identical `observed_at`, identical `test_run_id` 19026647 — with revision 6's `created_at` equal to the amendment transaction. Nothing was absent, so there was no missing-rows phenomenon left to explain.
- **Cause 1, quantified at clause granularity.** R-11's BAR meaning changed exactly once in 36 hours (revision 2→3). The clause was re-revisioned seven times. **Four of the seven changed only the rubric-wide set hash**, bar hash byte-identical. This agrees with the fourth pass's self-correction below: the re-revisioning is real, the evidence loss is not, and the cost is the per-clause card and audit cycle.
- **Which is exactly why the carry working did not save this bar.** All 11 carried rows keep `observed_at` 2026-09-22 19:26–19:41Z, while the three measured source files were rewritten at 00:17Z, 02:31Z and 03:13Z. The proof was carried faithfully and arrived **stale**: the bar failed on freshness, not on missing rows. P-001 makes the churn expensive; **P-018 is what actually fails a bar**, and shipping P-001 alone would have left R-11 exactly as red.
- **Unclaimed, and a third mechanism distinct from both.** Revision 2 was minted with *both* hashes identical to revision 1, by a different agent (su-b0194963). Neither an amendment nor a rubric re-key explains it, so some other path mints clause revisions — and that path runs no carry at all, which is the one mechanism that would genuinely strand proof. Probe written up in D-003 §5; nobody holds it.

## New finding 1 — proof decays from PEER commits to the measured SOURCE files (P-018)

Improvement 5 re-measures "when a bound **test** file's fingerprint moves". Here the dominant staleness cause was the **source** files, rewritten by an unrelated agent between measurement and evaluation. Worked example, bar R-11:

- proof observed 2026-09-22T19:26–19:41Z;
- all three measured files then rewritten by su-51241185's `owner-directive-delivery-redesign` refactor — `su.md` 00:17Z, `papercusp-files.ts` 02:31Z, `owner-directive-prompt-render.test.ts` 03:13Z.

This decays proof *between* amendments, on a tree the whole fleet commits to, so cause 1 and this one are independent and stack. Fix only the amendment half and the livelock stays half-armed. The fix is to pin each proof to the **commit** it was measured at, so a later peer commit invalidates exactly what it touched and nothing else.

## New finding 2 — one weak row fails the whole clause, and the refusal does not name it (P-019)

Per-clause adequacy is judged over **all live bindings at the current revision under an any-drags rule**: one under-attested row fails the clause however strong the row beside it. R-11 only went clean after I hand-retracted 13 superseded rows. So a share of the discarded-binding counts in *both* audits is **bookkeeping, not re-proof** — supersede-on-bind would remove it, and would lower the 59%/47% headline for the right reason.

Compounding it, the refusal does not say **which** row dragged, and the requirement that an executable proof carry a real `test_run_id` is not stated anywhere a caller sees it. Without one, traceability, falsifiability and execution-integrity all fail, because the evaluator holds that *"author-attested booleans cannot establish execution-integrity"* (`packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts:1408`). I recovered that rule by reading the evaluator's source. `testing:runs` filtered by `filePath` also did not surface the `source='mutation-probe'` ledger rows I needed to cite.

## New finding 3 — `coord:send` fails instead of chunking (P-020)

`coord:send` returned not-ok on **105 of 260 calls (40%)** in this lineage, overwhelmingly on a 600-character delivered-body cap that refuses rather than splits — while the row still persists, so a "failed" send may have partly delivered. It sits on the critical path of every counter-signature round trip, which is the path improvement 2 shortens. This is improvement 8's class, and by rate it belongs in the second audit's ranking beside `rubrics:amend`.

## Measurement caveat — read the two audits' numbers as complements, not rivals

My counts come from `tool_invocations`, which records **MCP calls only**; a large share of an agent's tool use here is native and never lands there (~60%, my estimate, not measured). The audits above are transcript-timestamp based. **Theirs is the better time attribution; mine is the better count of rework artifacts.** Prefer theirs for minutes and mine for how many proofs were thrown away — and note the second audit's own caution that the 59% headline needs its query published; my 47% is a different plan, so it corroborates the *direction*, not the number.

For the record, the ambient overhead this lineage paid — improvement 6's population — was 28,454 MCP calls over 36.6 h, 418 min inside tool calls, 1,880 not-ok, **67% ambient**: `activity:report` 10,928 (786 not-ok), `coord:glance` 6,611, `locks:check_command` 1,473.

## Added improvements

| # | change | removes | functionality kept |
|---|---|---|---|
| 14 | Pin each proof to the **commit** it was measured at; re-measure only the bindings whose measured paths a later commit actually touched — source files included, not just the bound test file | the between-amendment decay that stales proof on a shared tree; the dominant cause on this plan | unchanged — a proof whose subject really moved still invalidates |
| 15 | Supersede prior bindings at bind time for the same (clause, work-item, evidence) triple, and have the adequacy refusal NAME the dragging binding ids and the missing `test_run_id` | the hand retraction pass (13 rows for one bar) and the source-reading needed to learn the rule | the any-drags rule itself is unchanged — it is the correct rule |
| 16 | `coord:send` chunks a long body instead of refusing at 600 chars; `rubrics:amend` makes its commit observable before any timeout can fire, so a timed-out call is never retried into a double-apply | ~40% of sends, and the commit-then-timeout retry hazard | same delivery and same amendment semantics |

Items 14–16 are filed as **P-018, P-019** (Phase 1) and **P-020** (Phase 2) on `review-system-rework-reduction-2026-09-23`.

## This plan's acceptance test is already running

Owner ruling on `turn-start-memory-two-class-2026-09-21` [owner 2026-09-23, interactive], verbatim: *"pause until we imrpove our system. your remaining work will be canary proof that the system is better if it is"* — recorded there as D-124.

That plan is paused at **2 of 26 BARs clean**. Its remaining 24 BARs are the canary for this plan. Measured baseline, from repairing R-11 by hand: **~20 tool calls, 2 mutation-probe executions, 3 binding cycles, 13 retractions, plus hand reverse-engineering of `spec-test-adequacy.ts`.** Target once P-001, P-002, P-018 and P-019 land: single-digit tool calls per BAR, no source reading to learn the rule, and no re-measurement triggered by an unrelated peer commit. The runnable recipe is checkpointed on WI-10002415. A negative result will be reported as a negative result.

---

# Fourth pass (original author, su-1bb6850b, 04:40Z): reconciliation and self-corrections

This pass re-derives the numbers the second and third audits flagged, and corrects my own sections where they were wrong. It uses evidence from applying amendment 2 to the codex plan at 04:01Z, after the sections above were written.

## Reconciliation of the binding headline

The second audit was right to flag "59%". It had failed to reproduce the number because of a join fan-out, and the number also mixed two different things. The query below avoids the fan-out by computing each clause's current revision in a `GROUP BY` before joining.

```sql
WITH cur AS (
  SELECT workspace_id, harness_slug, coalesce(plan_slug,'') plan_slug, spec_id, max(revision) cur_rev
    FROM harness_shared.plan_spec_clause_revisions GROUP BY 1,2,3,4)
SELECT count(*) bindings,
       count(*) FILTER (WHERE b.retracted_at IS NOT NULL) retracted,
       count(*) FILTER (WHERE b.spec_revision < c.cur_rev) on_superseded_rev
  FROM harness_shared.spec_evidence_bindings b
  LEFT JOIN cur c ON c.workspace_id=b.workspace_id AND c.harness_slug=b.harness_slug
                 AND c.plan_slug=coalesce(b.plan_slug,'') AND c.spec_id=b.spec_id
 WHERE b.created_at >= '2026-09-16 04:00Z' AND b.created_at < '2026-09-23 04:00Z';
```

| population (7 days to 04:00Z, 35 plans) | n | % |
|---|---|---|
| bindings | 4,442 | 100 |
| retracted | 1,268 | 28.5 — matches the second audit's 28.2% |
| on a later-superseded revision, not retracted | 1,412 | 31.8 — matches its "remaining ~31%" |
| **invalidated (either)** | **2,680** | **60.3** |
| of the superseded: same `evidence_ref` bound again at the newer revision | 860 | 19.4 |
| **replaced (retracted, or superseded and never carried)** | **1,820** | **~41** |

The 860 re-bound rows are mostly the **automatic carry-forward** the third audit found in the code (`carryUnchangedBarEvidenceBindings`), not agent labour. The headline is therefore **"60% invalidated, ~41% replaced"**. The third audit's 47% for one plan falls within that range.

## Self-correction: root cause 1 was overstated; the dry-run preview misled me

I wrote that "any rubric edit … makes all bound evidence ineligible". Applying amendment 2 at 04:01Z contradicted that. The dry run reported **77 proof refs invalidated**. On apply, every unchanged bar's bindings (R-2, R-3, R-4 and the three SPEC-P001 clauses) arrived at the new revisions carrying the amendment's timestamp (`created_at` 04:01:35Z). Only R-1, whose meaning changed, and the new R-6 needed fresh proof. That was 4 re-bound rows plus 7 new ones.

The accurate cost of cause 1, when the carry works, is **not re-proof**. It is:

- a new **adequacy card and audit for every clause**, because cards are keyed to `spec@revision`. That was 9 cards here, about 10 minutes, and every audit passed first time once the evaluator's `replaySnapshot` artefact was stripped before emitting;
- a **dry-run preview that counts carryable proof as invalidated**. That mis-sized the job and led me to present a full proof cycle as unavoidable.

The first amendment carried nothing for a different reason: it changed `check` and layers on **every** bar, and those are bar-identity inputs. Clause-local identity (improvement 1) would not have saved it; only the seed-time contract completeness in improvement 2 would. So my estimate above was too generous to improvement 1. **Improvement 2 is the bigger lever for this plan**, and improvement 1's saving is the per-clause card and audit cycle.

## New finding — file locks do not protect submodule files from git-sync (WI-10002596)

While writing R-6 proof I ran the tier-3 in-tree mutation probe recipe with the exact file lock held. git-sync still committed a mutant: `libs/papercusp` commit `1e553ccd`, removing `model_catalog_url`, at 04:12:18Z. The restore followed as `1afb4d93`. The superproject gitlink never pinned either commit, so no gate candidate carried the mutant.

Root cause [inferred from code and timing, test not yet written]: each submodule has its own git-sync install (`papercusp/libs/papercusp`, `…/generic/*`, 40+ in all). Each install sweeps its repo with **unmapped superproject-relative** lock paths, so a held `libs/papercusp/x.ts` never matches the dirty `x.ts` (`git-sync-action.ts` ~3139–3232 versus `run-git-sync.ts` 4480, 4707–4717). Every DB migration lives under a submodule. A workspace guard-rail fact now warns agents to use copy-out probes there.

## Smaller findings from the same pass

- **The rubric contract can bind a check file at a different layer than it declares.** R-6 declares `requiredTestLayers:['integration']` but its `check.files` names a string-level unit test. Nothing flags the mismatch. Improvement 2's seed-time validation should check layer and file agreement. That this was the vetter's own recommended shape shows the check has to be mechanical, not reviewer diligence.
- **One-to-one causal pairing** refused a second, stronger mutant for the same scenario ("expected 1 negative binding, found 2"). That was fixable only by retraction; it is the same class as the third audit's P-019.
- **Recruitment latency, live instance.** The rev-3 vetting consult (`conv-mudliz2l`) was routed to a live responder busy on an unrelated goal-drain. Waking it was confirmed as queued, not picked up. Outcome pending; recorded here because it is the second audit's finding, observed again.

## Added improvements

| # | change | removes | functionality kept |
|---|---|---|---|
| 17 | `rubrics:amend` dry run reports **carried** and **invalidated** proof separately, and lists the cards that will need re-emission | the mis-sized proof cycle I planned from the preview | same amendment semantics |
| 18 | Nested git-sync installs map live-lock paths into their own repo root (`mapLiveLockHoldingsForRepo(rows, <install prefix>)`), with a test on a nested-install fixture; keep per-tick exclusion history, not only the latest tick | committed mutants and half-edits in every submodule, including migrations | same whole-tree sweep |
| 19 | Seed-time contract check: each `check.files` entry must be able to satisfy each declared `requiredTestLayers` layer | silent layer/check mismatches that surface only at vetting | same contract fields |

# Fifth audit, independent: PROGRAM-level waste (su-e3d58938)

Author: su-e3d58938, 2026-09-23 04:25–04:55Z. Requested by Avi (owner, interactive): *"this is taking a very long time audit your sessions including from prior epochs. What is taking up all the time? is it useful. And then come up with a plan for improving our system..."* (directive #263), then *"integrate your own findings into the plan and report"* (#274/#275). Recorded as plan decision `review-system-rework-reduction-2026-09-23#D-004`.

**Different subject, so agreement counts as corroboration.** Audits 1–4 each measure one plan's acceptance cycle. This one measures a whole program: `ship-main-greening-program-2026-09-15`, 8 days (09-15 to 09-23) and 13 agents, plus this session's own three carry epochs. It was measured before I read audits 1–4.

## Sources

- `harness_shared.tool_invocations`: workspace `papercusp-workspace`, `call_origin='agent'`, `invoked_at >= 2026-09-15`, `goal_ref` in the program's work items (`source_plan_slug` = the program, plus `WI-10002581`). **11,854 calls, 13 agents, 111 distinct active hours.**
- `harness_shared.session_turn_parts` (`workspace_id='default'`): per-owner gaps between consecutive parts, with gaps under 2 minutes counted as active.
- These are floors. Native Edit/Read/Bash (about 60% of tool use) writes no `tool_invocations` row, and the categories below are by tool, not by purpose.

## Where the program's calls went

| category (by tool) | calls | share |
|---|---|---|
| generic exec (`capability:bash`, `code:run`, `tools:invoke`) | 4,958 | 42% |
| coordination and carry (`coord:*`, `loop:*`, checkpoints, claims) | 2,895 | 24% |
| read and orient (`plans:get`, `work_items:get`, `dev:pg_query`, `tools:find`, …) | 2,068 | 17% |
| other | 949 | 8% |
| acceptance ceremony (`rubrics:*`, `scorecards:*`, audits, `set-plan-status`) | 480 | 4% |
| gate / pipeline | 353 | 3% |
| implementation / test tools | 154 | 1% |

- **Failed calls:** 1,016 (8.6%). By class: `invalid_input` 322, `handler_error` 297, `checkpoint_merge_would_evict_rows` 94, `authorization_denied` 46, SQL column guesses 29+.
- **Wall-clock across the 13 agents:** 78 h active, 52 h in 232 gaps of 2–60 minutes, 222 h in gaps over an hour.
- **This session's own chain (4h15m):** about 106 min active and 153 min idle, including a 51 min and a 72 min gap with nothing queued. About 20 minutes went to backstopping a dark leader.

## Independently confirmed

- **Proof churn and amendment cost (audits 1–3).** The program's rubric is at rev 12. There were 16 applied amendments across 6 program rubrics, and program D-007 records an amendment that invalidated a complete acceptance chain. `rubrics:amend` failed 44 of 106 calls (41%) on this program; the fleet figure is 32% (P-017).
- **Silent consults (P-015).** The prior `WI-10002581` holder routed a consult to su-ce0b634c (`conv-mudke8ka…`); it went unanswered.
- **Wake loops (P-013/P-024 family).** Finding 3 below is a third shape of the same family.

## New finding 1 — work continues after a scope decision makes it moot (largest share)

3,474 calls (29% of the program) went to three items later dropped as moot: P-022 (1,840), P-012 (984) and P-021 (650). The owner-approved consolidation D-019 (09-19) superseded their subject plans, so those "Ship <plan>" items could never finish. P-022's calls all fall on 09-21 and 09-22, after D-019; D-040/D-041 noticed on 09-22. For P-012 and P-021 I did not separate the calls made before D-019 from those after it. Nothing links a carrier item to the plan it ships, so superseding the subject plan notifies nobody. → **P-030**.

## New finding 2 — acceptance BARs silently become impossible after a scope decision

These BARs were complete when written and became false later, so seed-time checks (P-003/P-029) cannot catch them.

- **R-1** required all ten in-scope plans shipped. D-019 made that impossible on 09-19, but it surfaced only at the 09-23 ship attempt. Program D-026 (09-22) re-worded R-1 and kept the impossible clause.
- **R-4** ("the program never touches the live gate") was breached three times. One breach was undisclosed until program D-049: a confirmed `release:deploy op=force` on 09-17 at 21:12:47Z by su-a604a73a (`goal_ref WI-10001488`), recovering outage EI-23538941588991674.

Readiness is evaluated only at ship. → **P-031**.

## New finding 3 — cold-loop fires park without resume while reporting `rewakeGuaranteed:true`

The program leader, su-2bee6ccf, re-armed at 03:55:04Z and got `rewakeGuaranteed:true`. Its next fire (04:05:31Z) parked with *"eligible cold loop wake has no injectable psu host"*; the same happened at 03:33Z. Both times only a direct `coord:send` wake revived it, and it then handed its item over rather than risk going dark again. This differs from P-013 (dead sessions) and P-024 (a loop firing while its session waits on an await): the session is alive and wants the wake, and the wake never lands. EI-24023838400909760. → **P-033**.

## New finding 4 — non-actionable wakes cost full turns

In this session's chain, 3 of 7 inbox-wake turns had nothing to act on: an auto-resolved alert for an item the session itself had closed, a plan event with no state change (todo→todo), and a message already read. → **P-034**.

## New finding 5 — how-to knowledge is lost at handoff

The prior `WI-10002581` holder concluded that no BAR-amendment verb existed after 3 `tools:find` calls, although the same program had used `rubrics:amend` in D-024/D-025/D-026. `tools:find` was called 415 times on the program. → **P-035**.

## New finding 6 — one session can close another session's owner directive

Avi pasted one message into 6 sessions, the way these audits were requested. Closing its own copy by text match, su-e3d58938 closed all six, five of them belonging to sessions that had not yet answered. There was no warning and there is no reopen verb; I reverted by guarded SQL within about 90 seconds and verified via `orders:list`. EI-24026089914526674. → **P-036**.

## Is the time useful?

Partly. The gate-lane fixes, the completed ships and the integrity findings (D-049) were useful. Findings 1, 3, 4 and 5, plus the retry share of failed calls, were not: roughly a third of calls, and most of the idle wall-clock.

## Correction

My first report to Avi said the program's criteria were "reworded 106 times". That was 106 `rubrics:amend` calls: 16 applied, 66 dry-run previews and 44 failures. It is not the same population as this report's fleet-wide "106 amendments across 57 plans"; the match is a coincidence.

## Added improvements

| # | change | removes | functionality kept |
|---|---|---|---|
| 20 | Supersede cascade: superseding or consolidating a plan parks every non-terminal "Ship <plan>" carrier item elsewhere, notifies its holder and raises a repair obligation (P-030) | work on items a scope decision already made moot (29% of this program's calls) | items are parked with a pointer, not dropped; dropping stays a recorded decision |
| 21 | Re-evaluate BAR readiness on every scope write and surface blocking codes in Now/orient (P-031) | impossible BARs found days late, at ship | same evaluator and codes, run earlier |
| 22 | A parked cold-loop fire falls back to the inbox-wake path, and `rewakeGuaranteed` is false when the last fire parked (P-033) | holders going dark, and backstop agents | same loop semantics |
| 23 | Non-actionable inbox wakes land in the inbox without starting a turn; directed asks and owner directives always wake (P-034) | no-op turns | nothing dropped: still in the inbox |
| 24 | The handoff brief lists the mutating verbs that succeeded on the item's plan (P-035) | rediscovery and false "no such verb" conclusions | extends the existing `priorAttemptBrief` |
| 25 | `orders:disposition` refuses to close another live session's directive without `force`; add `orders:reopen`; `orders:list mine:true` (P-036) | wrong-session closes when one message is pasted to many sessions | each session still closes its own |
| 26 | Per-plan efficiency read, then before/after on the next five ships (P-032; changed from two by D-005 to match Acceptance) | audits like this one needing 30+ ad-hoc queries | read-only |

# Sixth pass (original author, su-1bb6850b, 09:35Z): the last mile from graded to shipped

The plan shipped at 09:27Z (`awaiting-acceptance` → `shipped`, no force or waiver). Between the first independent card (07:03Z) and the ship there were 2h24m and three more repair cycles. None was caused by a behaviour defect. Sources: the cards `EI-24034772495454328`, `EI-24036936348852993`, `EI-24042920914796564` and `EI-24043051671018046`; bindings 10047–10051, 10057, 10058, 10102 and 10103; and the `WI-10002580` completion.

## New finding 1 — the method asked for proof the pairing rule cannot store as a mutation row (≈2h, two graders)

Rubric rev 4 (D-005) requires mutants M13–M16 to be caught by a bound file, but spec `AUTO-BAR-R-6-P-003` names three one-to-one scenarios. `spec-test-adequacy.ts` (the causal-pair block) allows **exactly one** negative binding per `causalPairId`, and M10–M12 already fill those slots. A fourth mutation row would therefore fail proof adequacy. I put M13–M16 in an attestation's prose instead. Both graders independently rated R-6 `degraded` because "none is bound as spec evidence". R-4 had the same problem with M4b, bound only to a retired bar. `degraded` is not pass-equivalent (`expectedInstrumentVerdict`), so the author's verdict cannot override it.

**What worked:** each extra caught mutant goes in as `evidenceKind:'check'` with no `causalPairIds`. Each expected survivor (M13u/M14u) goes in as `'manual'` with no `details.adequacy`, because an executable row with outcome `survived` counts as a failed relied-on binding. Recorded as fact `guard-rail:one-to-one-spec-supplementary-probes-bind-as-check-rows`.

## New finding 2 — a build moved the ship door after grading was complete (1 extra cycle)

After the all-healthy card and the author's accept verdict, the ship call on `:3170` (build `ee617c6363`) refused with `acceptance_bar_contract_not_ready`: R-1 and R-2 `bar_snapshot_evidence_plane_unmet`. That code had just joined the ship-blocking list in `acceptance-bar-contract-snapshot.ts`. At 07:55Z, on build `80521d598f`, the same plan reported only `acceptance_bar_not_met`. The live-plane rows had been bound before `details.evidencePlane` existed. The refusal's `NEXT REPAIR`, "Record current evidence on the BAR's declared evidence plane", does not name the field, so finding it took a source read. The repair was a metadata-only rebind (same ref, kind and run, plus `evidencePlane:'live'`). It did not stale the independent grading, because a passing rating is decided before the cohort-change check.

## New finding 3 — the obvious await for "grader filed" never fires

The recruitment reply names the canonical reservation work-item (`WI-10002634`), so I awaited `work-item:done:WI-10002634`. The reservation stays open when a card is filed. The await timed out, and the carry-note's "check WI-10002634" pointed at a key that never fires. The correct key is `scorecard:emitted:<rubricRef>` (`events/await/catalog.ts`). It fired within seconds of the re-grade.

## Added improvements

| # | change | removes | functionality kept |
|---|---|---|---|
| 27 | When a rubric method names more mutants than the spec has one-to-one scenarios, `rubrics:propose`/`amend` warns and names the storage (check rows, or add the scenarios) | a full grade → degraded → rebind → re-grade cycle | the one-negative-per-pair contract is unchanged |
| 28 | A newly ship-blocking BAR code is raised on plans already awaiting acceptance, at deploy time rather than at their ship call; and `evidence_plane_unmet`'s `NEXT REPAIR` names `details.evidencePlane` plus the exact rebind | a surprise refusal after grading and a source read to repair it | same code, same blocking |
| 29 | The grading-recruitment reply returns the `scorecard:emitted:<rubricRef>` await key beside the reservation id | awaits on a key that never fires | the reservation is unchanged |

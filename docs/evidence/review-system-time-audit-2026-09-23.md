# Review-system time audit: plan codex-gateway-live-model-catalog-2026-09-22

Author: su-1bb6850b, 2026-09-23 ~03:50Z. Requested by Avi (owner, interactive): "what specifically is taking up all the time? How can we improve our system to tackle these bottlenecks without hurting the functionality?"

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
- **59% of all proof bindings created were thrown away:** 1,919 of 4,428 were bound to spec revisions later superseded, and 1,252 were retracted, across 35 plans (20 with discards).
- **106 BAR amendments on 57 plans**, up to 6 on one plan. Each invalidates that plan's proof (root cause 1 below).
- `rubrics:amend` failed on 250 of 772 calls: 165 handler_error, 55 invalid_input, 17 timeout, 13 other (~32%).
- Review-tool schema friction: `invalid_input` on `work_items:complete` 301 (76 agents), `plans:bind-spec-evidence` 200, `plans:evaluate-spec-test-adequacy` 129, `scorecards:emit` 104, `plans:audit` 57.
- `plans:evaluate-spec-test-adequacy` was called 2,252 times by 176 agents. One evaluation of one spec returned ~138 KB, so the evaluator itself floods context.
- Adequacy-card audits: 20 failed of 151 (13%), 12 pending.

## Root causes, ranked by time cost

1. **Proof is keyed to a volatile identity (measured).** Each projected clause embeds the whole rubric's `barSetHash` (`acceptance-bar-amendment.ts:439,558`); `check` and `requiredTestLayers` are also barHash inputs (EI-24017202481731775). Any rubric edit, even adding an unrelated criterion, gives every clause a new revision and makes all bound evidence ineligible. Two amendments mean two full proof cycles (re-bind, evaluate, cards, audits: about 40 min each), and the re-bind has no tool, so I hand-wrote a 53-row builder.
2. **Wrong order.** Contract completeness (METHOD/check/layers) and rubric vetting are checked after proof is bound and cards are emitted. A vetting critique should cost a text edit; today it costs a proof cycle.
3. **Review-tool defects hit in flight.** The evaluator's rerun recipe is not auditor-reproducible (`replaySnapshot`; fix WI-10002320 not yet deployed), and the amendment clause-erasure bug (WI-10002563, fixed today). Emitting cards requires a hand-stripping script; the "evaluate and emit terminal cards" recipe has been re-run 4 times instead of being a verb.
4. **Pipeline stalls with no alarm.**
   - Secrets quarantine held a file uncommitted for about 1 hour and told nobody (EI-24015486799447670).
   - routines-tick HELD dispatch starved git-sync for 20+ minutes (EI-22489500008234936); `origin_freshness.alerted` stayed false.
5. **Re-measure is slow.** Mutation probes run sequentially in the shared tree, about 1 minute each, 34 today. Nothing re-measures automatically when a bound test file's fingerprint moves.
6. **Agent overhead.** The glance_stale hook bug, per-turn `coord:glance` hooks, and the result cap.

## Improvements that keep every check

| # | change | removes | functionality kept |
|---|---|---|---|
| 1 | Key clause identity to that clause's own meaning (behavior, falsifier, its own layers and check); drop the rubric-wide `barSetHash` from clause identity. `rubrics:amend` carries forward bindings for unchanged clauses in the same transaction and reports only the delta | ~2 proof cycles here (~80 min), plus the hand re-bind | evidence for a changed clause still invalidates; the set hash stays on the rubric for ship-time integrity |
| 2 | Shift left: `plans:start` / rubric seed refuses a BAR without METHOD, check and layers; the runbook order becomes amend → vet → attest → bind → cards → grade | the late amendment and the vetting-triggered cycle | same vetting and attestation, earlier |
| 3 | Deploy WI-10002320 (emit-ready drafts). Promote the evaluate-and-emit recipe to one server verb. Add an evaluator→auditor round-trip test so an emitted card is reproducible by construction | ~35 min of failed audits and supersession | same independent audit |
| 4 | Quarantine: notify the file's last editor on the first quarantined tick, and alarm at N ticks. Scheduler: reserve a dispatch slot for git-sync and alarm when `missed_intervals` > 3 | ~55 min of stalls | same secrets gate |
| 5 | Run copy-out mutation probes in parallel. Auto re-measure bindings when a bound test file's fingerprint moves | ~15 min per re-measure | same falsifiability proof |
| 6 | Fix the `glance_stale` hook key (EI-24022555028936462). Gate `coord:glance` hooks on change | ~1,900 noise calls per 3h | none lost |
| 7 | Compact-by-default review reads: evaluate / get-spec-evidence / rubrics:get return a per-clause verdict table plus a ref, with the full body on request | the ~950k chars that forced 3 respawns | full detail still one call away |
| 8 | Schema-friction pass on the review tools: accurate inline examples, and accept the unambiguous near-miss shapes seen in the ledger (e.g. string-vs-array text fields) instead of refusing | ~790 refused calls/week | same validation of meaning |
| 9 | Stop the wake storm: after N unanswered wakes to a session, revive or re-home it (another account or backend) instead of re-waking (directives #189–#192) | the 00:15–00:25 dead time and the manual restart | same wake contract |

Estimate [inferred]: with 1 and 2 alone, today's acceptance would have needed one proof cycle instead of three. Adding 3 and 4, it would likely have finished in about an hour.

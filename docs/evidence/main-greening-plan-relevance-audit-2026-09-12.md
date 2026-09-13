# Main-greening plan relevance audit — final

Completed 2026-09-12 for Avi. Scope: the 33 primary plans previously listed, the original eight-plan tracker, and two superseded release-trace aliases. This is a design/relevance and source-consistency audit, **not a full production recertification** or a claim that main is green.

The core architecture remains useful, but this is not a set of 33 fresh implementation instructions. Verdicts: **14 Keep, 12 Revise, 2 Consolidate, 4 Historical, 1 Redesign draft**. Plan age alone did not decide any verdict. No audited source, plan text/status, rubric or acceptance outcome was changed.

## Reading the verdicts

- **Keep:** the purpose and current design remain sound. A shipped component should be retained, not rebuilt; unfinished evidence may still need closure.
- **Revise:** retain the purpose, but repair obsolete procedures, superseded mechanisms or overstated acceptance claims before execution.
- **Consolidate:** useful intent is substantially covered by current mechanisms/plans; transfer any exact residual and settle the older checklist.
- **Historical:** retain the incident and its regression protection. Do not replay the historical recovery procedure.
- **Redesign draft:** a credible problem, but not a sufficiently specific current implementation plan.

Recorded lifecycle status is independent of this relevance verdict. All dates below are the stored creation dates, not suffixes inferred from names. Three differ: ownership follow-up was created August 9; dependency-generation and test-suite recovery were created August 28.

## Brief verdict for every primary plan

| Created | Plan | Status | Audit verdict | Brief conclusion |
| --- | --- | --- | --- | --- |
| 2026-06-21 | Deploy trigger and gate unblock | ready | **Consolidate** | The deploy/status/force surfaces and staleness watchdog exist. The old rule tying trigger to the latest gate color is obsolete: today a previously certified green pin can deploy while a newer candidate is red. |
| 2026-07-10 | Release-gate triage hardening | draft | **Revise** | Failure parsing, run logs and staleness diagnosis remain useful. Its tip-based refire language and persona/route work predate the current frozen-lineage policy and instruction layers. |
| 2026-08-03 | Gate-ownership singleton | awaiting-acceptance | **Keep** | The condition-keyed owning object, database uniqueness, independent holder-liveness check and LIVE_GATE_OPS boundary remain current. This is established shared infrastructure, not a new owner system to rebuild. |
| 2026-08-09 | Gate-ownership follow-up | awaiting-acceptance | **Keep** | The workspace propagation fix and red-streak condition are still part of the current bridge. The original duplicate-row purge was one-time cleanup, not a recurring operation. |
| 2026-08-12 | Gate-suite speedup | shipped | **Keep** | Work reduction, pure/stateful isolation boundaries and bounded resources remain sound. The plan's old timings, fork-knee measurements and pollution observations are not current capacity guarantees. |
| 2026-08-12 | Main-gate recovery | shipped | **Historical** | This is an August incident tied to named commits and failures. Its fresh-tip rerun recipe is not the current operating procedure when a frozen queue exists. |
| 2026-08-13 | Checkpoint speedup follow-up | shipped | **Keep** | Preflight rejection, bounded scheduling, conservative verdict reuse and explicit timing remain useful. The current runner already implements the budgeted scheduling/reuse family. |
| 2026-08-13 | Quiet integration red repair | shipped | **Historical** | The original saved-prompts/blueprint/recycle failure cluster was an incident, with deliberate drops and a recorded residual flake. Replaying its six-file story is not a new system improvement. |
| 2026-08-14 | Torn-sweep resilience | shipped | **Revise** | Stale-versus-real failure classification remains useful, but current retriage resolves the frozen lineage whenever a queue exists. The plan itself rejected per-package sweeps and the proposed budget-reserve mechanism. |
| 2026-08-17 | Fork/memory red-streak root cause | shipped | **Keep** | Deriving the per-run memory envelope from worker policy and bounding concurrent roots still addresses a real class of failure. The current helper and cross-root admission tests pass. |
| 2026-08-19 | Stop chasing the tip | shipped | **Revise** | The frozen-candidate principle and conservative proof reuse remain foundational. Its original repair-authoring-worktree/merge procedure was refined and partly replaced by later exact/hunk admission. |
| 2026-08-20 | Repair frozen-gate lineage | shipped | **Historical** | Its prohibition on promoting isolated repair heads is explicitly superseded. Current code permits the exact fully tested repairHead with ancestry and admission-membership proof. |
| 2026-08-20 | Restore main green / SSE boundary | shipped | **Historical** | The August SSE/compiler incident is historical. Today's package contract deliberately uses native TypeScript 7 plus a TypeScript 6 API boundary, not the plan's TypeScript 5.9 pin. |
| 2026-08-23 | Stable-candidate related gate | shipped | **Revise** | Related selection, immutable dependencies, exact verdict identity and certification remain core. The very broad plan also contains many consumed incident permissions and later-replaced procedures. |
| 2026-08-25 | Green main fast | shipped | **Revise** | Hygiene separation, typed exits, object-based materialization and ownership remain useful. Its automatic candidate-escape item and portions of its operational sweep were superseded or dropped. |
| 2026-08-25 | Qualification transaction | shipped | **Keep** | A durable logical attempt, exact identity, eligibility and a single physical runner remain the right structure. Current transaction tests pass; newer attempt-identity defects are incremental repairs in that structure. |
| 2026-08-27 | Fix-only frozen-candidate admission | shipped | **Revise** | Fix-only admission is still the governing idea. The one-off 62-file allowlist and worktree-authoring recipe were replaced by the later common admission door and hunk ledger. |
| 2026-08-27 | Candidate outlives its repair | draft | **Consolidate** | The purpose survives, but the stronger current rule removes age-based queue decisions entirely. Its conditional reuse/verification work overlaps later cache, typed-signature and zero-wait plans. |
| 2026-08-28 | Declared-gate liveness watchdog | draft | **Redesign draft** | The failure mode is credible, but the proposal remains a scaffold. Current event catalog/status already expose stale declarers and live successors, so part of the proposed discovery layer exists. |
| 2026-08-28 | Dependency-generation critical path | shipped | **Keep** | Immutable generation identity, per-tree reuse, publication tokens and prebuild before the serialized gate remain useful and implemented. The present consumer still validates the publication contract. |
| 2026-08-28 | Test-suite recovery | ready | **Revise** | A trustworthy complete run with actual Vitest/Cargo execution remains necessary. P-004's current-HEAD wording conflicts with its newer D-028 repairHead requirement and its later evidence rules. |
| 2026-08-30 | Frozen-candidate compliance | shipped | **Revise** | Edit-time routing and containment/completion honesty remain needed. The earlier convergence-to-tip mechanism and parts of the repair-worktree route were explicitly replaced. |
| 2026-08-31 | Gate-audit hardening | shipped | **Keep** | A composed status oracle, standing-red ownership escalation and fixer-succession alarm remain appropriate. They observe failures; they do not by themselves prove successful repair. |
| 2026-08-31 | Gate speed, round two | shipped | **Keep** | The scarcity-aware PSI guard and reduction of actual work remain relevant. The plan already corrected its exaggerated flake/cache claims and rejected lane rebalance/fork-cap increases. |
| 2026-08-31 | Verdict liveness and repair reliability | shipped | **Revise** | Per-fire outcome truth, bounded pauses, no-verdict alarms and fixer survival remain important. Its recut escape and repair-authoring-worktree persistence clauses conflict with newer architecture. |
| 2026-09-02 | Make the freeze actually hold | awaiting-acceptance | **Revise** | Transient provider unavailability must not mean abandoning a candidate. However, the later age-free invariant supersedes some bounded-hold wording, and its no-active-rubric argument does not prove predecessors lacked validation. |
| 2026-09-03 | Frozen through every fix | shipped | **Keep** | Candidate plus admitted fix hunks, typed failure legs, exact-head verification/promotion, and no automatic age recut match current source and passing policy tests. |
| 2026-09-03 | Visible main-greening status | shipped | **Keep** | Named non-test legs, measuredness, freshness and one composed explanation are still needed. This is visibility over the gate, not a substitute for fixing it. |
| 2026-09-04 | System audit / red-streak elimination | ready | **Revise** | The architecture and promise-to-implementation audit remains relevant. Its fixed fifteen-day window and live-candidate baseline are historical; carrying those as current instructions would misdirect work. |
| 2026-09-05 | Progress-certified release trace | draft | **Keep** | The current certificate correctly treats absent/equal-fallback/stale-cache signals as unknown and preserves the retriage interlock. It replaces the two older overlapping trace proposals. |
| 2026-09-06 | Selection and retry latency policy | shipped | **Keep** | The higher selection threshold, conservative executed-source pruning, failure-shaped retries and one bounded retry pool exist in current code and fit the current system. |
| 2026-09-07 | Carry/launch fail-closed policy | ready | **Keep** | The safety requirement remains relevant, and both shell doors already apply the shared policy; focused handler/policy tests pass. Its P-005 todo state is stale relative to that wiring. |
| 2026-09-08 | Zero-wait convergence | awaiting-acceptance | **Revise** | Event-triggered repair verification, scoped retesting and latency visibility remain high-value. R5/R6 prose overstates the implemented exceptions, and P-007's plan/WI completion evidence is inconsistent. |

## Per-plan reasoning and disposition

### Deploy trigger and gate unblock

Canonical plan: `deploy-trigger-and-gate-unblock-2026-06-21`; reviewed revision 8; created 2026-06-21. **Consolidate.**

The deploy/status/force surfaces and staleness watchdog exist. The old rule tying trigger to the latest gate color is obsolete: today a previously certified green pin can deploy while a newer candidate is red.

Recommended disposition: Retain the safety policy; close or merge the old checklist after reconciling its six unparsed legacy items with current deployment/certification behavior.

Evidence: [D: Deploy and diagnosis](#evidence-d). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Release-gate triage hardening

Canonical plan: `release-gate-triage-hardening-2026-07-10`; reviewed revision 54; created 2026-07-10. **Revise.**

Failure parsing, run logs and staleness diagnosis remain useful. Its tip-based refire language and persona/route work predate the current frozen-lineage policy and instruction layers.

Recommended disposition: Keep the diagnostic guards; replace old candidate-selection instructions and split the remaining process-policy item from gate recovery.

Evidence: [D: Deploy and diagnosis](#evidence-d); [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Gate-ownership singleton

Canonical plan: `gate-ownership-condition-singleton-2026-08-03`; reviewed revision 47; created 2026-08-03. **Keep.**

The condition-keyed owning object, database uniqueness, independent holder-liveness check and LIVE_GATE_OPS boundary remain current. This is established shared infrastructure, not a new owner system to rebuild.

Recommended disposition: Finish/reconcile acceptance evidence and stale Now/Promoted text; preserve the existing singleton and the separation from independent gate development.

Evidence: [O: Ownership and visible state](#evidence-o). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Gate-ownership follow-up

Canonical plan: `gate-ownership-followup-2026-08-08`; reviewed revision 29; created 2026-08-09. **Keep.**

The workspace propagation fix and red-streak condition are still part of the current bridge. The original duplicate-row purge was one-time cleanup, not a recurring operation.

Recommended disposition: Retain the scoped bridge and ownership pointer tests; close evidence debt without rerunning historical cleanup.

Evidence: [O: Ownership and visible state](#evidence-o). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Gate-suite speedup

Canonical plan: `gate-suite-speedup-2026-08-12`; reviewed revision 70; created 2026-08-12. **Keep.**

Work reduction, pure/stateful isolation boundaries and bounded resources remain sound. The plan's old timings, fork-knee measurements and pollution observations are not current capacity guarantees.

Recommended disposition: Preserve landed optimizations; remeasure before any further tuning. Do not infer permission for global isolate:false or higher concurrency.

Evidence: [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Main-gate recovery

Canonical plan: `main-gate-recovery-2026-08-12`; reviewed revision 14; created 2026-08-12. **Historical.**

This is an August incident tied to named commits and failures. Its fresh-tip rerun recipe is not the current operating procedure when a frozen queue exists.

Recommended disposition: Keep the incident record and recurrence guards; use the current singleton and exact-lineage procedure for today's incident.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [D: Deploy and diagnosis](#evidence-d). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Checkpoint speedup follow-up

Canonical plan: `green-checkpoint-speedup-follow-up-2026-08-13`; reviewed revision 25; created 2026-08-13. **Keep.**

Preflight rejection, bounded scheduling, conservative verdict reuse and explicit timing remain useful. The current runner already implements the budgeted scheduling/reuse family.

Recommended disposition: Do not duplicate it; validate future tuning against the present global envelope and fix the newly failing cache wiring assertion.

Evidence: [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Quiet integration red repair

Canonical plan: `quiet-integration-red-repair-2026-08-13`; reviewed revision 44; created 2026-08-13. **Historical.**

The original saved-prompts/blueprint/recycle failure cluster was an incident, with deliberate drops and a recorded residual flake. Replaying its six-file story is not a new system improvement.

Recommended disposition: Retain the repaired contracts/tests and separately owned residuals. Do not resurrect dropped gate/deployment dependencies or treat its old green sample as a permanent flake-free guarantee.

Evidence: [I: Historical repair contracts](#evidence-i). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Torn-sweep resilience

Canonical plan: `gate-resilience-vs-torn-git-sync-sweeps-retry-failing-files-2026-08-14`; reviewed revision 34; created 2026-08-14. **Revise.**

Stale-versus-real failure classification remains useful, but current retriage resolves the frozen lineage whenever a queue exists. The plan itself rejected per-package sweeps and the proposed budget-reserve mechanism.

Recommended disposition: Keep the classification guards; rewrite old next-tip wording to the actual guarded resolver. Do not rebuild either rejected mechanism.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Fork/memory red-streak root cause

Canonical plan: `green-checkpoint-red-streak-root-cause-2026-08-17`; reviewed revision 33; created 2026-08-17. **Keep.**

Deriving the per-run memory envelope from worker policy and bounding concurrent roots still addresses a real class of failure. The current helper and cross-root admission tests pass.

Recommended disposition: Keep the anti-drift and cross-root guards. Treat the original fork benchmark and pressure readings as dated evidence, not present-day performance targets.

Evidence: [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Stop chasing the tip

Canonical plan: `gate-stop-chasing-the-tip-2026-08-19`; reviewed revision 53; created 2026-08-19. **Revise.**

The frozen-candidate principle and conservative proof reuse remain foundational. Its original repair-authoring-worktree/merge procedure was refined and partly replaced by later exact/hunk admission.

Recommended disposition: Use it as design history and retain the cache contract; consolidate operational instructions into the September lineage plan instead of reviving the old worktree route.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Repair frozen-gate lineage

Canonical plan: `repair-frozen-gate-lineage-2026-08-20`; reviewed revision 15; created 2026-08-20. **Historical.**

Its prohibition on promoting isolated repair heads is explicitly superseded. Current code permits the exact fully tested repairHead with ancestry and admission-membership proof.

Recommended disposition: Mark the old operating recipe as superseded in a later approved cleanup. Do not implement its original promotion veto again.

Evidence: [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Restore main green / SSE boundary

Canonical plan: `restore-papercusp-main-green-2026-08-20`; reviewed revision 27; created 2026-08-20. **Historical.**

The August SSE/compiler incident is historical. Today's package contract deliberately uses native TypeScript 7 plus a TypeScript 6 API boundary, not the plan's TypeScript 5.9 pin.

Recommended disposition: Retain package-owned compiler-boundary testing and distinct candidate/repair-head labels; never restore the old compiler pin merely to conform to this plan.

Evidence: [I: Historical repair contracts](#evidence-i); [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Stable-candidate related gate

Canonical plan: `stable-candidate-related-gate-2026-08-23`; reviewed revision 275; created 2026-08-23. **Revise.**

Related selection, immutable dependencies, exact verdict identity and certification remain core. The very broad plan also contains many consumed incident permissions and later-replaced procedures.

Recommended disposition: Consolidate the live contract with newer focused plans and retire old one-shot launch/emit instructions. Earliest retained history begins at revision 176, so the original draft cannot be fully reconstructed.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [P: Selection, cache, resources and dependencies](#evidence-p); [Q: Logical qualification](#evidence-q). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Green main fast

Canonical plan: `green-main-fast-2026-08-25`; reviewed revision 114; created 2026-08-25. **Revise.**

Hygiene separation, typed exits, object-based materialization and ownership remain useful. Its automatic candidate-escape item and portions of its operational sweep were superseded or dropped.

Recommended disposition: Preserve the landed components; rewrite the umbrella around current invariants rather than replaying all items. Earliest retained history starts at revision 15.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [L: Liveness and accountability](#evidence-l); [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Qualification transaction

Canonical plan: `main-gate-qualification-transaction-acceleration-2026-08-25`; reviewed revision 54; created 2026-08-25. **Keep.**

A durable logical attempt, exact identity, eligibility and a single physical runner remain the right structure. Current transaction tests pass; newer attempt-identity defects are incremental repairs in that structure.

Recommended disposition: Keep this mechanism, consolidate its deployment/mitigation residues, and require measured runtime evidence before asserting it now guarantees timely green.

Evidence: [Q: Logical qualification](#evidence-q). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Fix-only frozen-candidate admission

Canonical plan: `converge-frozen-candidate-by-fix-only-admission-2026-08-27`; reviewed revision 36; created 2026-08-27. **Revise.**

Fix-only admission is still the governing idea. The one-off 62-file allowlist and worktree-authoring recipe were replaced by the later common admission door and hunk ledger.

Recommended disposition: Retain exactness and dependency-completeness requirements; route work through the current admission system, not the historical manual recipe.

Evidence: [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Candidate outlives its repair

Canonical plan: `frozen-candidate-outlives-its-repair-2026-08-27`; reviewed revision 23; created 2026-08-27. **Consolidate.**

The purpose survives, but the stronger current rule removes age-based queue decisions entirely. Its conditional reuse/verification work overlaps later cache, typed-signature and zero-wait plans.

Recommended disposition: Carry any genuinely missing operational evidence into those current plans; do not keep a separate timer-extension implementation alive.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Declared-gate liveness watchdog

Canonical plan: `declared-gate-liveness-watchdog-with-timeout-classification-2026-08-28`; reviewed revision 6; created 2026-08-28. **Redesign draft.**

The failure mode is credible, but the proposal remains a scaffold. Current event catalog/status already expose stale declarers and live successors, so part of the proposed discovery layer exists.

Recommended disposition: Specify the remaining proactive detection/recovery gap, ownership, idempotence, timeout semantics and false-alarm tests before authorizing implementation. Do not add a parallel watchdog from the title alone.

Evidence: [E: Progress and declared events](#evidence-e). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Dependency-generation critical path

Canonical plan: `dependency-generation-critical-path-2026-08-27`; reviewed revision 26; created 2026-08-28. **Keep.**

Immutable generation identity, per-tree reuse, publication tokens and prebuild before the serialized gate remain useful and implemented. The present consumer still validates the publication contract.

Recommended disposition: Preserve correctness boundaries. Rebaseline the two-minute/cache-ready and incremental-build latency claims; this audit does not prove those historical SLOs on the current host.

Evidence: [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Test-suite recovery

Canonical plan: `test-suite-recovery-2026-08-27`; reviewed revision 66; created 2026-08-28. **Revise.**

A trustworthy complete run with actual Vitest/Cargo execution remains necessary. P-004's current-HEAD wording conflicts with its newer D-028 repairHead requirement and its later evidence rules.

Recommended disposition: Rewrite the remaining acceptance procedure around the current authoritative run identity, and consume the existing owner's proof. Do not launch another standalone recovery run from the old text.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [Q: Logical qualification](#evidence-q). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Frozen-candidate compliance

Canonical plan: `frozen-candidate-compliance-enforcement-2026-08-30`; reviewed revision 37; created 2026-08-30. **Revise.**

Edit-time routing and containment/completion honesty remain needed. The earlier convergence-to-tip mechanism and parts of the repair-worktree route were explicitly replaced.

Recommended disposition: Keep the enforcement surfaces but align every instruction with current hunk-exact admission and the carry/launch guard. Do not rebuild the retired convergence behavior.

Evidence: [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Gate-audit hardening

Canonical plan: `gate-audit-hardening-2026-08-31`; reviewed revision 13; created 2026-08-31. **Keep.**

A composed status oracle, standing-red ownership escalation and fixer-succession alarm remain appropriate. They observe failures; they do not by themselves prove successful repair.

Recommended disposition: Retain and validate the observation/escalation surfaces. Keep their effectiveness claims separate from the gate engine's current ability to reach green.

Evidence: [O: Ownership and visible state](#evidence-o); [L: Liveness and accountability](#evidence-l). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Gate speed, round two

Canonical plan: `gate-speed-round-2-2026-08-31`; reviewed revision 41; created 2026-08-31. **Keep.**

The scarcity-aware PSI guard and reduction of actual work remain relevant. The plan already corrected its exaggerated flake/cache claims and rejected lane rebalance/fork-cap increases.

Recommended disposition: Keep its landed improvements and corrected decisions. Reprofile before choosing another optimization target; do not reuse the old numeric rankings as current evidence.

Evidence: [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Verdict liveness and repair reliability

Canonical plan: `gate-verdict-liveness-and-repair-reliability-2026-08-31`; reviewed revision 57; created 2026-08-31. **Revise.**

Per-fire outcome truth, bounded pauses, no-verdict alarms and fixer survival remain important. Its recut escape and repair-authoring-worktree persistence clauses conflict with newer architecture.

Recommended disposition: Keep the observability/recovery components; replace retired queue-exit/authoring instructions and validate the assembled operational behavior. Its shipped label is not a time-to-green guarantee.

Evidence: [L: Liveness and accountability](#evidence-l); [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Make the freeze actually hold

Canonical plan: `frozen-candidate-freeze-actually-holds-2026-09-02`; reviewed revision 20; created 2026-09-02. **Revise.**

Transient provider unavailability must not mean abandoning a candidate. However, the later age-free invariant supersedes some bounded-hold wording, and its no-active-rubric argument does not prove predecessors lacked validation.

Recommended disposition: Retain the capacity-hold behavior; correct the rationale and old bounds, refresh stale citations, and obtain the explicitly required live freeze/resume evidence.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [L: Liveness and accountability](#evidence-l). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Frozen through every fix

Canonical plan: `frozen-candidate-stays-frozen-through-all-fixes-2026-09-03`; reviewed revision 78; created 2026-09-03. **Keep.**

Candidate plus admitted fix hunks, typed failure legs, exact-head verification/promotion, and no automatic age recut match current source and passing policy tests.

Recommended disposition: Treat this as the primary lineage contract, including its later D-010 authoring-route change and ledger atomicity requirements. Keep operational acceptance honest while the live owner repairs remaining defects.

Evidence: [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Visible main-greening status

Canonical plan: `main-green-status-visible-2026-09-03`; reviewed revision 45; created 2026-09-03. **Keep.**

Named non-test legs, measuredness, freshness and one composed explanation are still needed. This is visibility over the gate, not a substitute for fixing it.

Recommended disposition: Preserve typed per-leg and unknown-state contracts; reconcile raw legacy labels with current declared fields and test the producer-to-reader path on future changes.

Evidence: [O: Ownership and visible state](#evidence-o); [L: Liveness and accountability](#evidence-l). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### System audit / red-streak elimination

Canonical plan: `green-main-system-audit-and-red-streak-elimination-2026-09-04`; reviewed revision 29; created 2026-09-04. **Revise.**

The architecture and promise-to-implementation audit remains relevant. Its fixed fifteen-day window and live-candidate baseline are historical; carrying those as current instructions would misdirect work.

Recommended disposition: Update the audit scope/baseline to this reconciled portfolio and carry only evidence-backed residuals. Keep source/runtime/observed-outcome distinctions and avoid another open-ended inventory loop.

Evidence: [A: Plan/acceptance authority](#evidence-a); [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Progress-certified release trace

Canonical plan: `progress-certified-release-trace-2026-09-05`; reviewed revision 24; created 2026-09-05. **Keep.**

The current certificate correctly treats absent/equal-fallback/stale-cache signals as unknown and preserves the retriage interlock. It replaces the two older overlapping trace proposals.

Recommended disposition: Finish the recorded acceptance chain and retain the published limits: the ten-minute stall threshold is judgment, not a newly proven production calibration.

Evidence: [E: Progress and declared events](#evidence-e); [L: Liveness and accountability](#evidence-l). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Selection and retry latency policy

Canonical plan: `gate-latency-selection-and-retry-policy-2026-09-06`; reviewed revision 20; created 2026-09-06. **Keep.**

The higher selection threshold, conservative executed-source pruning, failure-shaped retries and one bounded retry pool exist in current code and fit the current system.

Recommended disposition: Keep the fail-wide/unknown-provenance safeguards. Recheck performance on current workloads; do not promise the captured September 5 speedup as a universal result.

Evidence: [P: Selection, cache, resources and dependencies](#evidence-p). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Carry/launch fail-closed policy

Canonical plan: `frozen-candidate-carry-and-launch-fail-closed-2026-09-07`; reviewed revision 10; created 2026-09-07. **Keep.**

The safety requirement remains relevant, and both shell doors already apply the shared policy; focused handler/policy tests pass. Its P-005 todo state is stale relative to that wiring.

Recommended disposition: Reconcile completed implementation versus remaining acceptance/entry-path proof before closure. Preserve legitimate focused development tests and safe negative/positive controls.

Evidence: [F: Frozen lineage and enforcement](#evidence-f). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

### Zero-wait convergence

Canonical plan: `green-gate-zero-wait-convergence-2026-09-08`; reviewed revision 22; created 2026-09-08. **Revise.**

Event-triggered repair verification, scoped retesting and latency visibility remain high-value. R5/R6 prose overstates the implemented exceptions, and P-007's plan/WI completion evidence is inconsistent.

Recommended disposition: Clarify the exact contracts, repair evidence/grade debt and test the actual operational loop. The current owner's redundant-refire defect means this cannot yet be called operationally solved.

Evidence: [F: Frozen lineage and enforcement](#evidence-f); [P: Selection, cache, resources and dependencies](#evidence-p); [L: Liveness and accountability](#evidence-l). The current/earliest plan snapshots preserve the requirement and decision text behind this comparison.

## Tracker and superseded aliases

- `ship-main-greening-plans-2026-08-29` (created August 29, ready): **Keep only as the original eight-plan tracker.** Seven children are recorded shipped; test-suite recovery remains. It is not a complete map of the later September program. Its original snapshot of gate holders/candidates must not become executable authority. WI-762558 remains with the live gate driver; this audit did not take that lane.
- `active-checkpoint-truth-capsule-on-release-trace-2026-08-14` and `progress-certified-release-trace-for-active-checkpoint-candi-2026-08-14`: **Remain superseded.** The September 5 progress-certified trace plan is their deliberate merger; restarting either would split one mechanism into duplicate work.

## Principal cross-plan findings

1. **Promotion policy changed materially.** The August 20 isolated-repair veto was replaced by exact tested repairHead promotion with ancestry and admission-membership proof. The old recipe is unsafe as present guidance. See F and the September 3 plan's D-004/D-010.
2. **Timer/recut designs were removed, not merely retuned.** Current queue decisions omit maxAgeMs/maxCandidateEscapes; age can drive visibility without replacing the candidate. Several older done items still describe the deleted mechanisms. See F and the September 3 plan's D-011.
3. **The compiler stack changed materially.** The old SSE repair specifies TypeScript 5.9. The current package and a passing package-contract test explicitly require native TypeScript 7.0.2 with the TypeScript 6.0.2 API package. Restoring 5.9 would undo a newer contract. See I.
4. **Some unfinished work is already implemented.** The carry/launch plan's P-005 remains todo, but both native command checking and capability Bash invoke the shared policy; the five Bash handler tests passed. Reconcile evidence and remaining end-to-end scope instead of rebuilding the wiring. See F.
5. **Plan prose and completion ledgers disagree.** Zero-wait's Now says 3/8 done while its plan items are terminal. Its P-007 work-item WI-10000861 is still open: its checkpoint says implementation is done but exact spec-test adequacy/independent grading blocks terminal closure. That is evidence debt, not evidence the implementation never existed.
6. **Retired rubric is not absent validation.** Shipping deliberately retires the one-shot acceptance rubric. The freeze-actually-holds rationale infers unvalidated predecessors from no active rubric; that inference is not valid on this system. Historical grading and author verdicts must be inspected directly. See A.
7. **Deploying a certified pin and the newest gate color are different.** The old deploy plan requires the gate to be green. Current code/test permits a previously certified green pin to deploy while a later candidate is red, subject to in-flight/pause/certification constraints. The safe intent remains; the wording is obsolete. See D.
8. **Zero-wait's R5/R6 need precise failure semantics.** R5 has recheck/admission/probe failure outcomes in addition to regeneration failure. R6 explicitly accepts a recorded runner-failed fallback; D-002's busy-tree exception alone does not fully describe that behavior. This is a contract-review finding, not authorization to weaken it.
9. **A current cache test is stale.** Audit run 398e0863 failed the exact-string expectation `onTaskSettled: persistCleanFirstPassTaskVerdict`. The current callback first folds coverage and then calls that persistence function. The evidence contradicts removal of persistence; the static assertion needs a behavior-sensitive replacement. Filed as **EI-23072663469449933**; no fix made during audit.
10. **Ordinary retriage still exists, but its target is guarded.** The current callsite delegates to resolveRetriageTarget; it supplies the development-tip resolver only for the no-queue case. Therefore neither 'all tip retriage is obsolete' nor 'an old tip-refire instruction can override a freeze' is correct. See F/P.

## Coordination, lifecycle and churn

A bounded canonical query found 20 nonterminal work-item rows with direct source-plan or payload.plan_item provenance in this population. This is a complete result for that stated predicate, not a census of every loosely related or ad-hoc support item. Several are explicit residuals beneath shipped plans; a shipped plan does not automatically settle every linked follow-up.

The current P-007 case is illustrative: its plan item is done, its underlying WI remains open, its checkpoint records successful implementation/test evidence, and the outstanding requirement is independent proof acceptance. The holder was reported **suspect**, not dead, by a targeted presence read at 16:11:16Z. That does not authorize a takeover. Test-suite recovery's linked P-004 item is unassigned, but the separate driver WI-762558 is actively owned; an unassigned child alone does not prove an abandoned mission.

Historical worked_by_history rows for WI-332753 and WI-762558 show several different holders and repeated entries for the same holder. These records support custody churn, not a count of independent fixes. The work-item lifecycle reader explicitly warns that some nonterminal transitions were never recorded; closed_ts is not the lifecycle authority. Accordingly this audit makes **no invented closure-throughput or reopen-rate claim**.

The recurring overhead is concrete: old operative prose survives newer decisions; work-item evidence can remain unaccepted after a plan item is marked done; later rubric/spec revisions create fresh proof obligations; and old readers report false missing rubrics. Repeating inventory or recreating a rubric adds activity without repairing any of those mechanisms.

## Runtime evidence and limits

The live gate owner supplied a reply at **2026-09-12T16:12:54.451Z**, message `coord-send-73466dd6f30c0e81e3b22ad9a6350d603cc281e0570a58df7426ab1572027ed8`: a scheduled run exercised selective verification of the admitted frozen head and reported red; redundant admission refires were observed; the candidate/repair-head identity regression is being repaired as EI-23071029479486567. The owner explicitly did **not** establish a green shipment or all loaded-runtime versions.

That evidence establishes exercise of part of the current repair path, not end-to-end successful convergence. The audit requested this evidence once and did not independently operate or monitor the held live gate. Unknown runtime activation/performance remains unknown; it does not make the underlying design obsolete.

The two-minute dependency startup target, old fork/speed figures, global no-false-stall claim and full freeze-to-green time were **not remeasured in production**. Focused source/tests establish narrower current behavior. The ten-minute progress threshold remains a declared judgment, not a freshly calibrated universal bound.

## Verification performed

| Run | Scope | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
| `c655e280-82f7-4d47-b622-5b7b4440118b` | 8 lineage/admission/qualification/memory/progress files | 426 | 0 | 0 |
| `398e0863-44a1-45e2-99c0-6e8cac0d90af` | 10 selection/cache/dependency/resource/ownership/deploy/Bash files | 337 | 1 | 0 |
| `f8e163e4-8322-47af-adc0-e6005e46586b` | 4 SSE package/latency/no-cron/rate-alarm files | 43 | 0 | 0 |

The three audit batches covered **22 distinct files: 806 passing tests and one failing assertion**. No collection failure or skipped test was reported. The earlier supporting zero-wait run `c8f1c8a0-8c75-4e45-9ced-262476fdee7c` passed 98 tests in four additional files; it is separate from the audit-batch total. These are targeted regressions, not the complete repository suite.

## Evidence groups

<a id="evidence-f"></a>

### F — Frozen lineage and enforcement

- [packages/operator-core/lib/release/frozen-lineage-promotion.ts:88](@repo-root@/packages/operator-core/lib/release/frozen-lineage-promotion.ts:88)
- [packages/operator-core/lib/release/frozen-candidate-repair-queue.ts:313](@repo-root@/packages/operator-core/lib/release/frozen-candidate-repair-queue.ts:313)
- [packages/operator-core/lib/release/repair-head-admission.ts](@repo-root@/packages/operator-core/lib/release/repair-head-admission.ts)
- [packages/operator-core/lib/release/hunk-exact-admission.ts](@repo-root@/packages/operator-core/lib/release/hunk-exact-admission.ts)
- [packages/operator-core/lib/release/frozen-lineage-execution-policy.ts:652](@repo-root@/packages/operator-core/lib/release/frozen-lineage-execution-policy.ts:652)
- [packages/operator-core/lib/agent-tools/capability/bash.ts:909](@repo-root@/packages/operator-core/lib/agent-tools/capability/bash.ts:909)
- [packages/operator-core/lib/agent-tools/locks/check_command.ts:130](@repo-root@/packages/operator-core/lib/agent-tools/locks/check_command.ts:130)
- [apps/operator/lib/release/green-checkpoint.ts:12562](@repo-root@/apps/operator/lib/release/green-checkpoint.ts:12562)

<a id="evidence-p"></a>

### P — Selection, cache, resources and dependencies

- [scripts/lib/related-tests.mjs:784](@repo-root@/scripts/lib/related-tests.mjs:784)
- [scripts/lib/passing-task-verdict-cache.mjs:87](@repo-root@/scripts/lib/passing-task-verdict-cache.mjs:87)
- [scripts/affected-tests.mjs:6577](@repo-root@/scripts/affected-tests.mjs:6577)
- [scripts/affected-tests.mjs:6829](@repo-root@/scripts/affected-tests.mjs:6829)
- [libs/test-config/src/vitest-config.ts:535](@repo-root@/libs/test-config/src/vitest-config.ts:535)
- [scripts/pc-heavy.sh:610](@repo-root@/scripts/pc-heavy.sh:610)
- [packages/operator-core/lib/release/checkpoint-memory-admission.ts](@repo-root@/packages/operator-core/lib/release/checkpoint-memory-admission.ts)
- [packages/operator-core/lib/release/dependency-generation-prebuild.ts:820](@repo-root@/packages/operator-core/lib/release/dependency-generation-prebuild.ts:820)
- [apps/operator/bin/release/dependency-generation.sh:583](@repo-root@/apps/operator/bin/release/dependency-generation.sh:583)

<a id="evidence-q"></a>

### Q — Logical qualification

- [packages/operator-core/lib/release/checkpoint-qualification-transaction.ts](@repo-root@/packages/operator-core/lib/release/checkpoint-qualification-transaction.ts)
- [packages/operator-core/lib/agent-tools/release/checkpoint-run.ts](@repo-root@/packages/operator-core/lib/agent-tools/release/checkpoint-run.ts)

<a id="evidence-d"></a>

### D — Deploy and diagnosis

- [packages/operator-core/lib/agent-tools/release/deploy.ts:426](@repo-root@/packages/operator-core/lib/agent-tools/release/deploy.ts:426)
- [packages/operator-core/lib/release-deploy-launch.ts:636](@repo-root@/packages/operator-core/lib/release-deploy-launch.ts:636)
- [packages/operator-core/lib/release-deploy-launch.test.ts:231](@repo-root@/packages/operator-core/lib/release-deploy-launch.test.ts:231)
- [packages/operator-core/lib/release-deploy-staleness-watchdog.ts:141](@repo-root@/packages/operator-core/lib/release-deploy-staleness-watchdog.ts:141)
- [apps/operator/lib/release/green-checkpoint.ts:3381](@repo-root@/apps/operator/lib/release/green-checkpoint.ts:3381)

<a id="evidence-o"></a>

### O — Ownership and visible state

- [packages/operator-core/lib/coord/condition-bridge.ts:377](@repo-root@/packages/operator-core/lib/coord/condition-bridge.ts:377)
- [packages/operator-core/lib/coord/gate-ownership.ts:190](@repo-root@/packages/operator-core/lib/coord/gate-ownership.ts:190)
- [packages/operator-core/lib/system-health/condition-staleness-alarm.ts:818](@repo-root@/packages/operator-core/lib/system-health/condition-staleness-alarm.ts:818)
- [packages/operator-core/lib/git-pipeline-position.ts](@repo-root@/packages/operator-core/lib/git-pipeline-position.ts)
- [packages/operator-core/lib/cell-registrations.ts](@repo-root@/packages/operator-core/lib/cell-registrations.ts)

<a id="evidence-l"></a>

### L — Liveness and accountability

- [packages/operator-core/lib/release/gate-fire-ledger.ts:96](@repo-root@/packages/operator-core/lib/release/gate-fire-ledger.ts:96)
- [packages/operator-core/lib/release/gate-verdict-rate-alarm.ts](@repo-root@/packages/operator-core/lib/release/gate-verdict-rate-alarm.ts)
- [packages/operator-core/lib/harness/routines/release-pause-ttl.ts](@repo-root@/packages/operator-core/lib/harness/routines/release-pause-ttl.ts)
- [packages/operator-core/lib/work-items-admission.ts:708](@repo-root@/packages/operator-core/lib/work-items-admission.ts:708)
- [packages/operator-core/lib/harness/routines/release-actions.ts:2033](@repo-root@/packages/operator-core/lib/harness/routines/release-actions.ts:2033)
- [packages/operator-core/lib/release/frozen-candidate-repair-queue-latency.test.ts](@repo-root@/packages/operator-core/lib/release/frozen-candidate-repair-queue-latency.test.ts)

<a id="evidence-e"></a>

### E — Progress and declared events

- [packages/operator-core/lib/release-trace-progress.ts:179](@repo-root@/packages/operator-core/lib/release-trace-progress.ts:179)
- [packages/operator-core/lib/release-trace.ts:1104](@repo-root@/packages/operator-core/lib/release-trace.ts:1104)
- [packages/operator-core/lib/agent-tools/events/catalog.ts:332](@repo-root@/packages/operator-core/lib/agent-tools/events/catalog.ts:332)

<a id="evidence-i"></a>

### I — Historical repair contracts

- [libs/generic/sse/package.json](@repo-root@/libs/generic/sse/package.json)
- [libs/generic/sse/src/package-contract.test.ts:50](@repo-root@/libs/generic/sse/src/package-contract.test.ts:50)
- [packages/operator-core/lib/saved-prompts-store.ts:69](@repo-root@/packages/operator-core/lib/saved-prompts-store.ts:69)
- [packages/operator-core/lib/saved-prompts-store.integration.test.ts:141](@repo-root@/packages/operator-core/lib/saved-prompts-store.integration.test.ts:141)
- [apps/operator/lib/psu-pty-host-turn.integration.test.ts](@repo-root@/apps/operator/lib/psu-pty-host-turn.integration.test.ts)

<a id="evidence-a"></a>

### A — Plan/acceptance authority

- [packages/operator-core/lib/agent-tools/plans/source.ts:1](@repo-root@/packages/operator-core/lib/agent-tools/plans/source.ts:1)
- [packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts:624](@repo-root@/packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts:624)
- [packages/operator-core/lib/agent-tools/plans/set-plan-status.ts:645](@repo-root@/packages/operator-core/lib/agent-tools/plans/set-plan-status.ts:645)
- [packages/operator-core/lib/plan-acceptance-gate.ts:438](@repo-root@/packages/operator-core/lib/plan-acceptance-gate.ts:438)
- [packages/operator-core/lib/rubrics.ts:4086](@repo-root@/packages/operator-core/lib/rubrics.ts:4086)

## Scope, reproducibility and coverage

Source review began at HEAD `3b70897e7a12d0e5c407198cc9440e12f90c7e75`; the final source/readback checkpoint was `8bbb044a8d791b118e7488a4e439d7a4a7ca258b`. The shared tree advanced during the audit. Findings are tied to the cited code and captured test runs; they are not a claim that no later edit occurred. Final metadata read resolved all 36 named records without truncation and found no version change from the captured plan snapshots.

Exact snapshots and machine-readable verdict/coverage data are under `.papercusp/scratch/main-greening-audit-2026-09-12/`: `current-plans.json`, `original-plans.json`, and `final-verdicts.json`. The first two retain the complete retrieved payload, even where the reading pass selected relevant requirement/decision sections rather than replaying historical logs verbatim. Earlier retained history is incomplete for Green main fast (starts at revision 15) and Stable-candidate related gate (starts at revision 176); several other first revisions are empty templates. Those limits are recorded, not filled from memory.

Coverage meaning: **checked** means the plan's relevance and current mechanism/decision relationship were reviewed at the stated audit depth. It does not mean every requirement was certified met or every historic claim reproduced. All 33 primary plans plus the tracker and two aliases are checked. No population member was silently dropped. Residue is operational recertification, historical revision gaps, and the newly filed stale assertion—not an unfinished relevance verdict.

## Recommended execution order

1. Reconcile operative plan text against the current candidate, compiler and execution contracts. Preserve history while clearly identifying what no longer governs.
2. Consolidate the old deploy checklist and outlives-timer work into their current mechanisms, carrying exact residual evidence instead of duplicating implementation. Retain the four incident plans as historical records.
3. Repair the independently reproduced stale cache assertion (EI-23072663469449933) with a guard that verifies persistence through the wrapper.
4. Finish evidence/acceptance debt for genuinely current designs, especially carry/launch, ownership, progress trace and zero-wait; reconcile P-007's two completion ledgers and its current holder before doing duplicate work.
5. Let the single live gate owner supply one correlated operational proof where multiple plans require the same property. Do not run separate copies of the same expensive gate for each plan.
6. Design only the remaining declared-gate recovery gap after comparing the existing announcement ownership and timeout machinery. The current draft does not justify a second general watchdog.

No audited subject was changed. These are recommendations for the next execution phase, not already-applied revisions or newly shipped plans.

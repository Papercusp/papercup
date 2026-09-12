# Main-greening plan relevance audit — in progress

Owner: Avi. Audit requested 2026-09-12. This is an unfinished audit, not a shipment recommendation or a completed per-plan verdict. AUTO remains active with AUDIT mode; implementation and plan-status changes are paused while the requested relevance review is performed.

Registration: WI-2144981 / P-005 of green-main-system-audit-and-red-streak-elimination-2026-09-04. The scope is the 33 primary plans in main-greening-plan-portfolio-2026-09-12.md, the original eight-plan tracker, and two superseded release-trace aliases needed to interpret the lineage.

## Evidence captured

- Current canonical content, status, creation date, revision and archive flag for all 36 records: `.papercusp/scratch/main-greening-audit-2026-09-12/current-plans.json`.
- Earliest retained revision, rationale and content for the same 36 records: `.papercusp/scratch/main-greening-audit-2026-09-12/original-plans.json`.
- History limitation: `green-main-fast-2026-08-25` starts at retained revision 15; `stable-candidate-related-gate-2026-08-23` starts at revision 176. Those are not original creation drafts. Several other first revisions are empty starter templates, so their substantive later design remains the relevant source.
- Current source inspection began at repository HEAD `3b70897e7a12d0e5c407198cc9440e12f90c7e75`; the shared tree can advance. Final citations need blob/HEAD reconciliation before final delivery.
- Reviewed the plan writer in `packages/operator-core/lib/agent-tools/plans/source.ts` and `with-plan-lock.ts`: content is canonical; items, decisions, status, created and Now columns are derived together on a plan write. Revision volume does not count unique delivered features.

## Verified findings so far

### A1. The old repair-lineage promotion rule is superseded

`repair-frozen-gate-lineage-2026-08-20` P-001/D-001 says isolated repair heads are verification-only and must return to a canonical development commit for promotion. The September 3 `frozen-candidate-stays-frozen-through-all-fixes` plan explicitly replaces that veto. Current `packages/operator-core/lib/release/frozen-lineage-promotion.ts` requires the judged SHA to equal repairHead, descend from the frozen candidate, and be in the admission lineage; unreadable proof refuses. Its source comment documents the supersession. The August 20 plan is valuable incident history, but its operating recipe must not be reused as the current design.

### A2. Age-based candidate release/escape plans contain retired mechanisms

Current `packages/operator-core/lib/release/frozen-candidate-repair-queue.ts` documents deletion of both `maxCandidateEscapes` and `maxAgeMs`. The current decision function does not use queue age to select a replacement candidate. The `outlives-its-repair` plan's timer repair, `green-main-fast` P-048 escape hatch, and `gate-verdict-liveness-and-repair-reliability` P-008 escape text must be reconciled against the stronger September 3/4 invariant. Preserve the purpose—surviving slow repair and exposing stalls—but do not restore deleted automatic recuts.

### A3. The test-suite recovery acceptance text is stale within its own plan

`test-suite-recovery-2026-08-27` P-004 still says current HEAD. Its D-028 explicitly supersedes the prior cut policy while a frozen repair queue exists: verification must use the existing repairHead. Subsequent acceptance decisions also split compound bars and require exact test-layer evidence. The goal of a trustworthy complete suite remains relevant; the remaining execution instructions need reconciliation before use. The other live owner is responsible for this plan and its gate dependency.

### A4. The carry/launch plan has a code-versus-ledger mismatch

`frozen-candidate-carry-and-launch-fail-closed-2026-09-07` lists P-005 as todo. Current `agent-tools/capability/bash.ts` imports/evaluates the shared shell policy and applies its refusal before both background and foreground spawn; `agent-tools/locks/check_command.ts` evaluates the same policy and returns a block. This disproves absence of the named wiring. It does not by itself prove every P-005/P-006 acceptance condition; handler tests and remaining real-entry-path proof must be audited before closure.

### A5. No active acceptance rubric is not evidence of no historical validation

`frozen-candidate-freeze-actually-holds-2026-09-02` uses the absence of active rubrics on three shipped predecessor plans as evidence that they never underwent validation. Current `agent-tools/plans/set-plan-status.ts` calls `retireAcceptanceRubricForPlan` on ship; `plan-acceptance-gate.ts` resolves retired acceptance rubrics for shipped subjects. Therefore that inference is invalid on the current system. Read the retired rubric, historical scorecards and author verdict before judging each predecessor. The freeze-hold defect can still be real independently of this bad inference.

### A6. Zero-wait remains relevant, but two absolute promises need reconciliation

The existing R5 code returns typed recheck/admission/probe failures in addition to regeneration failure, although R5 prose says it fails only when regeneration fails. R6's evaluator/wiring explicitly accepts and records `runner-failed`, while D-002 explicitly discusses the busy-checkpoint exception. The source and tests are consistent with each other; the written acceptance contract needs to describe the intended exceptions accurately rather than have a grader infer a stricter behavior from prose. Do not weaken requirements or silently alter code during this audit.

### A7. The older diagnostic-retry plans are not a substitute for exact-lineage repair

The July triage plan and August torn-sweep resilience plan discuss comparing failures against a newer tip and refiring. Current source retains ordinary retriage/classification functions, while the September freeze policy governs candidate identity. These plans need a branch-specific applicability check: diagnostics and ordinary no-queue behavior may remain valid; a stale recipe cannot authorize moving an active frozen candidate. Final source review must follow the call-site guards, not conclude retirement from the function name alone.

### A8. Recorded shipment and runtime effectiveness are separate

The existing system-audit D-002 requires actual controller activation and a correlated operational cycle for control-plane effectiveness. Current-tree tests establish code behavior but not loaded-controller behavior. Live gate owner `su-c7b7f864-27ce-4053-b90e-ea9eb638e21d` was asked once for current runtime/version and exercised-mechanism evidence (`coord-send-2a24e6133ab8c0f7e4c725f6e77e26d579c386e34f314e24512e812f9297dfda`); they acknowledged recovery was in progress. Do not add an independent gate monitor.

## Fresh test evidence

Audit run `c655e280-82f7-4d47-b622-5b7b4440118b`: 426 passed, 0 failed, 0 skipped across eight files.

| Test file | Passed |
| --- | ---: |
| `packages/operator-core/lib/release-trace-progress.test.ts` | 36 |
| `packages/operator-core/lib/release/checkpoint-memory-admission.test.ts` | 17 |
| `packages/operator-core/lib/release/checkpoint-qualification-transaction.test.ts` | 12 |
| `packages/operator-core/lib/release/frozen-lineage-execution-policy.test.ts` | 55 |
| `packages/operator-core/lib/release/frozen-lineage-never-reads-tip.test.ts` | 252 |
| `packages/operator-core/lib/release/frozen-lineage-promotion.test.ts` | 10 |
| `packages/operator-core/lib/release/hunk-exact-admission.test.ts` | 13 |
| `packages/operator-core/lib/release/repair-head-admission.test.ts` | 31 |

The earlier same-task zero-wait verification run `c8f1c8a0-8c75-4e45-9ced-262476fdee7c` passed 98 tests across generated-artifact self-heal, admission precheck, repair-queue wiring and lockfile convergence. These runs cover related mechanisms, not the entire portfolio or the full gate.

## Remaining audit work

1. Finish source/call-site and test checks for performance/selection/cache/dependency-generation, deployment/ownership, observation/liveness, legacy incident repairs, and the proposed declared-gate watchdog. Do not treat a single search or a done status as proof.
2. Read relevant decision bodies behind the recovered titles, including supersession and rejected-mechanism decisions. Follow references only where needed for a specific verdict; large plans contain extensive historical snapshots.
3. Compare Now text to authoritative item states for each open plan. Inspect linked current work-item ownership/liveness, completion evidence and reopen/worker-history where it explains repeated work; respect the existing live gate owner.
4. Reconcile peer-supplied runtime evidence; mark genuinely unavailable live claims unverified. Do not wait for a green verdict to finish a relevance audit.
5. Write the final 33-row brief with creation dates, verdict, explanation and evidence links, plus the tracker/alias disposition. Classify separately: keep current design; revise obsolete portions; covered by later work; historical incident; needs concrete design/evidence.
6. Record a canonical coverage partition (population, checked, notChecked, notApplicable, residue), complete only the audit deliverable actually performed, deliver the report, and explicitly exit AUDIT mode. Do not resume subject mutations before the standalone exit succeeds.

## Subject-mutation record

No audited code, plan status, plan text, rubric, or acceptance outcome has been changed by this audit. Only audit snapshots, this report, coordination, modes and checkpoints have been written.

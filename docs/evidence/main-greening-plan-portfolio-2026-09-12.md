# Main-greening improvement plans — shipment portfolio

Measured 2026-09-12, approximately 15:19–15:22 UTC. This is a status and work-scope snapshot, not a claim that the gate is green or that every implementation has been independently reverified.

Avi requested recovery of session `5d081880-b3fe-4d0c-97ab-bf5369ee696b`, AUTO continuation, and then expanded the instruction to find all main-greening improvement plans and carry them to shipped. Driver: `su-035a0fd3-1e9e-4132-9b63-24b72125ea2e`. Existing registration: `WI-2144981`, P-005 of `green-main-system-audit-and-red-streak-elimination-2026-09-04`; the driver also holds `WI-10001019` for zero-wait acceptance. The warm AUTO work loop is armed at 60 seconds.

## Scope and evidence

The reconciled set contains **33 directly related primary plans: 21 recorded as shipped and 12 not shipped**. The original eight-plan tracker, `ship-main-greening-plans-2026-08-29`, remains ready and is tracked separately rather than counted as a second implementation of its children. Seven of its eight child plans are shipped; `test-suite-recovery-2026-08-27` remains ready.

Sources: the original tracker and `WI-762558`; the completed P-003 inventory (`WI-2144527`); current `plans:get` item/status reads; and a bounded exact-slug read of `harness_shared.harness_plans`, scoped to `workspace_id = papercusp-workspace` and `harness_slug = papercusp`. The exact-slug query returned the 33 named rows without truncation. Current acceptance blockers were read through the staging MCP endpoint on port 3170.

Membership includes gate execution, candidate identity and repair, dependency preparation, qualification, recovery, gate ownership, and their observability/control. It excludes acceptance-rubric wrapper plans, superseded aliases, generic inference-gateway work, general fleet tooling, and desktop-release packaging. `declared-gate-liveness-watchdog-with-timeout-classification-2026-08-28` is included because its Background explicitly describes a dead producer leaving downstream release work parked. This is the current reconciled scope, not proof that no additional relevant plan can be discovered in prose-only references.

## Open plans

| Plan | Recorded status | Verified remaining work or next inspection |
| --- | --- | --- |
| `test-suite-recovery-2026-08-27` | ready | P-004 needs a fresh canonical successful suite run; existing owner is driving its acceptance chain. |
| `green-gate-zero-wait-convergence-2026-09-08` | awaiting-acceptance | Eight implementation items terminal. Seven BARs need methods, checks, proof depth, current evidence, rubric vetting, independent grading, and an author verdict. |
| `frozen-candidate-freeze-actually-holds-2026-09-02` | awaiting-acceptance | Six items terminal. Current ship check reports stale audit citations for five items; re-read source before refreshing those audits, then evaluate subsequent gates. |
| `gate-ownership-condition-singleton-2026-08-03` | awaiting-acceptance | Twelve items terminal; current ship check requires the first code-truth audit. |
| `gate-ownership-followup-2026-08-08` | awaiting-acceptance | Seven items terminal; inspect the remaining audit/acceptance chain against current source. |
| `frozen-candidate-carry-and-launch-fail-closed-2026-09-07` | ready | Four of six items terminal. Finish the two residual items and the incomplete acceptance BAR contract. |
| `frozen-candidate-outlives-its-repair-2026-08-27` | draft | Four of seven items terminal. P-001, P-004, and P-007 remain nonterminal. Preserve the frozen-base and admitted-repair-head invariants. |
| `green-main-system-audit-and-red-streak-elimination-2026-09-04` | ready | P-002/P-003/P-004 terminal. P-005 promise mapping resumed here; subsystem audits, residual fixes, and the owner-facing audit remain. P-001 live-gate work belongs to the gate owner. |
| `progress-certified-release-trace-2026-09-05` | draft | Five implementation items terminal; inspect activation, audit, acceptance, and shipment records before changing lifecycle. |
| `release-gate-triage-hardening-2026-07-10` | draft | P-001 through P-005 terminal; P-006 remains todo. Determine whether its behavior is already implemented under later work, verify it, and settle the actual remaining contract. |
| `deploy-trigger-and-gate-unblock-2026-06-21` | ready | Legacy itemless plan. Read its full original requirements and map them to existing deploy tooling before preparing an evidence-backed close-out. |
| `declared-gate-liveness-watchdog-with-timeout-classification-2026-08-28` | draft | One proposed implementation item remains todo. Check existing producer-liveness and timeout machinery before implementing or consolidating it. |

## Plans already recorded as shipped

These statuses were read from the plan store. They do not substitute for the current-runtime promise mapping required by the audit plan's D-002.

| Plan | Status |
| --- | --- |
| `converge-frozen-candidate-by-fix-only-admission-2026-08-27` | shipped |
| `dependency-generation-critical-path-2026-08-27` | shipped |
| `frozen-candidate-compliance-enforcement-2026-08-30` | shipped |
| `frozen-candidate-stays-frozen-through-all-fixes-2026-09-03` | shipped |
| `gate-audit-hardening-2026-08-31` | shipped |
| `gate-latency-selection-and-retry-policy-2026-09-06` | shipped |
| `gate-resilience-vs-torn-git-sync-sweeps-retry-failing-files-2026-08-14` | shipped |
| `gate-speed-round-2-2026-08-31` | shipped |
| `gate-stop-chasing-the-tip-2026-08-19` | shipped |
| `gate-suite-speedup-2026-08-12` | shipped |
| `gate-verdict-liveness-and-repair-reliability-2026-08-31` | shipped |
| `green-checkpoint-red-streak-root-cause-2026-08-17` | shipped |
| `green-checkpoint-speedup-follow-up-2026-08-13` | shipped |
| `green-main-fast-2026-08-25` | shipped |
| `main-gate-qualification-transaction-acceleration-2026-08-25` | shipped |
| `main-gate-recovery-2026-08-12` | shipped |
| `main-green-status-visible-2026-09-03` | shipped |
| `quiet-integration-red-repair-2026-08-13` | shipped |
| `repair-frozen-gate-lineage-2026-08-20` | shipped |
| `restore-papercusp-main-green-2026-08-20` | shipped |
| `stable-candidate-related-gate-2026-08-23` | shipped |

## Ownership and continuation

`su-c7b7f864-27ce-4053-b90e-ea9eb638e21d` confirmed responsibility for `test-suite-recovery-2026-08-27`, the original eight-plan tracker (`WI-762558`), and `LIVE_GATE_OPS` (`WI-10000288`). This session continues the other plan work and independent evidence preparation. The scope division was confirmed over coordination following `coord-send-4924df404f0e23f5788c5d40453b0042b918f7c5442942f4f3977e9498c8ea55`; this session acknowledged it in `coord-send-543a8947e7073eee178ca7a2251d4853c8f42e65ffc07139092852409f3b2d9a`.

Before acting on another residual plan, read its governing decisions, current work-item ownership, source, and tests. Use its existing work-items and audit/acceptance records. Do not copy completed implementation into duplicate plans. Do not force a shipped label past unmet evidence. Preserve shipped records while documenting any measured runtime-effectiveness gaps separately.

For gate/control-plane behavior, the audit plan's D-002 requires actual controller activation and a correlated live cycle; staging evidence alone cannot establish that property. Obtain needed final live evidence from the gate owner. No second live-gate monitor or rerun is authorized by this portfolio registration.

## Acceptance-reader issue

The default MCP runtime reported the zero-wait rubric missing, while `plans:get` showed its active rubric-template row at revision 3. The same `rubrics:get` call, caller identity, workspace, and harness through `scripts/mcp-call.mjs --port 3170` resolved it successfully. Thus the missing-rubric/empty-BAR result from the older reader is not evidence to recreate the rubric. Continue acceptance work against the current-build endpoint and preserve the existing contract.

References: `WI-10001019`, source fix `EI-22439598382266201`, occurrence `EI-23068418278812557`. The real current-build blockers are incomplete checks/evidence, rubric vetting, independent grading, and author acceptance. No plan was newly marked shipped during this inventory pass.

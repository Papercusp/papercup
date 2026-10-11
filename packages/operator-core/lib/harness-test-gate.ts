/**
 * harness-test-gate — RETIRED (verification-system-improvements-2026-10-10 P-003,
 * SPEC-P-003-VAL-READERS).
 *
 * This module held `itemTestGate`, the legacy TEST-COMPLETION GATE for
 * `work_items:complete` (enforce-system-on-generic-work-2026-06-29 P-006). It refused a
 * terminal close while a plan item's inline VAL-* assertion with `requires_test` was not
 * proven `passed` by the harness's `harness_tests` rows.
 *
 * Inline VAL-* assertions are retired. Their successor is the requirement contract:
 * `plan_spec_clauses` plus immutable `spec_evidence_bindings`, judged at the same close by
 * `specTestAdequacyCompletionGate` (`agent-tools/work_items/spec-test-adequacy-gate.ts`).
 * `harness_tests` has had no writer since 2026-08-22, so the legacy gate could no longer
 * prove anything new. `work_items:complete` no longer calls it, and this module no longer
 * reads the retired assertion store. Plan-item provenance resolution, which the gate used,
 * lives on in `plan-item-provenance.ts` with its own tests.
 *
 * `harness-test-gate-provenance.test.ts` is now a retirement guard that fails if the gate
 * comes back. Both files are pending owner deletion with the rest of the VAL-* residue.
 */
export {};

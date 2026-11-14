---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/verification-summary.json"
updated_at: 1794258056618
_body: "content"
---

{
  "schemaVersion": "latency-parent-native-corrected-positive-verification-v1",
  "scope": "qualification-apparatus-only",
  "test": {
    "runGroupId": "90af0ab7-ab0f-4515-869b-3d4b44ab0eab",
    "testRunId": 23783145,
    "testPath": "packages/operator-core/test/committed-reader-source-preflight.test.ts",
    "testNamePattern": "cooperative parent native timing joins an actual live request identity",
    "passed": 1,
    "failed": 0,
    "explicitPatternExclusions": 258,
    "ledgerCommitSha": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
    "worktreeDirty": true,
    "scopeOfDirtyFlag": "whole shared tree; five named source files individually verified equal to ledger commit",
    "evidenceBinding": {
      "specId": "LATENCY-001-CONTRACT",
      "revision": 2,
      "requestedLayer": "integration",
      "phase": "layer-mismatch",
      "outcome": "unknown",
      "acceptance": "requires-review"
    }
  },
  "sourcePins": [
    {
      "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
      "byteLength": 171392,
      "sha256": "1a5a9d8c2e4df48aaa222e29ed5d284c6699861280703d25db72f1192a0b7c98",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    },
    {
      "path": "packages/operator-core/test/committed-reader-source-preflight.test.ts",
      "byteLength": 96272,
      "sha256": "8395f0bc6c0da7c49972447fa9bcf68a854d74840bd4f44bac3408b3533c9a04",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    },
    {
      "path": "scripts/lib/vitest-startup-trace.mjs",
      "byteLength": 66198,
      "sha256": "b7a007fcaacc5c90cdfbb00b3a1ef59964b6d77a7573edb4de61cba8fe20fd75",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    },
    {
      "path": "scripts/lib/vitest-startup-trace.d.mts",
      "byteLength": 5327,
      "sha256": "3c4655afc9afac414cf8f1497b06760f8880248a270751f686fae62052ce4f0c",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    },
    {
      "path": "scripts/lib/budgeted-task-scheduler.mjs",
      "byteLength": 242862,
      "sha256": "acb544f3c1efc3a89d3b794d9ad65f8828295c3e1a0d7c81800138ade53a77ed",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    }
  ],
  "sourceEligibility": "unknown",
  "runtimeQualification": "unknown",
  "taskBaselineAttempts": 0,
  "productBehaviorEditsThisContinuation": 0,
  "retainedPriorEvidence": [
    "test-run:23781779 four passing new negative controls; failed positive superseded narrowly",
    "test-run:23776772",
    "test-run:23776773",
    "run-group:4d1b5e97 prior full-two-file PASS saved; output was truncated and exact totals not inferred"
  ],
  "sourceAudit": {
    "artifact": "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/source-eligibility-dispositions.json",
    "constructors": 13,
    "dynamicImportExpressionSites": 9,
    "additionalMechanism": "new Function at frozen line85652; 8 wrapper call sites",
    "bootstrapClearingPath": "frozen line425854 parseReuseSourceSymbols Worker5; NODE_OPTIONS empty; finally terminates worker",
    "status": "all entries explicitly unresolved; no runtime absence inferred"
  },
  "review": {
    "conversation": "conv-request-dd0eba471b456874fe1edf77d7a1dc1366f15d9d6e4d622de8c20a7075064360",
    "state": "pending; no approval",
    "requestKey": "latency-m5-frozen-eligibility-20261109-r1"
  },
  "priorCheckpoint": "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/prior-checkpoint-230e4e54cdf2.md",
  "prerequisite": "Independently accept complete immutable baseline60 before any product behavior edit; candidate60 and all16 shipment remain outstanding."
}

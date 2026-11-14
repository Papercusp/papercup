---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-control-verification-20261109-r1/resolver/manifest.json"
updated_at: 1794251091900
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "725a04e5-9a27-4afc-b2c1-158beda1ba09",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794250321910,
    "taskDeadlineAtMs": 1794250441910,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794250411910
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5M73gx",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5M73gx/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5M73gx/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5M73gx/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5M73gx/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5M73gx/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5M73gx/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "725a04e5-9a27-4afc-b2c1-158beda1ba09",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 8,
    "failed": 0,
    "skipped": 243,
    "files": 1,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 1756,
    "byFile": {
      "packages/operator-core/test/committed-reader-source-preflight.test.ts": {
        "passed": 8,
        "failed": 0,
        "skipped": 243,
        "collectionFailed": false
      }
    }
  },
  "cleanup": {
    "complete": true,
    "databases": [],
    "errors": []
  },
  "executedRoot": "/home/marsh-office/papercupai-workspace/papercusp",
  "phaseTimings": {
    "preflightMs": 198.73,
    "provenanceMs": 69.09,
    "preparationMs": 0.01,
    "admissionGateMs": 0.01,
    "handoffMs": null,
    "admissionWaitMs": 91.7,
    "routerExecutionMs": 20827.12,
    "ledgerIdReadbackMs": null,
    "finalizationMs": null,
    "totalHandlerMs": null
  },
  "nativeCustody": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5M73gx/native-proof",
    "locator": {
      "manifest": {
        "ref": "09fcb1a65f7535b6855fbe35269028bbfe387c780b6f9253077582582df0ca7b.native-proof.json",
        "sha256": "09fcb1a65f7535b6855fbe35269028bbfe387c780b6f9253077582582df0ca7b",
        "byteLength": 15637
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "725a04e5-9a27-4afc-b2c1-158beda1ba09"
      },
      "expectedHash": "9447b2d801d4f4a7fb2408d57acb17e13b455235bb740eef5979746f984ae49c",
      "inventoryHash": "9d9c630e03085faece0b2318964fce16f029d58b3c0b7b5b8f6fc075b422f05e"
    },
    "byteCustody": "complete",
    "writerState": "settled",
    "routerCustody": [
      "complete"
    ],
    "nativeProof": "unqualified",
    "acceptance": "unmeasured",
    "producerRetirement": "not-performed"
  }
}


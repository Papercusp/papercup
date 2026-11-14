---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-control-verification-20261109-r1/sibling/manifest.json"
updated_at: 1794251091900
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "69084a96-3b93-4802-9d09-01b961e22853",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794250322644,
    "taskDeadlineAtMs": 1794250442644,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794250412644
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-stRaZi",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-stRaZi/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-stRaZi/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-stRaZi/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-stRaZi/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-stRaZi/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-stRaZi/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "69084a96-3b93-4802-9d09-01b961e22853",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 1,
    "failed": 0,
    "skipped": 71,
    "files": 1,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 374,
    "byFile": {
      "packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts": {
        "passed": 1,
        "failed": 0,
        "skipped": 71,
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
    "preflightMs": 9.28,
    "provenanceMs": 11.14,
    "preparationMs": 0.01,
    "admissionGateMs": 0.01,
    "handoffMs": null,
    "admissionWaitMs": 57.59,
    "routerExecutionMs": 18039.95,
    "ledgerIdReadbackMs": null,
    "finalizationMs": null,
    "totalHandlerMs": null
  },
  "nativeCustody": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-stRaZi/native-proof",
    "locator": {
      "manifest": {
        "ref": "9bab89bda3a49ccb842c5fb79d4297251ba9a5f278e1eae1dc34d5e4120e53c9.native-proof.json",
        "sha256": "9bab89bda3a49ccb842c5fb79d4297251ba9a5f278e1eae1dc34d5e4120e53c9",
        "byteLength": 15626
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "69084a96-3b93-4802-9d09-01b961e22853"
      },
      "expectedHash": "3b7c5f2ac8d97b5b62120ac35d0346f8f3f5cee5630b9d7420db5a853c4ad707",
      "inventoryHash": "5e84d79a006b808f6430fd2e97321bc0bfd1067c3c505e3e4950972a8eabbbc3"
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


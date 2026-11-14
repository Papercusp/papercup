---
rel_path: "portability/census/kopia-v7-manifest-c0630ae5be46cb14.json"
updated_at: 1794218431886
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "5ff20223-4198-48b5-ad09-2b92d53d46c6",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794217829414,
    "taskDeadlineAtMs": 1794218129414,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794218099414
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "5ff20223-4198-48b5-ad09-2b92d53d46c6",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 89,
    "failed": 0,
    "skipped": 0,
    "files": 2,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 7525,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 12,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 77,
        "failed": 0,
        "skipped": 0,
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
    "preflightMs": 31.34,
    "provenanceMs": 23.59,
    "preparationMs": 9.1,
    "admissionGateMs": 9.09,
    "handoffMs": null,
    "admissionWaitMs": 30.54,
    "routerExecutionMs": 18654.54,
    "ledgerIdReadbackMs": null,
    "finalizationMs": null,
    "totalHandlerMs": null
  },
  "nativeCustody": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/native-proof",
    "locator": {
      "manifest": {
        "ref": "50595ef073ebfd9a571dfd657d362923f3510f593169b7b9427b9989b253d7ff.native-proof.json",
        "sha256": "50595ef073ebfd9a571dfd657d362923f3510f593169b7b9427b9989b253d7ff",
        "byteLength": 15279
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "5ff20223-4198-48b5-ad09-2b92d53d46c6"
      },
      "expectedHash": "66610651f228711834862e475fb393fe5cb24b9b4648cc4f1e1ea5abf2f534f3",
      "inventoryHash": "dc2750fffd2c20e315bc50657c590233bd60478f7f1960e09b807c7c47de2337"
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


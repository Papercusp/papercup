---
rel_path: "portability/census/health-88-manifest-8ebf270f57f52e5a.json"
updated_at: 1794216103615
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "c62d2309-f28a-4cba-b903-492d3eed82f5",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794215832231,
    "taskDeadlineAtMs": 1794216132231,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794216102231
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-xBj76f",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-xBj76f/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-xBj76f/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-xBj76f/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-xBj76f/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-xBj76f/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-xBj76f/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "c62d2309-f28a-4cba-b903-492d3eed82f5",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 88,
    "failed": 0,
    "skipped": 0,
    "files": 2,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 10997,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 12,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 76,
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
  "phaseTimings": null,
  "nativeCustody": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-xBj76f/native-proof",
    "locator": {
      "manifest": {
        "ref": "2c716aacf485a0647759d5d1093726d8250ab62a5b8c9d06d064cd62c833e3ad.native-proof.json",
        "sha256": "2c716aacf485a0647759d5d1093726d8250ab62a5b8c9d06d064cd62c833e3ad",
        "byteLength": 16795
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "c62d2309-f28a-4cba-b903-492d3eed82f5"
      },
      "expectedHash": "b49be62c5d20836f4a12a2ac16d9f5f98adb0d493749171e0abbe7b86c7e7c46",
      "inventoryHash": "8c4fa71f54c75a6b3da15bbf9ccd374dad428c84c2391a8e0ec28bf4382756f2"
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


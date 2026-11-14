---
rel_path: "portability/census/v24-39-manifest.json-432fd42518e37b98"
updated_at: 1794230641786
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "50d7e24d-f60a-4967-925e-14310837217d",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794229397553,
    "taskDeadlineAtMs": 1794229577553,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794229547553
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-e3MACR",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-e3MACR/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-e3MACR/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-e3MACR/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-e3MACR/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-e3MACR/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-e3MACR/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "50d7e24d-f60a-4967-925e-14310837217d",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 16,
    "failed": 0,
    "skipped": 0,
    "files": 1,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 9594,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 16,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-e3MACR/native-proof",
    "locator": {
      "manifest": {
        "ref": "4d1af5b6c6f03878833f15da96b3a4f489ab3f798ebf359f38ead92753a672a4.native-proof.json",
        "sha256": "4d1af5b6c6f03878833f15da96b3a4f489ab3f798ebf359f38ead92753a672a4",
        "byteLength": 16542
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "50d7e24d-f60a-4967-925e-14310837217d"
      },
      "expectedHash": "a2dc597a5d566b1f13b0b6a95e735fd5b47ad39590c064542c28557b72e5b42e",
      "inventoryHash": "114290c90ae0c203cbd0d5e6fdb1149328a637ce9eeb99022692903eed1db88e"
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


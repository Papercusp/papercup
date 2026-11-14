---
rel_path: "portability/census/codex-alias-v16-test-11-manifest.json-146db069fd257089"
updated_at: 1794225814658
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "f3144197-3ba0-4b94-a46f-063a3e0a28cd",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794225273282,
    "taskDeadlineAtMs": 1794225573282,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794225543282
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "f3144197-3ba0-4b94-a46f-063a3e0a28cd",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 84,
    "failed": 0,
    "skipped": 0,
    "files": 1,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 3642,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 84,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG/native-proof",
    "locator": {
      "manifest": {
        "ref": "ebdc45b6e453bc082005558ffe92475eab7702ef7570087f4489d306351a75f8.native-proof.json",
        "sha256": "ebdc45b6e453bc082005558ffe92475eab7702ef7570087f4489d306351a75f8",
        "byteLength": 16560
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "f3144197-3ba0-4b94-a46f-063a3e0a28cd"
      },
      "expectedHash": "352a73c4c77ef7ab7cb36f7033712ec6d9e047e274244e2090ebdb7ca2613158",
      "inventoryHash": "8f786f87993751889290556de7bc17ad9d724a3a82fd3dc2517dd682088809ef"
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


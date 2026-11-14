---
rel_path: "portability/census/endpoint-desktop-v9-manifest-985215ba3f2d1c09.json"
updated_at: 1794221067893
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "7c881ded-5bbb-4086-a4d1-536a0ef04c06",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794220710558,
    "taskDeadlineAtMs": 1794221010558,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794220980558
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "7c881ded-5bbb-4086-a4d1-536a0ef04c06",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 93,
    "failed": 0,
    "skipped": 0,
    "files": 2,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 11530,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 13,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 80,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji/native-proof",
    "locator": {
      "manifest": {
        "ref": "de87d137394b5a9dc07a96aa0bb33538832fd995d2d6f5999788929909b10a7a.native-proof.json",
        "sha256": "de87d137394b5a9dc07a96aa0bb33538832fd995d2d6f5999788929909b10a7a",
        "byteLength": 16795
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "7c881ded-5bbb-4086-a4d1-536a0ef04c06"
      },
      "expectedHash": "95dfceec0c9ee66a0b8612a100a76ac99d749aa299851e3a8932593448c48a2a",
      "inventoryHash": "34b35b26b1f1521d6aa77101ac9b97014a209e720d5ebd4e43cf970feba52488"
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


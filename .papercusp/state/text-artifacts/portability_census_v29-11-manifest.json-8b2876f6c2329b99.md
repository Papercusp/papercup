---
rel_path: "portability/census/v29-11-manifest.json-8b2876f6c2329b99"
updated_at: 1794233098083
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "17b12ddb-470f-4464-b2d2-fd4e5c6cfa45",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794232615142,
    "taskDeadlineAtMs": 1794232795142,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794232765142
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-bncDj7",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-bncDj7/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-bncDj7/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-bncDj7/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-bncDj7/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-bncDj7/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-bncDj7/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "17b12ddb-470f-4464-b2d2-fd4e5c6cfa45",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 104,
    "failed": 0,
    "skipped": 0,
    "files": 2,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 12979,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 16,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 88,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-bncDj7/native-proof",
    "locator": {
      "manifest": {
        "ref": "c2f8e264f437c01d45e68d476374a4a0fcb8fa9716fb75c4d6ef981ac5f0c250.native-proof.json",
        "sha256": "c2f8e264f437c01d45e68d476374a4a0fcb8fa9716fb75c4d6ef981ac5f0c250",
        "byteLength": 16796
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "17b12ddb-470f-4464-b2d2-fd4e5c6cfa45"
      },
      "expectedHash": "ee6bfd00c32b72be12a79a00be588113f5b626e3c63b953e032cf255c0830750",
      "inventoryHash": "bcb30b28abeadbd2e095f6c7ede7806eac7d5eab255a7564b4ad0737c6d5ee71"
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


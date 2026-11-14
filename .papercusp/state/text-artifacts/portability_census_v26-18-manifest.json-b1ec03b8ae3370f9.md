---
rel_path: "portability/census/v26-18-manifest.json-b1ec03b8ae3370f9"
updated_at: 1794231846316
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "b46f8a5b-f778-403c-b727-583ca4bfbc53",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794231185567,
    "taskDeadlineAtMs": 1794231365567,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794231335567
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-A0EQ9A",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-A0EQ9A/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-A0EQ9A/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-A0EQ9A/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-A0EQ9A/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-A0EQ9A/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-A0EQ9A/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "b46f8a5b-f778-403c-b727-583ca4bfbc53",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 102,
    "failed": 0,
    "skipped": 0,
    "files": 2,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 8229,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 16,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 86,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-A0EQ9A/native-proof",
    "locator": {
      "manifest": {
        "ref": "b5bbab28bca99c781170d4f4a16258642116da67b39b245967b4c14c84830643.native-proof.json",
        "sha256": "b5bbab28bca99c781170d4f4a16258642116da67b39b245967b4c14c84830643",
        "byteLength": 16795
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "b46f8a5b-f778-403c-b727-583ca4bfbc53"
      },
      "expectedHash": "59d924a397ef646204b0da1bc9c443962b7e0070b302022458dc38919bf7b067",
      "inventoryHash": "bb095a3eedbca848394c559de995d6a2bba3a339a563b0e224a93a7722eb98ed"
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


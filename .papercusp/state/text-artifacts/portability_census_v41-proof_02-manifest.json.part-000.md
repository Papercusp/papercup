---
rel_path: "portability/census/v41-proof/02-manifest.json.part-000"
updated_at: 1794241878699
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "74948a01-9b5c-4c7c-a812-59804dd9191e",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794241178447,
    "taskDeadlineAtMs": 1794241418447,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794241388447
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "74948a01-9b5c-4c7c-a812-59804dd9191e",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 125,
    "failed": 0,
    "skipped": 0,
    "files": 3,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 14782,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 17,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 96,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/agent-tools/testing/run-artifacts.test.ts": {
        "passed": 12,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For/native-proof",
    "locator": {
      "manifest": {
        "ref": "e45f2c049a2b21f3780fe41ad3696476b4a20fe20750bbedebc0393f1ecdd5fb.native-proof.json",
        "sha256": "e45f2c049a2b21f3780fe41ad3696476b4a20fe20750bbedebc0393f1ecdd5fb",
        "byteLength": 17050
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "74948a01-9b5c-4c7c-a812-59804dd9191e"
      },
      "expectedHash": "1fa3c466695cb843bab99d56f81bcdfbd4e1ff201441f4a917251c7967d8748e",
      "inventoryHash": "e9f7ad3f55fc6cb83f186140d1711a8b70a049211a4bb3bffac1a12e1ac9130a"
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


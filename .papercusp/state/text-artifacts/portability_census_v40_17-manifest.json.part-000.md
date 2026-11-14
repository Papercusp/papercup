---
rel_path: "portability/census/v40/17-manifest.json.part-000"
updated_at: 1794240918867
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "7949d3eb-746e-4e31-9d5b-881f2182a70b",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794240410491,
    "taskDeadlineAtMs": 1794240650491,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794240620491
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-H5ejZA",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-H5ejZA/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-H5ejZA/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-H5ejZA/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-H5ejZA/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-H5ejZA/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-H5ejZA/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "7949d3eb-746e-4e31-9d5b-881f2182a70b",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 17,
    "failed": 0,
    "skipped": 0,
    "files": 1,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 12123,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 17,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-H5ejZA/native-proof",
    "locator": {
      "manifest": {
        "ref": "d37c1d16210f9902fe07ef3e33d242ebde00b435e72e24f3e8d6521940a5ab2e.native-proof.json",
        "sha256": "d37c1d16210f9902fe07ef3e33d242ebde00b435e72e24f3e8d6521940a5ab2e",
        "byteLength": 16547
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "7949d3eb-746e-4e31-9d5b-881f2182a70b"
      },
      "expectedHash": "6e9f67ee7d2f1e805ec604ebd3d6c8552c75c4995379da4c7400e776b7abf6a8",
      "inventoryHash": "37b1d09c270dbaf787cb7900f5b05c103fc458eddc87477ff31b5e9f12d4f829"
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


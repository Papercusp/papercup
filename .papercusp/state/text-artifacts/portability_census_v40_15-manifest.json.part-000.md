---
rel_path: "portability/census/v40/15-manifest.json.part-000"
updated_at: 1794240916945
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "3df2d1af-c626-4bf5-8c73-ac5756116623",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794239723957,
    "taskDeadlineAtMs": 1794239963957,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794239933957
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-XltcPm",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-XltcPm/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-XltcPm/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-XltcPm/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-XltcPm/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-XltcPm/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-XltcPm/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "3df2d1af-c626-4bf5-8c73-ac5756116623",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 110,
    "failed": 0,
    "skipped": 0,
    "files": 2,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 10443,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 16,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 94,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-XltcPm/native-proof",
    "locator": {
      "manifest": {
        "ref": "e924f2d9ceab6ab97187dd886901ef7bbb8b498bce26fb4ead4c588bab7d8689.native-proof.json",
        "sha256": "e924f2d9ceab6ab97187dd886901ef7bbb8b498bce26fb4ead4c588bab7d8689",
        "byteLength": 16796
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "3df2d1af-c626-4bf5-8c73-ac5756116623"
      },
      "expectedHash": "3155f6df5bdb46271b546fcf0b8140379b6bcc1363f217ac2e77dea3ffdb814a",
      "inventoryHash": "252da1437eb3602b6d0cb197663bbd2feab2731d3cd24e147045fc10f6d11afc"
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


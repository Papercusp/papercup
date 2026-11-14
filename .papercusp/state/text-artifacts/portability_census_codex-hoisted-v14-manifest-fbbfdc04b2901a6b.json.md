---
rel_path: "portability/census/codex-hoisted-v14-manifest-fbbfdc04b2901a6b.json"
updated_at: 1794224597655
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "14337dac-b179-4285-95ad-40b7f04f7b33",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794224277242,
    "taskDeadlineAtMs": 1794224577242,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794224547242
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "14337dac-b179-4285-95ad-40b7f04f7b33",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 82,
    "failed": 0,
    "skipped": 0,
    "files": 1,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 3697,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 82,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/native-proof",
    "locator": {
      "manifest": {
        "ref": "9010eedabc2ca93d544753c563c83b312d9c935157bbe920ebd669478f6e9b55.native-proof.json",
        "sha256": "9010eedabc2ca93d544753c563c83b312d9c935157bbe920ebd669478f6e9b55",
        "byteLength": 16560
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "14337dac-b179-4285-95ad-40b7f04f7b33"
      },
      "expectedHash": "2d0ad658e39ef4c8147032f2d886690a900d46d2f76040933ece188eecba54cb",
      "inventoryHash": "d21a67bd42ffb7b852b4804d6e9aa5800554b8ec4327f67a2661b0c16d324c68"
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


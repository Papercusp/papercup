---
rel_path: "portability/census/codex-helper-v13-manifest-a00b5e50779596f7.json"
updated_at: 1794223750049
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "53b7173e-af34-48cc-ad68-301ff0823eef",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794223226152,
    "taskDeadlineAtMs": 1794223526152,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794223496152
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "53b7173e-af34-48cc-ad68-301ff0823eef",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 81,
    "failed": 0,
    "skipped": 0,
    "files": 1,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 3580,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 81,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/native-proof",
    "locator": {
      "manifest": {
        "ref": "c3099b57fadbb9be4c98a54078d254791acf0c9f98ca0129b64d68fca67d1e5b.native-proof.json",
        "sha256": "c3099b57fadbb9be4c98a54078d254791acf0c9f98ca0129b64d68fca67d1e5b",
        "byteLength": 16560
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "53b7173e-af34-48cc-ad68-301ff0823eef"
      },
      "expectedHash": "8bcdeb8852078119e7db3ed91af6d6efe0ca7e44a2b048a5814ff8d91cd4a53e",
      "inventoryHash": "a2adeb2714adc749a6b601ec83fcf3ba009f7672d587436f6093247902b7087d"
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


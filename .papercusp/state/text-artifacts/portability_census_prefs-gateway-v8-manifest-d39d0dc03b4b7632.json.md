---
rel_path: "portability/census/prefs-gateway-v8-manifest-d39d0dc03b4b7632.json"
updated_at: 1794219656678
_body: "content"
---

{
  "schemaVersion": 1,
  "runId": "310bb53f-225f-41aa-8d42-55ce629cd1bf",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "deadline": {
    "startedAtMs": 1794219277940,
    "taskDeadlineAtMs": 1794219577940,
    "cleanupReserveMs": 30000,
    "childCutoffAtMs": 1794219547940
  },
  "state": "retained",
  "childState": "closed",
  "paths": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-PU1Ynf",
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-PU1Ynf/manifest.json",
    "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-PU1Ynf/phases.jsonl",
    "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-PU1Ynf/reports",
    "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-PU1Ynf/owned-databases",
    "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-PU1Ynf/executed-inputs",
    "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-PU1Ynf/native-proof"
  },
  "groupCleanups": [],
  "result": {
    "ok": true,
    "runId": "310bb53f-225f-41aa-8d42-55ce629cd1bf",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 91,
    "failed": 0,
    "skipped": 0,
    "files": 2,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 11433,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 13,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 78,
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
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-PU1Ynf/native-proof",
    "locator": {
      "manifest": {
        "ref": "e6ad543ec4cbaedcd98a06db1dc475e0ee4dbde894987326aa9814116bc485ff.native-proof.json",
        "sha256": "e6ad543ec4cbaedcd98a06db1dc475e0ee4dbde894987326aa9814116bc485ff",
        "byteLength": 16795
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "310bb53f-225f-41aa-8d42-55ce629cd1bf"
      },
      "expectedHash": "dc03c0404603e03322525e7563d0c09e52860f18428c81a4ba68070d3634427a",
      "inventoryHash": "56a375073335c832c43e1a2eb93d7ef42a1f2be814d08269a7341aac3c0e0849"
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


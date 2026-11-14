---
rel_path: "portability/census/p053-reaper-test-proof-66a7efe42e295519.json"
updated_at: 1794204475062
_body: "content"
---

{
  "scope": "P053 canonical reaper message fallback source tests",
  "originRunId": "0dacf7d2-3b1a-4953-a670-3e324f191107",
  "detachedRunId": "b51586b7-a839-491f-aba0-37831913c7cb",
  "terminalExitCode": 0,
  "result": {
    "ok": true,
    "runId": "b51586b7-a839-491f-aba0-37831913c7cb",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 90,
    "failed": 0,
    "skipped": 0,
    "files": 3,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 10653,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-writer-index.integration.test.ts": {
        "passed": 4,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-cli.test.ts": {
        "passed": 12,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      },
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 74,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      }
    },
    "artifacts": {
      "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-JVfABJ",
      "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-JVfABJ/manifest.json",
      "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-JVfABJ/phases.jsonl",
      "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-JVfABJ/reports",
      "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-JVfABJ/owned-databases",
      "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-JVfABJ/executed-inputs",
      "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-JVfABJ/native-proof"
    },
    "cleanup": {
      "complete": true,
      "databases": [],
      "errors": [],
      "scopes": [
        {
          "path": "private-pg-qotPqa",
          "complete": true,
          "databases": [
            {
              "name": "census-writer-index_756aa6a03aa7",
              "outcome": "dropped"
            }
          ],
          "errors": []
        }
      ]
    }
  },
  "hashes": {
    "scripts/state-census-roots.mts": "c1e42360d2403af64259351efc7d6be8abf5687f99de3c8c2051cd015a2b2cf5",
    "packages/operator-core/lib/backup/state-census-cli.test.ts": "32915940befb6873399388243b81d493a8f871eb56ef5b247d0d01aad42b1e95",
    "packages/operator-core/lib/backup/state-census-writer-index.integration.test.ts": "5634b8a4ef5f50fb808340a4b358f3e37bab997867d9f1035707d875df0577fc",
    "packages/operator-core/lib/backup/state-census-producers.ts": "9a825439ed1062b75cc378934d928b63e7ccd43c498571cff094edc3232fdd01",
    "packages/operator-core/lib/backup/state-census-producers.test.ts": "e68db3b3f85be394e15dd2c2ea6e8a87a63fdd5a3cc6692409dbcd53c336dd76"
  },
  "wholeInstallVerified": false
}

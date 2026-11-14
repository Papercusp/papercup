---
rel_path: "verification/EI-28088029954818867/recovery-20261109-r3/manifest.json"
updated_at: 1794200816696
_body: "content"
---

{
  "kind": "isolated-current-build-recovery-verification",
  "command": "node scripts/with-test-pg.mjs --isolated-runtime -- npm run test:file -- packages/operator-core/lib/sync/pot-git/own-head-publish.integration.test.ts",
  "exitCode": 0,
  "tests": {
    "passed": 22,
    "failed": 0,
    "skipped": 0,
    "testSeconds": 10.67,
    "durationSeconds": 57.46,
    "router": {
      "requested": 1,
      "executed": 1,
      "matched": 1,
      "status": "passed"
    },
    "provenance": "unknown",
    "childSubstitutions": 7
  },
  "sources": [
    {
      "path": "packages/operator-core/lib/sync/pot-git/own-head-publish.ts",
      "sha256": "73153bd8ae879668618ac842ca617094b4f0f5630742e86d67604a81218f286b",
      "headExact": true
    },
    {
      "path": "packages/operator-core/lib/sync/pot-git/own-head-publish.integration.test.ts",
      "sha256": "b92f43d71569ff24a4ba7bb85119a60f6bcbbcbee3d8672fba9f9a2769858d25",
      "headExact": true
    }
  ],
  "log": {
    "path": "/tmp/latency-ei280880-isolated-20261109-r3.log",
    "bytes": 904155,
    "sha256": "9e6d2a21650c5dbdf19a215420de9c56cb7add0ed4b393520e0711ea05b39f78",
    "canonical": "verification/EI-28088029954818867/recovery-20261109-r3/verification.log.gz.b64",
    "encoding": "gzip+base64"
  },
  "cleanup": {
    "workspace": "test-runtime-027a351f-e0e",
    "pgPort": 42089,
    "runtimeRemoved": true,
    "pgDataRemoved": true,
    "runtimeStillExists": false,
    "pgDataStillExists": false
  },
  "limitations": [
    "original corruption writer unknown",
    "no live store mutation",
    "live bg-host has not been shown to contain source change",
    "test-child substitution paths still unqualified; no observer verification implied"
  ]
}

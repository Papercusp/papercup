---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/attention-factory-preparation-20261109-r1/manifest.json"
updated_at: 1794230095483
_body: "content"
---

{
  "schemaVersion": "latency-attention-factory-preparation-v1",
  "phase": "preparation-only",
  "actualTaskAttempts": 0,
  "workItem": "WI-6554700010046192",
  "tests": "9 PASS; earlier direct replay explicitly excluded by name pattern; requested/executed/matched1/1/1; native exit0",
  "typecheck": "2 requested files clean, exit0; imported graph246errors/146files, not whole-project pass",
  "sourcePins": [
    {
      "path": "sources/packages/operator-core/lib/external-bench/run-launcher.ts",
      "bytes": 110472,
      "sha256": "a328ade465998d0b3eb7217c0d76e94eaaafcec48e76c6457749a401ab482a55",
      "store": "delta"
    },
    {
      "path": "sources/packages/operator-core/lib/external-bench/latency-attention-replay.integration.test.ts",
      "bytes": 19263,
      "sha256": "81c06649f4ce36d657e430805dd06decf8480e389cc2c75bf3b1a2b3cbaa88bc",
      "store": "delta"
    }
  ],
  "sourceCapture": "Both named source SHAs match Vite pre-transform. Node config/main-process closure UNKNOWN.",
  "rootCause": "Callback return alone established no retained observations. Factory now reads and verifies both immutable A/B snapshots before provider/gateway allocation.",
  "guard": "Real privatePG factory preflight, missing callback, thrown callback, no results, A-only, B-only, revoked lease, actual cold/warm replay ordering and idempotent cleanup. Gateway start injected; no native/provider inference.",
  "archive": {
    "sha256": "42a365e1b329d252efddf8a9a984bb6d9aa0a57f238c710d42ee25b868ebb2cb",
    "bytes": 6081817,
    "parts": 46,
    "files": 14287,
    "newObjects": 2339,
    "predecessorReferencedFiles": 9636,
    "indexSha256": "d39032fcecdf9617e74e775949407611cbe7592df10624ad2660d207b34fbb01"
  },
  "predecessor": {
    "canonicalPrefix": "verification/WI-6554700010046192/LATENCY-M1/attention-route-preparation-20261109-r1/",
    "archiveSha256": "02394ecb8ea72980f97e0ad541f71e1daf42d0264c4d28f5943b274bf8d7a387",
    "parts": 740,
    "indexSha256": "b17eaca93a10fb5f1fb2957d0b8da906ea4675689ecc50ce5a7dedac05c89e5e"
  },
  "originalRootsUntouched": true,
  "limitations": [
    "No TASKbaseline, native/provider qualification, fulloriginalruntime, componentacceptance orshipment.",
    "All60baseline+independent acceptance required before targetproduct edits.",
    "Full16/chronology/principal/static-source/realPGnotification findings unchanged."
  ]
}


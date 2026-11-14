---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/manifest.json"
updated_at: 1794255622680
_body: "content"
---

{
  "schemaVersion": "parent-native-preparation-v1",
  "scope": "qualification apparatus only; no product behavior edits",
  "baselineTaskAttempts": 0,
  "fullRuntimeQualification": "unknown",
  "currentNativeControls": "prior run23781779:4pass/1fail/254pattern exclusions; corrected configuration+NODE_OPTIONS guard is not yet retested",
  "priorSettledControls": {
    "focusedTracer": "23776772:21PASS",
    "comparison": "23776773:3PASS",
    "fullTwoFileRegression": {
      "runId": "4d1b5e97-94b4-4247-9051-a29e47e6d388",
      "status": "pass",
      "exitCode": 0,
      "returnedOutputTruncated": true
    }
  },
  "sourceCensusScope": "entire 84005399-byte retained bundle AST;13constructor sites,9nonliteral imports,0parse diagnostics; external modules and native interfaces remain unqualified",
  "unsupportedPath": "Frozen bundle40383d21 line425854 reuse-parser Worker5 explicitly clears NODE_OPTIONS; fail closed if reachable/used, no constructor argument override or product edit",
  "parentClock": "request observed before live kernel identity read, native child exit K, original task endpoints; observerDeductionNs=0",
  "loadedProvenanceScope": "V8 observer engine source, actual parent-read mapped Node executable, snapshot environment keys and separate native-entry NODE_OPTIONS hash; complete config/runtime closure remains unknown",
  "sourceHead": "450b2c822757cbb553de6af12b7d624b8dbc1ac2",
  "sourcePins": [
    {
      "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
      "sha256": "1a5a9d8c2e4df48aaa222e29ed5d284c6699861280703d25db72f1192a0b7c98",
      "HEADexact": false
    },
    {
      "path": "packages/operator-core/test/committed-reader-source-preflight.test.ts",
      "sha256": "8395f0bc6c0da7c49972447fa9bcf68a854d74840bd4f44bac3408b3533c9a04",
      "HEADexact": false
    },
    {
      "path": "scripts/lib/vitest-startup-trace.mjs",
      "sha256": "b7a007fcaacc5c90cdfbb00b3a1ef59964b6d77a7573edb4de61cba8fe20fd75",
      "HEADexact": true
    },
    {
      "path": "scripts/lib/vitest-startup-trace.d.mts",
      "sha256": "3c4655afc9afac414cf8f1497b06760f8880248a270751f686fae62052ce4f0c",
      "HEADexact": false
    }
  ],
  "artifacts": [
    {
      "sourcePath": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/test/private-http-workspace-preflight.ts",
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/private-http-workspace-preflight.ts",
      "byteLength": 171392,
      "sha256": "1a5a9d8c2e4df48aaa222e29ed5d284c6699861280703d25db72f1192a0b7c98"
    },
    {
      "sourcePath": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/test/committed-reader-source-preflight.test.ts",
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/committed-reader-source-preflight.test.ts",
      "byteLength": 96272,
      "sha256": "8395f0bc6c0da7c49972447fa9bcf68a854d74840bd4f44bac3408b3533c9a04"
    },
    {
      "sourcePath": "/tmp/latency-cont60-frozen-worker-census.json",
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-cont60-frozen-worker-census.json",
      "byteLength": 8518,
      "sha256": "aa9eb2d042d7f734e5a1229427ec7a1ac955d37d9c62f5dcd7bfbf2c8b4f4e6a"
    },
    {
      "sourcePath": "/tmp/latency-parent-clock-types-r1.log",
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-parent-clock-types-r1.log",
      "byteLength": 3871,
      "sha256": "6f390a537ab85b5e5ddb18c50e7343643d486611fb0cfe2646a69eb8b4ac1f03"
    },
    {
      "sourcePath": "/tmp/latency-parent-clock-types-r2.log",
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-parent-clock-types-r2.log",
      "byteLength": 3871,
      "sha256": "cedde05e00d029e7e9ceac8c9286a47e767d8240a0605fc818005c7335140e14"
    },
    {
      "sourcePath": "/tmp/latency-cont60-rawtimer-guard.log",
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-cont60-rawtimer-guard.log",
      "byteLength": 471,
      "sha256": "ae7ae882e878b02762c331c92827db4ba5a9ffeab6615837e1d453ac7fecf95d"
    },
    {
      "sourcePath": "/tmp/latency-cont60-sync-fire.log",
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-cont60-sync-fire.log",
      "byteLength": 2391,
      "sha256": "6cbbb25667390cc4d6771f5bc56e8197f01826e16f5d272e84a67694b13572d3"
    }
  ],
  "requiredNext": "Exact-source corrected positive control before any original host qualification. Full eligibility audit and independent immutable baseline60 acceptance before product edits. Candidate60/full16 shipment still owed."
}


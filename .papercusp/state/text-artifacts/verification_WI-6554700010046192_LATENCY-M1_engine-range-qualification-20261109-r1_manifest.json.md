---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/engine-range-qualification-20261109-r1/manifest.json"
updated_at: 1794232918139
_body: "content"
---

{
  "phase": "preparation-only",
  "actualTaskAttempts": 0,
  "workItem": "WI-6554700010046192",
  "originalHost": {
    "engineRanges": 88781,
    "coverageRangesComplete": true,
    "enginePopulation": "unknown",
    "completeRuntimeClosure": "unknown",
    "snapshotBytes": 8577007,
    "snapshotSha256": "f20ab9c7d0ac699772063f8fbcaffe04cf148d152f8267d49041a8e8cdc75207",
    "cleanup": "host/privatePG/runtime removed; native57569 exit0"
  },
  "tests": {
    "native": "8PASS/52explicitfiltered; native r2 exit0",
    "library": "3PASS/75explicitfiltered; r2 exit0",
    "hostReader": "NOTEXECUTED: dirty source guard before collection; new test still awaits commit",
    "typecheck": "2named clean; host-reader test absent from project program; partial exit0"
  },
  "reuse": "Existing native OUT events, bounded content-addressed attachment publication, authenticated reader; generic module limits unchanged. Original roots untouched.",
  "sourcePins": [
    {
      "path": "sources/libs/test-config/src/executed-config-load-capture.test.ts",
      "bytes": 68264,
      "sha256": "4324ab1da44efb9ff1a08f79381a07a3173f1556d81cf9ec0049cab743d2d2f1"
    },
    {
      "path": "sources/libs/test-config/src/executed-config-load-capture.ts",
      "bytes": 34275,
      "sha256": "a5772f5b640f894eb97be548cc30d27380101bfd925672b992aefdf4e60ac191"
    },
    {
      "path": "sources/packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts",
      "bytes": 90056,
      "sha256": "382bf61d294ff07a115264c2e385b9760f84326ed4e71d636a8f00a84a470fdc"
    },
    {
      "path": "sources/packages/operator-core/test/committed-reader-source-preflight.test.ts",
      "bytes": 80303,
      "sha256": "28f0d2274e4d43743b128c17a2eeb1cf1a9dbf44a6b342bef8f82a206fb00472"
    },
    {
      "path": "sources/packages/operator-core/test/private-http-workspace-preflight.ts",
      "bytes": 149778,
      "sha256": "a758b04cbaf80060d4662730ab78d0ad612def5290dbb6308ba2c9cf24203ef1"
    },
    {
      "path": "sources/scripts/lib/budgeted-task-scheduler.d.mts",
      "bytes": 38882,
      "sha256": "3b5bf7a9fa02c08c9f91450734090d43449db10bbfd35922396973bed977480b"
    },
    {
      "path": "sources/scripts/lib/budgeted-task-scheduler.mjs",
      "bytes": 229824,
      "sha256": "8f888c216902177647aa908bfd842fdde46e84b302a55a9a46899a07d1cf5d90"
    },
    {
      "path": "sources/scripts/lib/vitest-startup-trace.mjs",
      "bytes": 48056,
      "sha256": "e2f90d7ec532cd195de2759a5d2d170d4923ec804e0c4945db1348c5bdfe91f5"
    }
  ],
  "archive": {
    "sha256": "242f8291fc8094884c90cd0a255e0731ab77db6164db154936f5a8035c857b62",
    "bytes": 3549822,
    "parts": 36,
    "files": 579,
    "indexSha256": "07415270dda6806d40c9e244515ab89cd3f30411f3f9ff797e7c10ff2982256e"
  },
  "predecessorReferences": [
    {
      "path": "original-host/host-source.json.native-processes/40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc.source",
      "sha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc",
      "bytes": 84005399,
      "canonicalPredecessor": "verification/WI-6554700010046192/LATENCY-M1/runtime-observation-20261109-r49/manifest.json",
      "predecessorArchiveSha256": "1d26095d79bfa8a3d833b7718fb9d58d1aa55a6065ead9f6a66be154f661cd0a"
    }
  ],
  "nativeCustody": [
    "/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-94oEz7",
    "/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-f57ZJw"
  ],
  "openIncident": "WI-6554700010046958; historical git-sync mismatch; current manifest+lock both16.4.1; no repair by this session",
  "next": "Resolve committed host-reader execution, then remaining original host/module/config/native/provider closure and baseline60+independent acceptance before product edits; full16shipment remains"
}


---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/loader-census-verification-20261109-r1/manifest.json"
updated_at: 1794235928273
_body: "content"
---

{
  "phase": "apparatus verification and incomplete original-host census",
  "actualTaskAttempts": 0,
  "nativeTests": {
    "passed": 7,
    "filtered": 58,
    "exitCode": 0,
    "nativeHandle": 30665
  },
  "readerTest": {
    "passed": 1,
    "filtered": 240,
    "exitCode": 0,
    "nativeHandle": 39202
  },
  "previousHostCompatibility": {
    "passed": 1,
    "filtered": 239,
    "exitCode": 0,
    "nativeHandle": 36740
  },
  "defaultRegressionRerunReason": "two existing default-limit/late-pin controls affected by changed emitter/env helper; not reruns for receipts",
  "firstAttempt": "77935exit3 refused before collection, no assertion outcome",
  "typecheck": "34959exit0;2namedmembers/importers clean;hosttest absent explicitpartial",
  "sourcesAndFullPriorCheckpoint": "verification/WI-6554700010046192/LATENCY-M1/loader-census-preparation-20261109-r1/manifest.json",
  "originalCommand": "verification/WI-6554700010046192/LATENCY-M1/loader-census-preparation-20261109-r1/original-r51-command.sh",
  "archive": {
    "bytes": 11299729,
    "sha256": "1306e54e78385bcb03bbe170f59b6e3659e02ea2631272eb33b81005cae005cf",
    "parts": 113,
    "files": 9206
  },
  "nativeCustody": [
    {
      "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-Vk3vL1",
      "manifest": {
        "ref": "88f523ec683b121ac809dd84a705266de1749d3f0e2e30767a3e494f5be14c0f.native-proof.json",
        "sha256": "88f523ec683b121ac809dd84a705266de1749d3f0e2e30767a3e494f5be14c0f",
        "byteLength": 1296068
      }
    },
    {
      "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-YR7Ney",
      "manifest": {
        "ref": "d53746e08d5f106e1ea568303e45a2a5c274648040aa1f723df59bb20b536955.native-proof.json",
        "sha256": "d53746e08d5f106e1ea568303e45a2a5c274648040aa1f723df59bb20b536955",
        "byteLength": 1519287
      }
    },
    {
      "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-WTWSnY",
      "manifest": {
        "ref": "7af4517ea598edc8463d60dc1daf8ccf28ff23de7d23443f4dfe6f0d03dcf6c3.native-proof.json",
        "sha256": "7af4517ea598edc8463d60dc1daf8ccf28ff23de7d23443f4dfe6f0d03dcf6c3",
        "byteLength": 1509478
      }
    }
  ],
  "predecessorReferences": [
    {
      "path": "host-source.json.native-processes/40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc.source",
      "sha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc",
      "bytes": 84005399,
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/runtime-observation-20261109-r49/manifest.json"
    }
  ],
  "originalR51": {
    "nativeHandle": 98248,
    "exitCode": 1,
    "cause": "explicit event-budget exhaustion; command assertion rejected remaining gap",
    "loaderStarts": 985,
    "loaderReturns": 985,
    "resolverStarts": 3112,
    "resolverReturns": 3112,
    "gaps": [
      {
        "threadId": 0,
        "event": "trace-limit",
        "scope": "module"
      }
    ],
    "tracePopulation": {
      "artifactLimit": 16384,
      "artifactsVisited": 9186,
      "eventByteLimit": 67108864,
      "eventBytesRead": 5124578,
      "observationByteLimit": 67108864,
      "observationBytesRead": 8577836,
      "complete": true,
      "truncatedBy": null
    },
    "engineRanges": [
      88792
    ],
    "engineObserved": true,
    "completeRanges": true,
    "observerUnchanged": true,
    "hostSignalCode": "SIGKILL",
    "cleanup": "complete: runtimeRemoved+pgDataRemovedtrue"
  },
  "completeRuntimeClosure": "UNKNOWN",
  "baselineAccepted": false,
  "next": "Design bounded lossless census representation on existing authenticated trace surface; do not silently bump limits or retry r51 unchanged. Then original runtime/config/native/provider and baseline60 independent acceptance before product edits."
}


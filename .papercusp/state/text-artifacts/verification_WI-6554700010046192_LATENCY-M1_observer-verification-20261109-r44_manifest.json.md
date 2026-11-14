---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/manifest.json"
updated_at: 1794203168786
_body: "content"
---

{
  "at": "2026-11-09T05:45:51.359262+00:00",
  "status": "focused6PASS; full58PASS1FAIL0skip; peer collectionPASS",
  "focusedExitCode": 0,
  "fullExitCode": 1,
  "actualTaskAttempts": 0,
  "sourceInputReceipt": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/commit-check.json",
  "headAtPackaging": "06689d3fc3909ff0f9d8594f3af74708699f41b9",
  "command": "node /tmp/latency-baseline-git-source-20261108-r1/scripts/npm-install-safe.mjs --repo-root /tmp/latency-baseline-git-source-20261108-r1 --exec-under-lock -- node /tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/vitest.mjs run --config /tmp/latency-native-observer-20261109-r1/config.mts lib/__tests__/vitest-startup-trace.test.ts",
  "focusedPattern": "retains a scoped engine snapshot|retains an independently enrolled late source",
  "files": [
    {
      "path": "scripts/lib/vitest-startup-trace.mjs",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/vitest-startup-trace.mjs",
      "bytes": 44261,
      "sha256": "29334d6c5448f81983870c4055e8f32dcfde06468b24f1ccee49c9265301ae12"
    },
    {
      "path": "scripts/lib/partial-task-resume.mjs",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/partial-task-resume.mjs",
      "bytes": 86193,
      "sha256": "465477eb66af54949b0faa9ea70960ccc2c66701c5502f527c3e59399890a480"
    },
    {
      "path": "packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/vitest-startup-trace.test.ts",
      "bytes": 84665,
      "sha256": "12ca20bd36696099ba7dd588670dc1f11128735a6fb25bbf638677e501065b55"
    },
    {
      "path": "/tmp/latency-native-observer-20261109-r1/config.mts",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/config.mts",
      "bytes": 539,
      "sha256": "d55872c097966873762897f13e1b39dbb07ab01b21df9be1f440c9858fb4ffd7"
    },
    {
      "path": "/tmp/latency-observer-focused-20261109-r44.log",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/focused.log",
      "bytes": 1184,
      "sha256": "4a2b1105e8cf935cb7c0b4cee20c77880ab0bb9b20e98e8c70540d66df0d49b2"
    },
    {
      "path": "/tmp/latency-observer-full-20261109-r44.log",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/full.log",
      "bytes": 7888,
      "sha256": "f0f1fe68d84ded1b7830b760d962de654ce7365c1f0d18d4596fc9dbccdad04b"
    },
    {
      "path": "/tmp/latency-r44-commit-check.json",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/commit-check.json",
      "bytes": 667,
      "sha256": "e911e54d87fee9725703f0bbe19dc1102e8656dd2379d63cbf164eba956bcfca"
    }
  ],
  "failureTraceArchive": {
    "root": "/tmp/pcv/native-reporter-channel-Zeoqfd",
    "files": 2571,
    "bytes": 2090265,
    "sha256": "c63dc4f28de67e5aa5e43efee20a2a97ba77dd59c0ae1a565b81abe80c7def31",
    "parts": 4
  },
  "failure": "native-channel-trace-gap at actual npm reporter custody reader; trace-limit from shared general512 budget consumed by module loading",
  "followup": "EI-28287838746306032",
  "scope": "Preparation only; no baseline acceptance, speedup or shipment claim"
}

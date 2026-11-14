---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/manifest.json"
updated_at: 1794204438159
_body: "content"
---

{
  "at": "2026-11-09T06:07:01.023823+00:00",
  "scope": "Observer preparation only; no baseline/runtime/shipment acceptance",
  "focused": {
    "exitCode": 0,
    "passed": 9,
    "filtered": 50
  },
  "complete": {
    "exitCode": 0,
    "files": 2,
    "passed": 160,
    "failed": 0,
    "skipped": 0,
    "tracerCases": 59,
    "consumerCases": 101,
    "durationSeconds": 78.4
  },
  "actualTaskAttempts": 0,
  "files": [
    {
      "path": "scripts/lib/vitest-startup-trace.mjs",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/vitest-startup-trace.mjs",
      "bytes": 44654,
      "sha256": "0f5842ef5bd73d9340c8ef4dd0bcacd0a93bef78747df53a384d6215434d6ba6"
    },
    {
      "path": "scripts/lib/partial-task-resume.mjs",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/partial-task-resume.mjs",
      "bytes": 86524,
      "sha256": "ab639ed784691c04650aea6387de8387fd7795cfcba31cde0db9b0d508288d2d"
    },
    {
      "path": "packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/vitest-startup-trace.test.ts",
      "bytes": 86670,
      "sha256": "db91647d365e59426c49928eff9c072a5c9a22b8e6fca27d99b5c9e55e51a5f2"
    },
    {
      "path": "packages/operator-core/lib/__tests__/partial-task-resume.test.ts",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/partial-task-resume.test.ts",
      "bytes": 74644,
      "sha256": "c82fbec6664f690686647c38e9ed25da5196f31331733535a0515e5d1e6af7c9"
    },
    {
      "path": "/tmp/latency-native-observer-20261109-r1/config.mts",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/config.mts",
      "bytes": 539,
      "sha256": "d55872c097966873762897f13e1b39dbb07ab01b21df9be1f440c9858fb4ffd7"
    },
    {
      "path": "/tmp/latency-r47-commit-check.json",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/pretest-commit-check.json",
      "bytes": 808,
      "sha256": "520724b4601b6ddc9faa9a275ae6567bbfb0a185af37ccdd04a3b97228554c25"
    },
    {
      "path": "/tmp/latency-r47-posttest-source-pins.json",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/posttest-source-pins.json",
      "bytes": 1019,
      "sha256": "d6908c078e5cccf310ee48c19d67d39ee21f33feb8bb4f908e4143b7831d6bf1"
    },
    {
      "path": "/tmp/latency-observer-focused-20261109-r47.log",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/focused.log",
      "bytes": 1377,
      "sha256": "a0d2bdb9b09f665f4c299a31fcd58edc80fb11e48910b6a7b48a416a9de6bd85"
    },
    {
      "path": "/tmp/latency-observer-full-consumer-20261109-r47.log",
      "canonical": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/full-consumer.log",
      "bytes": 3490,
      "sha256": "d7d1fec9716ac2f267dcbe2f9c0e6304526ef5bed153032ef5ce3b93c6a672b4"
    }
  ],
  "priorFailureEvidence": "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/manifest.json",
  "findings": [
    "EI-28287838746306032",
    "EI-28285929210510385"
  ],
  "maintainedConfig": "/tmp/latency-native-observer-20261109-r1/config.mts",
  "execution": "saved maintained npm-install-safe --exec-under-lock route, independent frozen dependency tree; see complete logs"
}

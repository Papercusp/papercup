---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/self-kill-preparation-20261109-r1/manifest.json"
updated_at: 1794238919694
_body: "content"
---

{
  "phase": "preparation-only; native assertions pending source commit",
  "baselineTaskAttempts": 0,
  "archive": {
    "bytes": 194865,
    "sha256": "643409a5d37345f2a132b606000138a3fb1fecb5a5aa7e32a131924eb1c1c203",
    "parts": 3
  },
  "files": [
    {
      "path": "scripts/lib/vitest-startup-trace.mjs",
      "bytes": 53680,
      "sha256": "3af87ae0d05a8cf87f006e5b6f545bc153ad17934af022be4193eb1cd57e59df"
    },
    {
      "path": "scripts/lib/vitest-startup-trace.d.mts",
      "bytes": 3373,
      "sha256": "1bc2655b69f2c7db3c10f08205dfa100ab20e967e21bff7b3711835ef9424ad1"
    },
    {
      "path": "scripts/lib/budgeted-task-scheduler.mjs",
      "bytes": 234681,
      "sha256": "c0585cf05364bfe48c18ecf5bd0d4d5b01338266c94dc2c4dbc8874095e5a493"
    },
    {
      "path": "scripts/lib/budgeted-task-scheduler.d.mts",
      "bytes": 39012,
      "sha256": "51b52684028bcce75024ff8c07e4c72c8a89f06f0c29b93512b0c5748b009186"
    },
    {
      "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
      "bytes": 151277,
      "sha256": "9494695cd0a641b7b05796c3636e8281516bf4b376b283f67e268bcf33b65624"
    },
    {
      "path": "packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts",
      "bytes": 101962,
      "sha256": "65cf3b3383b7ef3c0202d5f4c0d7353a06c2dbf2d66ce4f000461fff2ebe1b0b"
    },
    {
      "path": "packages/operator-core/test/committed-reader-source-preflight.test.ts",
      "bytes": 82172,
      "sha256": "cd14cd395a41f3b2cd5c3a0dad8e83704976c2cdf6a3141de48e68efece89685"
    },
    {
      "path": "libs/test-config/src/process-termination-observer.mjs",
      "bytes": 3643,
      "sha256": "62b5bf48463a70a7c8113f8f5ce936195c52411fba0f238fd9f3cb07c356728d"
    },
    {
      "path": "libs/test-config/src/process-termination-observer.d.mts",
      "bytes": 1325,
      "sha256": "20ec349c89e9360febfca3d7f3376e6ceeed27f91ff0230abcf948215c1eaf62"
    },
    {
      "path": "libs/test-config/src/executed-config-load-capture.test.ts",
      "bytes": 72654,
      "sha256": "145c31a28b14cf3ed7a51fc945754a92a1da6ebc2933853d978222a9b3b50051"
    },
    {
      "path": "evidence/latency-self-kill-declarations-r1.log",
      "bytes": 299,
      "sha256": "045d3443f5d9cd682e9604aa78542fa22f0fbbf74ae9e3f4bc080b191c0439f2"
    },
    {
      "path": "evidence/latency-self-kill-tsc-r1.log",
      "bytes": 1283,
      "sha256": "219db8c6b660c6fb2dd95e7458018e9bfc10157bb5fd11b8db8616d19df220fb"
    },
    {
      "path": "evidence/latency-self-kill-tsc-r2.log",
      "bytes": 24300,
      "sha256": "c42f01c98270f17a6b0b1e9d65f0539dcdf975bc549eb9e4871fa8cd14c9ff25"
    },
    {
      "path": "evidence/latency-self-kill-sync-r1.json",
      "bytes": 1784,
      "sha256": "2147a213d469d0e411590ff814ed52a0957e941f15aa26238d91d693caec0e30"
    },
    {
      "path": "evidence/latency-fire51-sync-schema.json",
      "bytes": 2058,
      "sha256": "74e25633472aa45269f5d890735c4110bcfc2f224c92b35097d8104b981ed6ec"
    },
    {
      "path": "evidence/latency-fire51-p001.json",
      "bytes": 26560,
      "sha256": "19b25c04a8c9238f24f7a8f434fa48fe79dff3fb792df078e7b63b32a14b0aee"
    }
  ],
  "typecheck": "first barepaths call refused; corrected run completed: scripts out-of-scope2, operator-core partial clean; no whole-project pass",
  "scope": "original roots untouched; opt-in self-kill observer/native parent receipt binding; tests not yet executed"
}

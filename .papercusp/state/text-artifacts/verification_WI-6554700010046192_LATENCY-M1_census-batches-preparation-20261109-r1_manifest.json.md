---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/census-batches-preparation-20261109-r1/manifest.json"
updated_at: 1794237775103
_body: "content"
---

{
  "phase": "apparatus implementation/pre-verification",
  "taskBaseline": 0,
  "runtimeQualification": "unknown",
  "testVerdict": "not-measured; r1 native-source guard refusal before assertions",
  "typecheck": "exit0 scoped2named+119importers; hostreader test excluded",
  "plan": {
    "version": 78,
    "hash": "63ec7dcc3c7e59c7e8ce98d7a09c9a5cbd2c56601b85e6af96d6ef1f01315cbe",
    "activation": 55,
    "start": 83
  },
  "files": [
    {
      "path": "sources/scripts/lib/vitest-startup-trace.mjs",
      "bytes": 52564,
      "sha256": "58753baa450bbae7fde1de3754909d62fbbc83a3c4a8fc7e059e15e8dedc501f"
    },
    {
      "path": "sources/scripts/lib/vitest-startup-trace.d.mts",
      "bytes": 3373,
      "sha256": "1bc2655b69f2c7db3c10f08205dfa100ab20e967e21bff7b3711835ef9424ad1"
    },
    {
      "path": "sources/scripts/lib/budgeted-task-scheduler.mjs",
      "bytes": 232844,
      "sha256": "7d93b2526081742bfb0e8b1738a035b884888b252b13aa3e5308aa41962fe799"
    },
    {
      "path": "sources/packages/operator-core/test/private-http-workspace-preflight.ts",
      "bytes": 150963,
      "sha256": "c7c6a90e8b12eca5ffdd1a28431aac3ae19564b1dc8df8efb5b5400bd94a9e25"
    },
    {
      "path": "sources/packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts",
      "bytes": 98352,
      "sha256": "3e3554b4a68ca64f4c655b5c4e2a087d46bdfddc63bb66c928b4fc2b585a2695"
    },
    {
      "path": "sources/packages/operator-core/test/committed-reader-source-preflight.test.ts",
      "bytes": 82172,
      "sha256": "cd14cd395a41f3b2cd5c3a0dad8e83704976c2cdf6a3141de48e68efece89685"
    },
    {
      "path": "evidence/latency-census-batch-tests-r1.log",
      "bytes": 10979,
      "sha256": "8d9f04cc977fca2b68a047c6516f9ad9d08b457dd0fbc19a9a35c1f5282d9300"
    },
    {
      "path": "evidence/latency-census-batch-tsc.log",
      "bytes": 4017,
      "sha256": "18c3963bc8b47e6cc62a3c603693d0bcc4d487dc616ab6ccb82358d7517cc39c"
    },
    {
      "path": "evidence/latency-census-batch-declarations-r3.log",
      "bytes": 245,
      "sha256": "c495fc10d75830e132ced6cd28790ec70d0b07e9f9a09219930b7ea279fbf4b2"
    },
    {
      "path": "evidence/latency-resume-start-r2.json",
      "bytes": 1474,
      "sha256": "9c640e4e75fe6cb5008da4ce2d1b841d39a520aea1c7413136145b0311752f24"
    },
    {
      "path": "evidence/latency-resume-activation-audit-r3.json",
      "bytes": 304,
      "sha256": "5c0645ea4e47115822b37484787b94159ee8d3b6be7f2183cfb14553708b615f"
    },
    {
      "path": "evidence/latency-resume-discovery-audit-r3.json",
      "bytes": 3620,
      "sha256": "d93e93b29fe56734be46d2ea758a68c68dc41b6577485939f44c9de7f6de94f1"
    },
    {
      "path": "evidence/latency-census-batch-checkpoint-inflight.json",
      "bytes": 700,
      "sha256": "a5c33750baf659a210f92ab6d09c566f1a83ed50c3aad3afd085b4266310c38e"
    },
    {
      "path": "evidence/latency-census-batch-checkpoint-update.json",
      "bytes": 2696,
      "sha256": "33e52239c88bd085643c15e9d404d62a6244935e58ed7edd8e6851df293ce85a"
    },
    {
      "path": "evidence/latency-census-batch-sync-bg-r2.json",
      "bytes": 1784,
      "sha256": "978bcb432b30ee9f7bfd725e227d0cff37286921115be3de519e3fb07fa39499"
    },
    {
      "path": "evidence/latency-original-r51-command-full.json",
      "bytes": 8938,
      "sha256": "319b8ef65d643bb18368eb573a2a925092be1b7619d0b8c7a0fa6c79a50d1236"
    }
  ],
  "archive": {
    "bytes": 163551,
    "sha256": "c0b9722382600a9d06ea968721498f755e2224793275ca166ff2d27fd15be997",
    "parts": 2
  }
}

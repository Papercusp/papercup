---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/attention-route-preparation-20261109-r1/manifest.json"
updated_at: 1794228929667
_body: "content"
---

{
  "schemaVersion": "latency-attention-route-preparation-v1",
  "phase": "preparation-only",
  "actualTaskAttempts": 0,
  "workItem": "WI-6554700010046192",
  "tests": {
    "final": "r4:48unit+1realPG PASS/0skip;4requested/executed/matched",
    "prior": "r1 observer8PASS; r2 47PASS/1stale-expectationFAIL corrected; r3 48unit+1realPGPASS",
    "typecheck": "10requestedfiles clean/0requestederrors; importedgraph71othererrors;compilerExit1"
  },
  "scope": "Existing host allocation/lease/private read/result paging plus trusted T06 replay and cache observer; target product behavior untouched",
  "limitations": [
    "No native task/provider inference; complete60baseline acceptance remains owed before target product edits.",
    "Current runtime Vite source capture armed; Node config/main-source closure UNKNOWN; no full original-runtime qualification or shipment claim.",
    "Default factory requires trusted prepareFixture callback for T06; exact original host allocation/factory/native/provider qualification still owed.",
    "Original admin/UI-principal and static DARK_FLAGS differences retained; no oracle/fixture amendments."
  ],
  "archive": {
    "sha256": "02394ecb8ea72980f97e0ad541f71e1daf42d0264c4d28f5943b274bf8d7a387",
    "bytes": 99780460,
    "parts": 740,
    "encoding": "tar.gz base64 parts concatenated in numerical order",
    "indexSha256": "b17eaca93a10fb5f1fb2957d0b8da906ea4675689ecc50ce5a7dedac05c89e5e",
    "files": 27233,
    "uniqueObjects": 19847
  },
  "sourcePins": [
    {
      "path": "sources/packages/operator-core/lib/external-bench/latency-attention-observer.ts",
      "bytes": 8365,
      "sha256": "cb4ef4d50f93058e389ee0b5a2f93385462bc245904d2698e0147b69083bd000"
    },
    {
      "path": "sources/packages/operator-core/lib/external-bench/latency-attention-observer.test.ts",
      "bytes": 9305,
      "sha256": "07a7a9e0b5169f17a41447d4e2cfe55438b9cd9d80ff48b02b7c952f6e9794ed"
    },
    {
      "path": "sources/packages/operator-core/lib/external-bench/latency-attention-replay.ts",
      "bytes": 13363,
      "sha256": "03b2e946c90491d52273ad031652d331da628266d71a96083f73295b7368628e"
    },
    {
      "path": "sources/packages/operator-core/lib/external-bench/latency-attention-replay.integration.test.ts",
      "bytes": 8645,
      "sha256": "ec6d1225aafcbdd126843f28e6f1036c725b633f2414370b5525da59ca6dc99b"
    },
    {
      "path": "sources/packages/operator-core/lib/external-bench/private-fixture-reads.ts",
      "bytes": 39706,
      "sha256": "9ea2fd738c5c930c70e005a86c4bd92881adf64e461543f79945a091b3174480"
    },
    {
      "path": "sources/packages/operator-core/lib/external-bench/private-fixture-reads.test.ts",
      "bytes": 18828,
      "sha256": "e97e01aae4180fd0a46f23c6bd3170d902fba5fa4a4f3e9e7d4b64724150dd89"
    },
    {
      "path": "sources/packages/operator-core/lib/external-bench/run-launcher.ts",
      "bytes": 110048,
      "sha256": "1f131cd7f5576a98eac8cb25288964263ebe4c77f1c80bacc317ebead59b1da8"
    },
    {
      "path": "sources/packages/operator-core/lib/external-bench/current-su.ts",
      "bytes": 259343,
      "sha256": "71de24ad9bbb1e3c9f0aa87480ca0d89988ace203c6ec84b47749d3a61a44677"
    },
    {
      "path": "sources/packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts",
      "bytes": 10910,
      "sha256": "bd2887d7a05d5d5df6a16fd09c244c90309fb7440d08e96125f5b7432d12a303"
    },
    {
      "path": "sources/packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts",
      "bytes": 12697,
      "sha256": "e13589ed83a2b566152c43524144c3df34eda79ac825108a25a6ecd189702c10"
    }
  ],
  "predecessor": {
    "checkpointHash": "677febafc186",
    "chars": 31561,
    "path": "evidence/latency-current-p001-checkpoint.md"
  },
  "originalRoots": [
    "/tmp/latency-baseline-git-source-20261108-r1",
    "/tmp/latency-baseline-runtime-20261108-r4"
  ],
  "rootsUntouched": true
}

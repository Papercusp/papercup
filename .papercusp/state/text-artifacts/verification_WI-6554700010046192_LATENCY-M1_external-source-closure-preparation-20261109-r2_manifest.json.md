---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/external-source-closure-preparation-20261109-r2/manifest.json"
updated_at: 1794262143737
_body: "content"
---

{
  "schemaVersion": "external-source-closure-preparation-v2",
  "workItem": "WI-6554700010046192",
  "scope": "PREPARATION ONLY; no native host or test run; no runtime closure or acceptance",
  "sourceBundle": {
    "path": "/tmp/latency-baseline-runtime-20261108-r4/hono-host.mjs",
    "byteLength": 84005399,
    "utf16Length": 84005399,
    "sha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc"
  },
  "priorPreparation": "constructor-ledger-preparation-20261109-r1",
  "nativeDependencyAudit": {
    "file": "native-dependency-static-audit.json",
    "sha256": "46b8ea17f4629f57477a2e33e34828b5d9856b85029dd130fa2c958add104aa7",
    "byteLength": 126738,
    "seedImports": [
      "onnxruntime-node",
      "sharp",
      "better-sqlite3"
    ],
    "modules": 106,
    "unresolved": 18,
    "pending": 0,
    "parseErrors": 0,
    "proofLimits": [
      "Only literal import/require resolution is traversed; dynamic expressions and binding helpers remain unaudited.",
      "Missing optional platform packages are unresolved static branches, not evidence of actual attempted loading.",
      "Native bytes are hashed, not behaviorally audited.",
      "No mem0ai/transformers full transitive closure or attempt load census."
    ]
  },
  "activationMap": {
    "file": "frozen-source-activation-map.json",
    "offsetUnit": "UTF-16 code units, matching V8 precise coverage offsets",
    "definitions": [
      {
        "name": "parseReuseSourceSymbols",
        "startOffset": 19314628,
        "endOffset": 19321091,
        "bodyStartOffset": 19314718,
        "bodyEndOffset": 19321091,
        "sha256": "88e1bc9df62a1c96aba3c265c4e477effb8b226eb9297245c37b967c57c7f70c"
      },
      {
        "name": "dynamicImport",
        "startOffset": 4478258,
        "endOffset": 4478522,
        "bodyStartOffset": 4478298,
        "bodyEndOffset": 4478522,
        "sha256": "9efb2250ce5e3d35b45f4093d8d184d1e7d193441baea8fca3216ba0a3d9d1ff"
      }
    ],
    "textOccurrences": 16,
    "proofLimits": [
      "Text occurrence enumeration is not alias/binding completeness.",
      "No actual engine non-entry or construction-ledger join."
    ]
  },
  "nativePins": [
    {
      "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
      "byteLength": 384040,
      "sha256": "a7191fbfe8045d4d5d312e5ecd8f5dd6970e804dd340c98be8a0af8daf7908cc",
      "audit": "unknown; hashed opaque native bytes only"
    },
    {
      "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "byteLength": 2157792,
      "sha256": "6356f301add71d28fb74a378cd023126c73e60018e8e498e0e8eeca97f89d708",
      "audit": "unknown; hashed opaque native bytes only"
    },
    {
      "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node",
      "byteLength": 415112,
      "sha256": "cf896cc1b7f3ae9c3e8eb3d7b2b198b8de2824ff7d0681d684bab5a825def335",
      "audit": "unknown; hashed opaque native bytes only"
    }
  ],
  "baselineAttempts": 0,
  "productBehaviorEdits": 0,
  "requiredNext": "Exact archive/working/HEAD observer+reader+test before maintained cooperative controls, then engine/load/native source qualification; immutable60 baseline and independent acceptance before product edits."
}

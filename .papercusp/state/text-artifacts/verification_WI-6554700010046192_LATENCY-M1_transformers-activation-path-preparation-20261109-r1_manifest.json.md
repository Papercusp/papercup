---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/manifest.json"
updated_at: 1794266449058
_body: "content"
---

{
  "schemaVersion": "transformers-activation-preparation-manifest-v1",
  "workItem": "WI-6554700010046192",
  "ruling": 1222463,
  "scope": "PREPARATION ONLY; no runtime/task acceptance",
  "artifacts": [
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/activation-audit.json.gz.b64",
      "chars": 129460,
      "byteLength": 129460,
      "sha256": "bb7ed6fd9c0c8792386b8408f5d7c22f8dd726fc1dcfc8f110c20f58f4b06401"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/activation-summary.json",
      "chars": 6609,
      "byteLength": 6609,
      "sha256": "1d19f2f99b728dea24be4cb5ff452e3021b14573bc4fa5efdc3c13f8bb0ae3be"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/source-analysis-command.txt",
      "chars": 7303,
      "byteLength": 7303,
      "sha256": "800917787174ed89f7741a7a84b75d70952b5604b5007991e627e20135afef8c"
    }
  ],
  "decodedAudit": {
    "jsonBytes": 435689,
    "jsonSha256": "274ae1fdbfcdac844c4da8cf892f71571bb0e5b4c3d3b5284132b48355a8504a",
    "gzipBytes": 97093,
    "base64Chars": 129460
  },
  "fullDataReadback": [
    {
      "path": "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/activation-audit.json.gz.b64",
      "chars": 129460,
      "windows": 7,
      "exact": true
    },
    {
      "path": "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/activation-summary.json",
      "chars": 6609,
      "windows": 1,
      "exact": true
    },
    {
      "path": "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/source-analysis-command.txt",
      "chars": 7303,
      "windows": 1,
      "exact": true
    }
  ],
  "allExact": true,
  "baselineAttempts": 0,
  "productBehaviorEdits": 0
}

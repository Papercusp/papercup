---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/manifest.json"
updated_at: 1794265123202
_body: "content"
---

{
  "schemaVersion": "external-entry-activation-preparation-manifest-v1",
  "workItem": "WI-6554700010046192",
  "ruling": 1222463,
  "scope": "PREPARATION ONLY; no runtime/task acceptance",
  "artifacts": [
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/entry-audit.json.gz.b64",
      "byteLength": 10132,
      "chars": 10132,
      "sha256": "c3a7f866ef097bf8e5c0368d574c44d1f74feb16bc5bfbcd526b3ba314667275"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/transformers-constructor-bindings.json",
      "byteLength": 8523,
      "chars": 8523,
      "sha256": "bc55b426b775879e849213080c8e3e550990498021e79d10d1a1456cc68891bd"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/preparation-summary.json",
      "byteLength": 6375,
      "chars": 6375,
      "sha256": "f29d2ae95710ffd0d33a7fc4c5328fae12e0c4aa18050963c1f521c4fa364774"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/source-analysis-command.txt",
      "byteLength": 5410,
      "chars": 5410,
      "sha256": "fea62c054eca031c18f3b8fb734105d7b8e8bc0800e59ae75b87838ed71608ba"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/prior-checkpoint-b2a0600e0d45.md",
      "byteLength": 31629,
      "chars": 31536,
      "sha256": "b2a0600e0d45c98b43013f85153ff6d30f53a835511c7b97bf8ddbe1be051872"
    }
  ],
  "decodedAudit": {
    "byteLength": 45232,
    "sha256": "2441729825f3073dba0e9ed6abd30accbf8513ce5f809c5cc8c5d94d41abed2a",
    "gzipBytes": 7597,
    "encoding": "gzip compressed UTF-8 JSON, canonical base64 ASCII"
  },
  "custody": {
    "readback": "Five artifacts fully read back in 29 contiguous 2400-character windows; every window string exactly matched original submitted content; exact full character length checked for every window.",
    "allExact": true
  },
  "baselineAttempts": 0,
  "productBehaviorEdits": 0
}

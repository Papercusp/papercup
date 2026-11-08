---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/original-input-seed-20261108-r1/receipt.json"
updated_at: 1794114622798
_body: "content"
---

{
  "phase": "original-input-private-PG-preparation-only",
  "actualProviderTaskAttempts": 0,
  "sourceCommit": "7986ba393eeb0471d8bca059b01332908e1f5805",
  "workspace": "latency-acceptance-fixture",
  "database": "org_450a6b970621",
  "scopeTransformation": "Only workspace_id is relocated to the predeclared private fixture workspace. Original IDs, payloads, historical selectors and references are retained.",
  "sources": [
    {
      "path": "/tmp/latency-frozen-selected-historical-records.json",
      "sha256": "e683c6a9b0ef7cb311e405e155f6b11ded162219ac1a347f3c5258071b96ca08"
    },
    {
      "path": "/tmp/latency-frozen-named-card-rubric-records.json",
      "sha256": "986593f1ff3554afb84c34d6eb519943b72bff49208ccc0356264b5918be9882"
    }
  ],
  "tables": [],
  "cleanup": "dropped"
}


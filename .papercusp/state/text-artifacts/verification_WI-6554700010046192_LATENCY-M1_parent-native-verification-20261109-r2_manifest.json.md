---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/manifest.json"
updated_at: 1794258138025
_body: "content"
---

{
  "schemaVersion": "latency-parent-native-verification-manifest-v1",
  "scope": "preparation-only",
  "sourceEligibility": "unknown",
  "baselineAcceptance": "unknown",
  "testRunId": 23783145,
  "runGroupId": "90af0ab7-ab0f-4515-869b-3d4b44ab0eab",
  "artifacts": [
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/source-eligibility-dispositions.json",
      "byteLength": 18724,
      "sha256": "57fbce93e53ce5673b0f35179e8f2bee096e1dc2ba5308cfbab2955aefb029ec"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/verification-summary.json",
      "byteLength": 3890,
      "sha256": "2273109806e972d915ea8074136369b157fbf317e60fcfa1b226d7ced90f6c23"
    }
  ],
  "otherVerifiedFullReadbacks": [
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/corrected-positive-test-ledger.json",
      "bytes": 942
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/prior-checkpoint-230e4e54cdf2.md",
      "bytes": 30717
    }
  ],
  "custody": "All four named content artifacts were fully read back and equal to submitted strings. The first two also have independently computed UTF8 byte length and SHA256. Retained original r1 source artifact custody remains authoritative.",
  "reviewConversation": "conv-request-dd0eba471b456874fe1edf77d7a1dc1366f15d9d6e4d622de8c20a7075064360",
  "pending": "Proof obligation for unsupported frozen branch and external native/import closure. No host qualification or task measurement occurred."
}

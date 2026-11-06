---
rel_path: "runtime-migration/p006-distinct-2929ed-exit-guards-proof-0dcd3-20261106.json"
updated_at: 1793961150404
_body: "content"
---

{
  "schemaVersion": "bun-source-only-post-read-guard-proof-v1",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "workItem": "WI-6554700010022072",
  "decision": "node-to-bun-staged-migration-2026-10-22#D-020",
  "proposal": "runtime-migration/p006-distinct-2929ed-source-only-exit-guards-proposal-0dcd3-20261106.json",
  "proposalChars": 9771,
  "proposalSha256": "02ef76e2a1518d7dff59d3e6a7bd3f9c1e855c9cd96a74fc82e7b04e763b29e8",
  "commandChars": 2315,
  "commandSha256": "1ddfd413cd5c592eece8c90b82a7d3689351a810b10aab06a54c02030d9ad876",
  "canonicalReadback": {
    "exact": true,
    "slices": 4,
    "updatedAt": 1793961028038
  },
  "test": {
    "command": "npm run test:file -- apps/operator/lib/release/bun-source-only-post-read-guards.test.ts",
    "taskId": "0mw4u27z5tqy2g117t7",
    "bashId": "ccb24dec-d9d",
    "nativeExit": 0,
    "passed": 10,
    "skipped": 0,
    "requestedFiles": 1,
    "executedFiles": 1,
    "matchedFiles": 1,
    "localProvenance": "TEST_FILE_RESULT status=passed head=adb8a6890c uncommittedPaths=1/1 provenance=unknown; post-run head=fbb0597a35. This is LOCAL working-tree proof; no committed, gate or shipped acceptance inferred.",
    "testPath": "apps/operator/lib/release/bun-source-only-post-read-guards.test.ts",
    "testSha256": "a2605528e1478e0b52245405be3ca186886f29def60afc0fefd1a1e37fe6b2aa",
    "fixture": "apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json",
    "fixtureSha256": "02ef76e2a1518d7dff59d3e6a7bd3f9c1e855c9cd96a74fc82e7b04e763b29e8",
    "log": ".papercusp/scratch/bash-ccb24dec-d9d.log",
    "logSha256": "56423ba92b5bf967597f17e73d411d31c748d137f4381cbe01d6382796573dbf",
    "terminalAt": "2026-11-06T10:31:38.184Z",
    "controls": "Complete-command bash -n0; clean fixed HEAD/status/submodule success; HEAD emits correct text then exits42/timesout124; empty status exits42/timesout124; direct recursive submodule exits42/timesout124; wrong successful HEAD and dirty successful status exit1. Every negative control withholds POST_READ_READY. Only post-read block runs; candidate paths point to test-owned scratch and timeout budgets shorten to0.15s.",
    "substitution": "Committed-source loader substituted scripts/npm-install-safe.mjs only. TEST_FILE_RESULT childSubstituted=0; Vitest workers load working-tree bytes."
  },
  "rootCause": "test around command substitution observed only output, permitting failed empty status/correct-looking HEAD reads to pass. Standalone assignments with explicit exit of their status enforce the first-nonzero rule.",
  "limits": "No source materialization/native candidate/generation selection/lease/dependency/build/install/VM/runtime/gate action occurred. D011-D019 and original tuple remain terminal. D020 exact-byte independent disposition, fresh semantic audit/start and current positive endpoint/confinement/cleanup admission remain required. Node remains selected; Bun UNSHIPPED."
}


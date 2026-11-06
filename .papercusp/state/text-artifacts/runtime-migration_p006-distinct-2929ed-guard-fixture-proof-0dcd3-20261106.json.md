---
rel_path: "runtime-migration/p006-distinct-2929ed-guard-fixture-proof-0dcd3-20261106.json"
updated_at: 1793961566795
_body: "content"
---

{
  "schemaVersion": "bun-source-only-post-read-guard-proof-v1",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "workItem": "WI-6554700010022072",
  "decision": "node-to-bun-staged-migration-2026-10-22#D-020",
  "proposal": "runtime-migration/p006-distinct-2929ed-source-only-guard-fixture-proposal-0dcd3-20261106.json",
  "proposalChars": 9896,
  "proposalSha256": "5e3f389d6fab08b6d77cd229b2d29e36ef635a50f1a712268be840ad3a8e6619",
  "commandChars": 2315,
  "commandSha256": "1ddfd413cd5c592eece8c90b82a7d3689351a810b10aab06a54c02030d9ad876",
  "canonicalReadback": {
    "exact": true,
    "slices": 4,
    "updatedAt": 1793961463333
  },
  "test": {
    "command": "npm run test:file -- apps/operator/lib/release/bun-source-only-post-read-guards.test.ts",
    "taskId": "0mw4u8xug7e4p8ratdk",
    "bashId": "99039b19-c3f",
    "nativeExit": 0,
    "passed": 10,
    "skipped": 0,
    "requestedFiles": 1,
    "executedFiles": 1,
    "matchedFiles": 1,
    "localProvenance": "TEST_FILE_RESULT head=e772627efa uncommittedPaths=1/1 provenance=stamped childSubstituted=0. LOCAL working-tree proof only.",
    "testPath": "apps/operator/lib/release/bun-source-only-post-read-guards.test.ts",
    "testSha256": "5fbcbf44858197e8c59d7e9950fe50e0c48fd0dec5cb6192afb76ca146bec42a",
    "fixture": "apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json",
    "fixtureSha256": "6797af1380db5244fed73159baa195df5fc9cee4a09460ed9db65e1a54822983",
    "log": ".papercusp/scratch/bash-99039b19-c3f.log",
    "logSha256": "972112a816628ba538e82c758b7d92fedc91c1db761fe239ed1f4994d2566dfd",
    "terminalAt": "2026-11-06T10:36:14.657Z",
    "controls": "Exact post-read block bash -n0; clean success; correct-text HEAD nonzero42/real timeout124; empty status nonzero42/real timeout124; recursive submodule nonzero42/real timeout124; wrong HEAD/dirty status1; every negative control withholds READY. Actual timeout budgets shorten to0.15s and candidate paths substitute only test-owned scratch.",
    "substitution": "No child source substitution (childSubstituted=0). Full native command separately syntax-checked with /bin/bash -n, exit0; it was never executed."
  },
  "rootCause": "test around command substitution observed only output, permitting failed empty status/correct-looking HEAD reads to pass. Standalone assignments with explicit exit of their status enforce the first-nonzero rule.",
  "limits": "No source materialization/native candidate/generation selection/lease/dependency/build/install/VM/runtime/gate action occurred. D011-D019 and original tuple remain terminal. D020 exact-byte independent disposition, fresh semantic audit/start and current positive endpoint/confinement/cleanup admission remain required. Node remains selected; Bun UNSHIPPED.",
  "supersedes": "runtime-migration/p006-distinct-2929ed-exit-guards-proof-0dcd3-20261106.json",
  "fixtureScope": {
    "chars": 786,
    "postReadChars": 555,
    "postReadSha256": "57b15a7425b590820e4a4e25369ed09fc28f622a4f59426187a88af4ff83750f",
    "binding": "The fixture postReadCommand is byte-identical to the complete native command slice from candidate_head= through recursive submodule status, before the second sha256sum block. Full execution packet remains outside repository source."
  },
  "identityGuards": {
    "commands": [
      "npm run lint:no-box-identity",
      "npm run lint:no-identity-literals"
    ],
    "exit": 0,
    "observation": "Both superproject identity guards PASS after replacing full packet fixture with minimal post-read fixture; test suite also reran10PASS0skip.",
    "items": [
      "WI-6554700010045897",
      "WI-6554700010045898"
    ]
  }
}


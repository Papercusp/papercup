---
rel_path: "evidence/EI-28271697022752681/compiled-core-proposal-v2.json"
updated_at: 1794265893249
_body: "content"
---

{
  "status": "Not applied. Candidate F1-F4 resolution for the existing plan; requires contract edits and current whole-contract reassessment before implementation.",
  "issue": "EI-28271697022752681",
  "plan": "detached-testing-core-bundle-2026-11-09",
  "supersedes": "evidence/EI-28271697022752681/compiled-core-proposal-dacdcd1980eb0f91.json",
  "critiqueConversation": "conv-request-89293bc72d794693e66eb0419e0b805271895f93b1259c140df5eb803ddc9479",
  "discardFromV1": [
    "Do not use a shared literal or HEAD+dirty as the core source witness.",
    "Do not rely on staged override tests alone for automatic sibling selection.",
    "Do not count a stub-only expired-budget reply as actual-core/no-artifact proof.",
    "Do not omit the existing mac-vm-health runtime-sibling parity test."
  ],
  "F1": {
    "invariant": "A parent must bind the exact compiled worker output plus a producing-source witness; the worker must check actual bytes before import and the producing-source stamp before calling the core. No mutable-tree startup recomputation or opaque shared token.",
    "proposedMechanism": [
      "Keep one thin core worker entry exporting the existing runTestFilesCore and a producing-source-input digest. Use the existing shared compiler and externals/banner; no second runner or bundler.",
      "Analyze that entry with the existing esbuild recipe to obtain the complete actual compiler-input population. Capture stable content hashes for every resolved input, including workspace/submodule files and inlined dependencies, plus the lock, shared recipe/witness helper, and inputs that derive compile-time defines (including the retained-replay witness inputs). Bind the effective worker compiler profile.",
      "Prefer existing qualified immutable build-context/compiler-consumption machinery. The final pass must consume the same population; verify content pins before/after final compilation and after parent compilation. Reject moving/unqualified inputs instead of producing mixed generations.",
      "Embed the source-input digest in the final worker, then hash the final worker bytes. Compile the parent afterward with immutable {schemaVersion,sourceSha256,artifactSha256} for that worker. This avoids a self-referential artifact hash or a meaningless constant merely shared by both.",
      "The bootstrap compares the selected worker bytes with the parent's baked artifact digest before import, and the loaded worker's producing-source digest before core execution. Missing/invalid witness is an explicit refusal for bundled hosts.",
      "Raw source compatibility remains outside the precompiled-start guarantee. Explicit staged source calls need an independently supplied expected witness, not a value learned from the candidate at boot."
    ],
    "implementationCandidates": [
      "A lightweight scripts/lib/testing-core-witness.mjs library can capture/verify input snapshots and full-output hashes; it should reuse the existing stable-read/provenance semantics rather than weaken release/operator-artifact.ts.",
      "The shared prepare-core function must run before parent compilation in bundle-host.sh and bundle_host_primary. Shared bundle_host_workers must stage/reuse that same core without recompiling it into a different generation afterward.",
      "Keep the existing retained-replay source witness unchanged. It excludes testing/run.ts today and is not this proof.",
      "Review existing operator-artifact.ts and source-preview BG compiler receipts: they already bind actual compiler inputs/commit blobs, submodules, output bytes and qualified source. Decide the smallest appropriate reuse before coding; complete source fidelity is still a hard requirement."
    ],
    "explicitOpenChecks": [
      "The exact input-domain/consumption implementation and build ordering must be stated in the plan and reassessed; this candidate is not evidence that the implementation already exists.",
      "Preserve existing dependency-generation/runtime instrumentation guards; distinguish platform-core inputs from caller-selected corpus/router/config custody."
    ]
  },
  "F2": [
    "Test automatic sibling resolution from a bundled-host fixture with the produced artifact, selected URL, execution marker, child argv and inherited preload configuration.",
    "Strengthen compiled-start falsifier to include wrong JS selection or failure to start, not only use of a source loader.",
    "Strengthen missing-bundle falsifier to reject ANY child spawn or missing typed refusal; assert start count zero.",
    "Keep bundled+present, bundled+missing, source+explicit-stage and raw source compatibility separate. Preserve required tracing/instrumentation; do not erase NODE_OPTIONS indiscriminately."
  ],
  "F3": [
    "Use existing run-background.integration.test.ts and its private current-build HTTP fixture for the real valid background path, terminal reports, source custody, confirmed exit and private PG cleanup.",
    "Use run-detached-import.test.ts for the occupied-port control and actual compiled selection; preserve the no-rebinding-server property.",
    "Add an early exhausted-cutoff guard before import and a second guard before calling the core if necessary to prove no test child or artifact packet starts after expiration, while preserving numeric deadline/cutoff/reserve and emitting an explicit refusal.",
    "Keep all options/identity/report mappings unchanged. A matching-vs-mismatching stamp control must differ only in the stamp and report a distinct source-refusal phase/error."
  ],
  "F4": [
    "Add papercusp-desktop/test/mac-vm-health.test.js to R-3's runnable proof binding, including the named RUNTIME_SIBLINGS equality test.",
    "Register required new JS output in the shared worker registry and all existing launcher copies. Current VM copy also lacks warm-cochange-index.worker.mjs; synchronize with the complete registry and record the small same-scope correction.",
    "Check the existing host-worker-bundler compatibility shim if new shared helper dependencies are introduced."
  ],
  "existingRealFixtures": [
    "packages/operator-core/lib/agent-tools/testing/run-background.integration.test.ts",
    "packages/operator-core/test/private-http-workspace-preflight.ts",
    "packages/operator-core/test/testing-background-http-scenario.ts",
    "packages/operator-core/lib/agent-tools/testing/run-detached-import.test.ts"
  ],
  "prototype": {
    "directory": "/tmp/pcv/testing-core-probe.80d6n3",
    "initialResult": "result.json",
    "controlledPlainNodeResult": "result-plain-node.json",
    "compilerMetadata": "core.meta.json",
    "compilerLog": "build.log",
    "interpretation": "Unchanged current core successfully bundled with the shared compiler and loaded with NODE_OPTIONS/NODE_PATH removed; controlled import 5832.894152 ms, Node 25.9.0, expected core export present. This is feasibility only, not final fixture/source-witness verification or an SLA/speedup proof.",
    "artifactSha256": "f0858e530331e3443ef73aa0854a8ffae2a1f861ef1cf2e7a40248aebc9a4eab",
    "sourceSha256": "2bd0288ec5bdd165f9e5e496a6b1ee6a07caa1c937f0ae8346c6f0ebe32b64f6"
  }
}

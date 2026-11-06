---
rel_path: "runtime-migration/p006-d031-terminal-sidecar-architecture-d032-proposal-0dcd3-20261106.json"
updated_at: 1793988603824
_body: "content"
---

{
  "schemaVersion": "p006-d031-terminal-sidecar-architecture-d032-proposal-v1",
  "status": "PREPARED_NOT_APPLIED_NOT_EXECUTED_PENDING_DISTINCT_INDEPENDENT_REVIEW",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "item": "P-006",
  "workItem": "WI-6554700010022072",
  "intendedSuccessorDecision": "D-032",
  "currentCanonical": {
    "version": 79,
    "revision": 85,
    "contentHash": "ccfec6c1523544732ba2f837f613d263a7caa7e47d4a85861bb049262db364b4",
    "discoveryChars": 13345,
    "discoverySHA256": "b270d26938748c5c9987c3ab297d648a2e6e56dbec8134bf46223d53df656ebe"
  },
  "terminalD030": {
    "status": "TERMINAL_NO_CANDIDATE_START",
    "canonicalAdmissionPassed": true,
    "discoveryAudit": 24,
    "activationAudit": 25,
    "ordinaryStart": "ok true; specQuality satisfied and admission ready; native346ece",
    "executionReadiness": "ready true/no blockers/exactv77/f6fa7dda; native1cad09",
    "holdAttempt": "ONE300s all13-path acquire; native6be54c exit5",
    "refusal": "path papercusp-desktop/bin/build-desktop-sidecar.sh belongs to repository /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop, not parent coordination_domain. Acquire it separately with its repository domain and bin/build-desktop-sidecar.sh.",
    "ownLocksAfterRefusal": "nativef599ec active_locks=[],waiting=[],completed=[]",
    "candidateCommandExecuted": false,
    "scratchAllocated": false,
    "noRetry": true
  },
  "rootCause": "D031 stopped as required at a live peer hold on the nested desktop repository; all known parent grants were released. This is expected mutual exclusion, not a lock defect. The peer then completed/released its atomic sidecar edit. That file changed from86ad06fb to38d8bb2b, so a distinct architectural finding and independent decision are needed before any new canonical admission; D031 cannot be refreshed or retried.",
  "reuse": {
    "acquire": "Existing locks:acquire for each physical repository domain, no new API/table/service.",
    "release": "Existing locks:release {lock_ids:[...all granted ids]} supports multiple lock sets across repository identities.",
    "whyNotGranular": "One broad parent subtree lock would widen scope and would not establish the desktop repository's native-hook identity. No alias or namespace bypass."
  },
  "lockContractEvidence": {
    "acquire": {
      "path": "packages/operator-core/lib/agent-tools/locks/acquire.ts",
      "sha256": "43e2c0aefae92d07ec28497fc0be03fb02d9baad8afc97512a94b22a25af9397",
      "lines": "312-336",
      "fact": "All normalized paths are checked against nearest managed repository before acquire. One returned lock id has one coordination_domain; another domain is refused with the required domain/path.",
      "currentSHA256": "43e2c0aefae92d07ec28497fc0be03fb02d9baad8afc97512a94b22a25af9397"
    },
    "release": {
      "path": "packages/operator-core/lib/agent-tools/locks/release.ts",
      "sha256": "faa45712d9ddcb06b856143ce0d8c44fe56b7ab072482ff2451b88533d791eeb",
      "fact": "Existing release accepts lock_ids, with owner attribution and stored repository identities.",
      "currentSHA256": "faa45712d9ddcb06b856143ce0d8c44fe56b7ab072482ff2451b88533d791eeb"
    },
    "regression": {
      "path": "packages/operator-core/lib/agent-tools/locks/coordination-domain.file-domain.test.ts",
      "sha256": "ad0a10fcf4ba57d7d24edca1f539b54839b8f772a6a015356b3a09f317365a27",
      "status": "source pin only; not run in this preparation",
      "currentSHA256": "ad0a10fcf4ba57d7d24edca1f539b54839b8f772a6a015356b3a09f317365a27"
    }
  },
  "proposedLogicalHold": {
    "status": "PROPOSED_FOR_DISTINCT_D032_NOT_AUTHORIZED_NOT_ACQUIRED",
    "physicalSourceCount": 13,
    "grants": [
      {
        "order": 1,
        "coordination_domain": "/home/marsh-office/papercupai-workspace/papercusp",
        "paths": [
          "packages/operator-core/lib/vm-release-runtime-policy.ts",
          "scripts/lib/committed-source-loader.mjs",
          "scripts/lib/runtime-compatibility.mjs",
          "scripts/lib/targeted-task-reuse.mjs",
          "apps/operator/bin/release/dependency-generation.sh",
          "apps/operator/bin/release/setup-release-checkout.sh",
          "apps/operator/lib/release/bun-source-only-post-read-guards.test.ts",
          "apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json",
          "packages/operator-core/lib/application-runtime-acceptance.ts",
          "apps/operator/lib/release/fixtures/bun-dependency-input-only-guards.sh",
          "packages/operator-core/lib/agent-tools/capability/bash.ts",
          "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts"
        ],
        "ttl_sec": 300
      },
      {
        "order": 2,
        "coordination_domain": "/home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop",
        "paths": [
          "bin/build-desktop-sidecar.sh"
        ],
        "ttl_sec": 300
      }
    ],
    "acquisitionPolicy": "Only after fresh successful canonical Discovery/semantic activation/ordinary start/current readiness. Parent grant first; then desktop grant once. No waiting/wake/retry/renewal/reacquire. If first refuses, stop; if second refuses or is unknown, release every known existing grant and stop. No evidence observation or candidate command until both are positively granted and their13 physical files exactly equal the unchanged source list.",
    "deadlinePolicy": "Record both actual returned expiries and first-grant time. Entire logical hold ends at min(expiry1,expiry2,firstGrant+300s). No renewal. Reserve enough remaining hold lifetime for the unchanged150s command and independent settlement; otherwise terminate without command and release.",
    "currencyPolicy": "Under BOTH positive holds freshly verify all13 exact source hashes, packet/command/fixture hashes, Discovery/activation/start currentness, actual selected endpoint/build/published require_task_confinement schema, source containment and managed-task confinement preconditions. Earlier admission or either single grant waives none.",
    "releasePolicy": "Release ALL returned lock ids on every terminal branch and before any await, including a failed/unknown second grant. Verify release receipt. Unknown release/cleanup is terminal; never start command or reacquire to hide it.",
    "antiBypass": "No parent alias for desktop file, external-path alias, broader subtree hold, alternate root, force, lock bypass or peer-claim override."
  },
  "unchangedPhysicalHoldPaths": [
    "packages/operator-core/lib/vm-release-runtime-policy.ts",
    "scripts/lib/committed-source-loader.mjs",
    "scripts/lib/runtime-compatibility.mjs",
    "scripts/lib/targeted-task-reuse.mjs",
    "apps/operator/bin/release/dependency-generation.sh",
    "apps/operator/bin/release/setup-release-checkout.sh",
    "apps/operator/lib/release/bun-source-only-post-read-guards.test.ts",
    "apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json",
    "papercusp-desktop/bin/build-desktop-sidecar.sh",
    "packages/operator-core/lib/application-runtime-acceptance.ts",
    "apps/operator/lib/release/fixtures/bun-dependency-input-only-guards.sh",
    "packages/operator-core/lib/agent-tools/capability/bash.ts",
    "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts"
  ],
  "reviewedSourcePins": {
    "observedAt": "2026-11-06T18:09:39.900464+00:00",
    "source": "Fresh read-only13-file architecture proposal inventory; prospective reviewer and any new admission must establish fresh currency",
    "pins": {
      "packages/operator-core/lib/vm-release-runtime-policy.ts": "6cd33e5b43b7bd9e89719fddfbae10ba4dac7ffa947e493303eaf88e8dc80f58",
      "scripts/lib/committed-source-loader.mjs": "b739ac60da137b22c916646ba003be8ddd9add1cee3837f814f8dbc9ee6f406b",
      "scripts/lib/runtime-compatibility.mjs": "3ea9afaf8952836afcfd79dbcc54bbc6b31764bd36e7d48db3453a2ebe7dd654",
      "scripts/lib/targeted-task-reuse.mjs": "5130a1851a1183e5171538ee9c7da0d54896033d5b4ebb083c9cc199989a3f74",
      "apps/operator/bin/release/dependency-generation.sh": "c52235afb140e625d1238e47cd7c01f8d55cc2d4e6d767dbf96d62374e464a4c",
      "apps/operator/bin/release/setup-release-checkout.sh": "6a55b4c5fd2d42e9f0738833f83e05611ab2ae9958741f4966fac9b2b2edd0e3",
      "apps/operator/lib/release/bun-source-only-post-read-guards.test.ts": "5fbcbf44858197e8c59d7e9950fe50e0c48fd0dec5cb6192afb76ca146bec42a",
      "apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json": "5d94b3c9b2d6eeb2702083574cc5b7941646317d52579a7bbabf64958fced22c",
      "papercusp-desktop/bin/build-desktop-sidecar.sh": "38d8bb2bf799e442a3e31764593f414a2f7dee91baf376025ce427b6816b2344",
      "packages/operator-core/lib/application-runtime-acceptance.ts": "0b0db46d500f0a98184f80adaf3461284ab125e3766d47cf51c7b403636636a5",
      "apps/operator/lib/release/fixtures/bun-dependency-input-only-guards.sh": "89aa00cef5820ba4b94759fa3744c78cc2ad03b7049c8a06485589c302081b01",
      "packages/operator-core/lib/agent-tools/capability/bash.ts": "0dbe169ad128599640d08ee65230e79bb1c2b3feaf1fcdf7066f0bc88cc7ff46",
      "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts": "14b917749db4b2938f175367b98b4f0168e660308530cd04d247d77d821be956"
    },
    "driftsFromD031": {
      "papercusp-desktop/bin/build-desktop-sidecar.sh": {
        "previous": "86ad06fbe0c59283b8809a14ed1f9970e16769bb434a6c93ea22b4ec6e9f8aa1",
        "current": "38d8bb2bf799e442a3e31764593f414a2f7dee91baf376025ce427b6816b2344"
      }
    }
  },
  "unchangedPacket": {
    "path": "runtime-migration/p006-immutable-helper-pinned-fixture-e1ff5523-proposal-0dcd3-20261106.json",
    "chars": 40259,
    "sha256": "e2fe7325dfee2c02300e5d88576a77e111039459603f8bea0460aa1ca1251ca0",
    "commandChars": 6917,
    "commandSHA256": "92372b3ec5e185617b40b4db436de6b9321c5393922cb8d3456767d0dc17cbbd",
    "fixturePath": "apps/operator/lib/release/fixtures/bun-dependency-input-only-guards.sh",
    "fixtureBytes": 4166,
    "fixtureSHA256": "89aa00cef5820ba4b94759fa3744c78cc2ad03b7049c8a06485589c302081b01",
    "executionStatus": "UNEXECUTED"
  },
  "preservedLimits": {
    "requiredRoute": "Qualified selected current-build managed capability:bash; require_task_confinement:true must positively enroll/confine before fork.",
    "outerMs": 150000,
    "innerSec": 90,
    "innerKillAfterSec": 10,
    "cleanupSec": 5,
    "cleanupKillAfterSec": 1,
    "reserveSec": 44,
    "deadline": "Actual absolute dispatch receipt, independent actual task/descendant settlement and owned scratch removal before that deadline; no postdeadline source/task probes.",
    "stop": "First refusal/evidence drift/nonzero/timeout/unknown cleanup terminates; no repair/re-audit/restart/retry/retarget/fallback/guard stripping/pin refresh.",
    "broaderAcceptance": "No generation/native/installed/DBOS/canary60m/rollback/shipment release; Node selected/BunUNSHIPPED.",
    "route": "Original author personally; no additional implementation agents. Independent review remains required."
  },
  "targetClosurePrecondition": "Actual allocated independent decision MUST be D-032 and its complete body must name this exact whole proposed Discovery body, changed38d8 architecture and unchanged2repository logical-hold strategy. Otherwise this edition is inapplicable; no retarget/pin refresh. The whole declaration must explicitly preserve terminalD031 and support actualD032 before fresh canonical admission.",
  "proposedDiscoveryBody": "This declaration records source-backed architectural findings and the remaining bounded acceptance experiment. It preserves the existing requirements, candidate identity contract, independent review, terminal diagnostic attempts and Node-selected hold; it is not a runtime acceptance result.\n\n```discovery\n{\n  \"questions\": [\n    {\n      \"id\": \"Q-current-behavior\",\n      \"kind\": \"current-behavior\",\n      \"question\": \"Which existing authorities can carry explicit Node/Bun selection and preserve source and proof identity?\",\n      \"stopCondition\": \"Read the current runtime policy, committed-source loader, proof identity and dependency/artifact producer boundaries; identify reuse for P-001 through P-006.\",\n      \"outcome\": \"answered\"\n    },\n    {\n      \"id\": \"Q-required-gap\",\n      \"kind\": \"gap\",\n      \"question\": \"What remains between local source/artifact preparation and an accepted, shipped Bun default?\",\n      \"stopCondition\": \"Identify the canonical candidate acceptance conditions and keep every required native, installed, handoff, rollback and shipment outcome open until its actual receipt exists.\",\n      \"outcome\": \"experiment\",\n      \"rationale\": \"Incomplete target outcomes prevent cutover; they do not invalidate continued evidence preparation while Node remains selected and no candidate is declared accepted.\",\n      \"bounds\": \"D011-D031 terminal. D031 admission passed; parent12 held, desktop1 refused live peer; allparent released, no candidate/scratch. Only actualD032 may admit changed38d8 architecture then ONE same13file hold as12parent+1desktop grants in that order, each<=300s/no renewal; deadline=min(expiries,firstGrant+300s). Both positive before observation/command; second refusal releases first/no reacquire. Fresh13pins/packet/fixture/Discovery/activation/start/endpoint/build/published require_task_confinement/source/confinement checks. Only unchanged6917/92372b3e150s command:90+10 measurement,5+1 cleanup,44reserve; record actual deadline and independently settle task/descendants/owned scratch before it. First refusal/drift/nonzero/timeout/unknown cleanup terminal; release allids/on terminal/before await. No repair/re-audit/restart/retry/retarget/fallback/guard stripping/pin refresh/postdeadline probes. Explicit terminalD031/actualD032 support; Node selected/Bun UNSHIPPED; broader acceptance open.\"\n    },\n    {\n      \"id\": \"Q-feasibility\",\n      \"kind\": \"feasibility\",\n      \"question\": \"Does the existing architecture support a bounded staged migration without a parallel runtime authority?\",\n      \"stopCondition\": \"Confirm explicit packaged runtime selection, runtime-scoped proof identity, immutable dependency provenance and a canonical acceptance verifier exist; distinguish architectural support from target runtime qualification.\",\n      \"outcome\": \"answered\"\n    }\n  ],\n  \"findings\": [\n    {\n      \"id\": \"F-runtime-reuse\",\n      \"questions\": [\n        \"Q-current-behavior\",\n        \"Q-feasibility\"\n      ],\n      \"conclusion\": \"Existing runtime policy, committed-source loader, proof identity and immutable publication supply migration seams, not acceptance. Helperc52235af is outside unchanged6917 stdin92372b3e, which embeds six exact e1ff definitions and sources only guarded4166-byte fixture89aa; packet40259/e2fe7325 remains unexecuted. D031 exact13345/b270d269 readback,13pins,Discovery26,activation27,ordinary start/currentreadiness passed. Its parent12 grant succeeded; desktop1 refused live peer; allparent released/ownqueue empty, no candidate/scratch. Peer later released changed sidecar38d8: two packaging additions reuse pinned Koffi fetch and Linux handler-runtime staging after pinnedNode; they are outside unchanged input-only callgraph and establish no runtime/security acceptance. Distinct exact actualD032 requires fresh canonical admission FIRST, then SAME13files as12parent+1desktop grants in that order, each<=300s/no renewal; deadline=min(expiries,firstGrant+300s). Both positive before fresh13pins/packet/fixture/authority/actualendpoint/build/published require_task_confinement/source/confinement checks or command. Second refusal releases first/no reacquire. All-positive alone permits ONE unchanged150s confined command:90+10 measurement,5+1 cleanup,44reserve; actual deadline and independent task/descendant/scratch settlement before it. First refusal/drift/nonzero/timeout/unknown cleanup terminal; release allheldids/on terminal/before await. No repair/re-audit/restart/reacquire/retry/retarget/fallback/guard stripping/pin refresh/postdeadline probes. D011-D031 terminal/consumed;23478662 custody/export-bounded,Bash-n0 syntax-only. Node selected/Bun UNSHIPPED; generation/native/installed/DBOS/canary60m/rollback/shipment open.\",\n      \"evidenceRefs\": [\n        \"source:packages/operator-core/lib/vm-release-runtime-policy.ts\",\n        \"source:scripts/lib/committed-source-loader.mjs\",\n        \"source:scripts/lib/runtime-compatibility.mjs\",\n        \"source:scripts/lib/targeted-task-reuse.mjs\",\n        \"source:apps/operator/bin/release/dependency-generation.sh\",\n        \"source:apps/operator/bin/release/setup-release-checkout.sh\",\n        \"source:apps/operator/lib/release/bun-source-only-post-read-guards.test.ts\",\n        \"source:apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json\"\n      ],\n      \"dispositions\": [\n        {\n          \"target\": \"P-001\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Keep the finite source-derived capability and platform inventory; local source support cannot replace required target controls.\"\n        },\n        {\n          \"target\": \"P-002\",\n          \"decision\": \"reuse\",\n          \"reason\": \"Extend the existing pinned runtime selection and package policy; preserve Node default until canonical acceptance.\"\n        },\n        {\n          \"target\": \"P-003\",\n          \"decision\": \"reuse\",\n          \"reason\": \"Keep the existing committed-source guard and measured compatibility probes; unresolved native and source-loading behavior still blocks acceptance.\"\n        },\n        {\n          \"target\": \"P-004\",\n          \"decision\": \"reuse\",\n          \"reason\": \"Integrate existing runtime launch authorities; preserve single ownership and explicit child interpreter identity.\"\n        },\n        {\n          \"target\": \"P-005\",\n          \"decision\": \"reuse\",\n          \"reason\": \"Retain existing runtime proof fingerprint and targeted-task proof storage, with negative collision controls.\"\n        },\n        {\n          \"target\": \"P-006\",\n          \"decision\": \"reuse\",\n          \"reason\": \"D031 admission passed; parent12 grant positive, desktop1 refused peer; allparent released/no candidate/scratch. Only independently reviewed actualD032 may reuse unchanged40259/e2fe7325 packet,6917/92372b3e stdin and89aa fixture with changed38d8 architecture. Fresh Discovery/semantic activation/ordinary start/currentreadiness FIRST, then same13files as12parent+1desktop grants, each<=300s/no renewal; deadline=min(expiries,firstGrant+300s). Both positive before fresh evidence/authority/endpoint/build/published require_task_confinement/source/confinement checks/command. Second refusal releases first/no reacquire. At most one150s command with actual deadline and independent task/descendant/scratch settlement before it. First refusal/drift/nonzero/timeout/unknown cleanup terminal; release allids/on terminal/before await. No repair/re-audit/restart/retry/retarget/fallback/guard stripping/pin refresh/postdeadline probes. Explicit terminalD031/actualD032 support; broader acceptance open.\"\n        },\n        {\n          \"target\": \"D-020\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Retain its exact post-read status-preservation repair and fresh semantic admission requirements; old8732/9771 editions remain unexecuted.\"\n        },\n        {\n          \"target\": \"D-021\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Retain exact9896 source prerequisite limits. One attempted activation refused discovery_not_ready and no source command ran; repair discovery first and obtain a distinct successor disposition before any further activation/start/native action.\"\n        },\n        {\n          \"target\": \"D-022\",\n          \"decision\": \"reuse\",\n          \"reason\": \"Preserve completed and consumed source-only preparation and its retained proof. It releases no repeat command, broader native or installed acceptance.\"\n        },\n        {\n          \"target\": \"D-028\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Preserve D028 TERMINAL_NO_START after its one Discovery audit23 blocked the unsupported new D028 target. Schema and cited evidence passed; no activation/start/evidence hold/native command followed. This distinct declaration does not retry or revive D028.\"\n        },\n        {\n          \"target\": \"D-029\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Preserve D029 TERMINAL_NO_START. Its exact12058/99b86dd2 target-closure declaration was applied and read back completely atv75/rev80/f9cad29c, explicitly supporting D028 and actualD029. Its first fresh source observation found helper c52235af versus reviewed03558858. No Discovery audit, activation, start, evidence hold or native command followed. This distinct edition does not retry or revive D029.\"\n        },\n        {\n          \"target\": \"D-030\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Preserve D030 TERMINAL_NO_CANDIDATE_START. Exact12508/811cf974 readback atv77/rev82/f6fa7dda,13sourcepins,Discovery24,activation25,ordinary canonical start/currentexecutionreadiness passed. Its ONE300s13path locks:acquire refused desktop submodule identity before acquiring; own queue empty. No candidate command or scratch ran. No retry/reacquire underD030. A distinct two-domain proposal does not revive it.\"\n        },\n        {\n          \"target\": \"D-031\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Preserve D031 TERMINAL_NO_CANDIDATE_START. Exact13345/b270d269 readback atv79/rev85/ccfec6c1,Discovery26,activation27,ordinary canonical start/specquality/current readiness passed. ONE2repository logical hold: parent12 granted, desktop1 refused live peer. Every parent path released and empty own queue verified. No candidate command/scratch. Complete canonical terminal proof46814/34e8e251 verified before continuation. No retry/reacquire/refresh underD031. Peer release and changed sidecar38d8 require this distinct proposal and independent ruling; they do not revive D031.\"\n        },\n        {\n          \"target\": \"D-032\",\n          \"decision\": \"reuse\",\n          \"reason\": \"Adopt ONLY actual independently reviewed D032 naming this exact whole declaration and changed38d8 sidecar architecture. Preserve terminalD031, unchanged40259/e2fe7325 packet,6917/92372b3e stdin/89aa fixture and all canonical admission/evidence/require_task_confinement/deadline/settlement/first-refusal limits. SAME13physicalfiles as12parent+1desktop grants, each<=300s/no renewal; deadline=min(expiries,firstGrant+300s). Both positive before fresh evidence/authority/endpoint/build/schema/source/confinement checks/command; failed second releases first/no reacquire. Release every heldid on terminal/before await. If actual decision is notD032 or any other target/pin/limit changes, edition inapplicable: no retarget/pin refresh. No native candidate/scratch/implementation before fresh canonical admission and both holds. Broader acceptance open; original author personally/no additional implementation agents.\"\n        }\n      ]\n    },\n    {\n      \"id\": \"F-acceptance-gap\",\n      \"questions\": [\n        \"Q-required-gap\"\n      ],\n      \"conclusion\": \"Current sidecar38d8 preserves retained pinnedNode before candidate Bun selection and adds target-pinned Koffi copying plus Linux handler-runtime staging after pinnedNode. These reuse maintained packaging seams; independent target closure, native load and installer/security approval remain unverified. Both additions are outside unchanged6917 input-only command. This architectural finding reconciles the changed sidecar only for distinct actualD032; D031 remains terminal. Canonical application runtime acceptance reads operational artifacts and exact candidate identity. Source preparation and signed package proofs remain bounded; P007/P008 still require native/installed/user-journey/canary60m/singleton handoff/both rollback/shipment receipts before any Bun-default or shipped claim. No terminal diagnostic replay or runtime/security acceptance follows.\",\n      \"evidenceRefs\": [\n        \"source:papercusp-desktop/bin/build-desktop-sidecar.sh\",\n        \"source:packages/operator-core/lib/application-runtime-acceptance.ts\",\n        \"source:scripts/lib/runtime-compatibility.mjs\"\n      ],\n      \"dispositions\": [\n        {\n          \"target\": \"P-007\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Keep real isolated user journeys, canary/soak, singleton handoff and both rollback directions as required bounded experiments; missing or failing target outcomes block progression.\"\n        },\n        {\n          \"target\": \"P-008\",\n          \"decision\": \"unchanged\",\n          \"reason\": \"Keep independent canonical acceptance, author verdict, exact artifact shipment verification and installed Node rollback retention as explicit final gates.\"\n        }\n      ]\n    }\n  ],\n  \"notApplicable\": null\n}\n```\n\nD031 is TERMINAL_NO_CANDIDATE_START: canonical admission passed; parent12 granted, desktop1 refused peer; allparent released and no candidate/scratch. This DISTINCT proposed D032 reconciles the released sidecar38d8 architecture only; unchanged command and SAME13files/two repository grants remain. The complete current source diff has two packaging additions outside the unchanged input-only callgraph. Preserve every packet/fixture/authority/confinement/deadline/settlement/terminal limit and original personal route. Not applied/not authorized. Actual independent D032 must name this exact whole body with explicit terminalD031/actualD032 support; no retarget/pin refresh. Node selected/Bun UNSHIPPED.",
  "proposedBodyChars": 14044,
  "proofLimits": "Fresh read-only source inventory and exact2-hunk diff; current maintained schema read and text bounds checked. No executable schema test claimed. No canonical D032 decision/reconciliation/audit/activation/start/hold/candidate command/scratch or new implementer. Existing23478662 remains custody/export-bounded; Bash-n0 syntax-only; all broader native/installed/security/canary60m/rollback/shipment acceptance open.",
  "schemaTextBounds": {
    "questionBounds": 995,
    "maxBounds": 1000,
    "maxConclusion": 1731,
    "maxConclusionLimit": 2000,
    "maxDispositionReason": 993,
    "maxReasonLimit": 1000
  },
  "proposedBodySHA256": "f8da66bb8f4bd1c0b5bc7637217ed870e0637a8704cc31bc8cf69451a0a613ac",
  "terminalD031": {
    "status": "TERMINAL_NO_CANDIDATE_START",
    "canonicalAdmissionPassed": true,
    "discoveryAudit": 26,
    "activationAudit": 27,
    "ordinaryStart": "canonical ordinary start/spec-quality/current readiness ready at v79/rev85/ccfec6c1",
    "holdAttempt": "ONE logical13-file hold as2repository grants: parent12 positive; desktop1 refused live peer",
    "parentRelease": "All parent paths released and empty own queue verified, nativef32893; no candidate command or scratch",
    "candidateCommandExecuted": false,
    "scratchAllocated": false,
    "noRetry": true,
    "canonicalProof": {
      "slug": "papercusp",
      "rel_path": "runtime-migration/p006-d031-terminal-two-repository-hold-proof-0dcd3-20261106.json",
      "chars": 46814,
      "sha256": "34e8e251ea09bcad8a0a13acbaa9229c84abeeed85309fe7f56b415b1d91decf",
      "readback": "Complete canonical equality verified before this continuation; do not rerun historical probes for recovery"
    }
  },
  "peerEvidence": {
    "ownerId": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
    "message": "coord-send-8263477c0c1e38a8e3ef6403569dd01c642a6641e388ea2086134cf8f2734e49",
    "timestamp": "2026-11-06T17:50:10.592Z",
    "reported": "Atomic desktop edit complete; submodule lock9ffebf57 released; verification in progress, no SEC/shipment proof",
    "scope": "Does not release or qualify Bun/native/installed acceptance"
  },
  "sourceDiagnosis": {
    "previousDesktopCommit": "2486eaaf52b8c9968f7a9a46ce817fcf65d2c2f3",
    "currentDesktopHEAD": "f003272aa283f53fd9170d823a34693b89ee578a",
    "exactDiff": "diff --git a/bin/build-desktop-sidecar.sh b/bin/build-desktop-sidecar.sh\nindex 23263a9e..b370e8d3 100755\n--- a/bin/build-desktop-sidecar.sh\n+++ b/bin/build-desktop-sidecar.sh\n@@ -2334,6 +2334,13 @@ if ! node \"$HERE/check-ptool-sdk-bundle.mjs\" \"$SIDECAR_DIR/scripts/ptool.mjs\" --\n   exit 1\n fi\n for np in \"${NATIVE_PKGS[@]}\"; do copy_pkg_closure \"$np\"; done\n+# Reuse the existing target-specific npm fetch for Koffi's optional native addon.\n+_koffi_target=\"@koromix/koffi-${_bare_node_platform}-${TARGET_ARCH}\"\n+if [[ ! -d \"$SIDECAR_DIR/node_modules/$_koffi_target\" ]]; then\n+  _koffi_version=\"$(opt_dep_version \"$SIDECAR_DIR/node_modules/koffi/package.json\" \"$_koffi_target\")\"\n+  [[ -n \"$_koffi_version\" ]] || { echo \"ERROR: Koffi target pin missing\" >&2; exit 1; }\n+  fetch_cross_npm_pkg \"$_koffi_target@$_koffi_version\" \"$SIDECAR_DIR/node_modules\" || exit 1\n+fi\n copy_host_external_closures || exit 1\n echo \"  copied $nat_copied package(s) ($nat_missing missing)\"\n \n@@ -4599,6 +4606,20 @@ if [[ -z \"$node_dst\" || ! -s \"$node_dst\" ]]; then\n   exit 1\n fi\n \n+# Measure one target-specific guest closure. Installer approval remains separate.\n+if [[ \"$target_os\" == linux ]]; then\n+  case \"$target_arch\" in\n+    x64) _handler_triplet=x86_64-linux-gnu ;;\n+    arm64) _handler_triplet=aarch64-linux-gnu ;;\n+    *) echo \"ERROR: unsupported Linux handler runtime architecture\" >&2; exit 1 ;;\n+  esac\n+  _handler_library_dirs=()\n+  for _handler_dir in \"/lib/$_handler_triplet\" \"/usr/lib/$_handler_triplet\" \"/usr/$_handler_triplet/lib\"; do\n+    [[ ! -d \"$_handler_dir\" ]] || _handler_library_dirs+=(\"$_handler_dir\")\n+  done\n+  stage_handler_runtime \"$node_dst\" \"$target_arch\" \"$SIDECAR_DIR/handler-runtime\" \"${_handler_library_dirs[@]}\" || exit 1\n+fi\n+\n # Bun is a packaged candidate; the runtime selector continues to default to Node.\n # Both fresh and cached archives must match the published per-target checksum.\n # The same Linux input is used by a Linux/WSL producer; never substitute bun.exe.\n",
    "changes": [
      "Existing target-specific npm fetch obtains pinned Koffi optional native addon before host external closures.",
      "Linux x64/arm64 handler-runtime stage is invoked after the retained pinned Node file is present, using target triplet library directories; installer approval remains separate."
    ],
    "architecturalEffect": "Both additions affect sidecar packaging, not the unchanged input-only command. That command embeds six exact helper definitions and guards the89aa fixture; it does not source/invoke the sidecar producer. Architectural reuse remains possible but no producer/native/installed/security/shipment acceptance follows.",
    "reuse": "Existing fetch_cross_npm_pkg, opt_dep_version and stage_handler_runtime; same runtime selector/acceptance authority, no new durable surface.",
    "limits": "Read-only architecture diff and text-bound checks only; peer verification in progress; no claim that cross-target closure or runtime acceptance passed."
  },
  "declarationSchema": {
    "path": "packages/operator-core/lib/agent-tools/plans/plan-declarations.ts",
    "sha256": "b3a9fe7ff49cbd729332ba1fabe28c686b37f559a90716a1c2370a8fbf7fe336",
    "limits": {
      "bounds": 1000,
      "conclusion": 2000,
      "reason": 1000
    },
    "inspection": "Current lines131-170 read; executable schema validation delegated to independent review, no test claimed here."
  }
}


---
rel_path: "runtime-migration/p006-activation-source-preparation-0dcd3-20261106.json"
updated_at: 1793957079532
_body: "content"
---

{
  "schemaVersion": "bun-p006-activation-source-preparation-v1",
  "status": "preparation-only-no-audit-or-start",
  "owner": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "plan": {
    "slug": "node-to-bun-staged-migration-2026-10-22",
    "version": 55,
    "contentHash": "a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5"
  },
  "sourceRange": {
    "sourceKind": "codex",
    "sessionId": "01a164c3-b999-7182-a843-f9ae4d9b08f7",
    "fromTurn": 1,
    "toTurn": 8
  },
  "sourceTurns": [
    {
      "ref": "session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:1",
      "turn_idx": 1,
      "speaker": "user",
      "owner": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "ts": "2026-10-22 13:59:32.05-04",
      "text": "What would it take to switch us from node to bun?  How can we do it while leaving node active until the system is fully ready for the swap?"
    },
    {
      "ref": "session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:2",
      "turn_idx": 2,
      "speaker": "assistant",
      "owner": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "ts": "2026-10-22 13:59:37.849-04",
      "text": "I’ll check where Node is used across the workspace, then map a staged Bun migration that keeps the current Node system running through validation and cutover."
    },
    {
      "ref": "session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:3",
      "turn_idx": 3,
      "speaker": "assistant",
      "owner": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "ts": "2026-10-22 14:00:54.96-04",
      "text": "The repo pins Node 25 and npm, and its install guard currently rejects other package managers. I’d separate the work into three choices—runtime, package manager, and test runner—so Bun can be validated while Node continues serving the system."
    },
    {
      "ref": "session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:4",
      "turn_idx": 4,
      "speaker": "assistant",
      "owner": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "ts": "2026-10-22 14:02:11.563-04",
      "text": "The main work is in the host and desktop launch paths. They use Node’s cluster support, native addons, and V8 diagnostics. Bun can be installed alongside Node, but those paths need compatibility checks; HTTP, database, streaming, and background-worker behavior also need to pass before cutover."
    },
    {
      "ref": "session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:5",
      "turn_idx": 5,
      "speaker": "assistant",
      "owner": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "ts": "2026-10-22 14:04:01.85-04",
      "text": "I confirmed a concrete blocker with a small probe: Bun’s `module.register()` did not run the supplied loader hook. Our test path uses that hook to enforce committed-source loading, so it needs an equivalent guard before it can move to Bun. Bun 1.3.14 is already installed here, which makes an isolated compatibility trial practical without replacing Node."
    },
    {
      "ref": "session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:6",
      "turn_idx": 6,
      "speaker": "assistant",
      "owner": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "ts": "2026-10-22 14:07:45.879-04",
      "text": "The recommended sequence is now clear: validate Bun in isolation, canary request serving, transfer background ownership, then switch the packaged product’s default. Keep a known-good Node artifact through a tested rollback window. The analysis is complete; I’m working around a report-publication service error to save the detailed recommendation."
    },
    {
      "ref": "session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:7",
      "turn_idx": 7,
      "speaker": "assistant",
      "owner": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "ts": "2026-10-22 14:12:06.729-04",
      "text": "Yes. **Make the application support both runtimes first, keep Node as the default, and switch only after Bun passes acceptance and rollback tests.**\n\nI checked the repo and local runtimes. Node 25.9.0 and Bun 1.3.14 are already installed. The substantial work is in our host, background workers, native dependencies, tests, and desktop packaging.\n\nI’d use this sequence:\n\n| Phase | What changes | What Node continues doing |\n|---|---|---|\n| 1. Add explicit runtime selection | Extend existing launch configuration to select Node or Bun per process role. | Runs the current system unchanged. |\n| 2. Validate Bun separately | Run the same application version with separate ports, sockets, data, and identity. Test native addons, database operations, streaming, terminals, workers, and recovery. | Remains the production runtime. |\n| 3. Add Bun acceptance checks | Record separate Node and Bun results, including runtime versions and cache identities. | Keeps its existing mandatory checks. |\n| 4. Canary individual roles | Move request serving first, then transfer background ownership using existing singleton/lease controls. | Serves the remaining workload and remains available for rollback. |\n| 5. Switch the default | Validate actual desktop/server artifacts, rehearse rollback, then promote through the normal release pipeline. | Stays packaged and tested through an agreed rollback window. |\n\n**There are concrete compatibility gaps to resolve.** In small local probes, Bun did not execute a `module.register()` loader hook that Node executed. Our committed-source enforcement depends on that mechanism. Bun also rejected a V8 flag API used by our memory watchdog’s GC fallback. Native addons and clustered process behavior still need application-level testing.\n\nFor a reliable transition:\n\n- Keep **npm, `package-lock.json`, and the existing test frameworks** initially. Those can migrate independently.\n- Keep Node’s executable intact; select Bun explicitly in launch configuration.\n- Prevent duplicate background jobs and mutating traffic during parallel validation.\n- Keep database and persisted formats compatible with the retained Node release. Restoring an executable cannot undo incompatible data writes.\n- Require successful operational soak, failure recovery, packaged-product tests, and a rollback rehearsal before cutover.\n\nI’d start with a **1–2 engineer-day compatibility spike**, then budget **weeks for the full migration**. That is an initial estimate; native-addon support and equivalent source-loading enforcement are the largest uncertainties.\n\nThe [detailed migration assessment](/reports?sel=rpt_1119f52c-a5b8-4e47-8344-c1a6e2918710) is saved and verified. No application or runtime configuration was changed."
    },
    {
      "ref": "session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:8",
      "turn_idx": 8,
      "speaker": "user",
      "owner": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "ts": "2026-10-22 14:18:52.036-04",
      "text": "Write this into a plan and then put yourself on auto mode and carry it to shipped status yourself now"
    }
  ],
  "productShaping": "```product-shaping\n{\n  \"audience\": \"Workspace operators, developers and installed Papercusp users.\",\n  \"problem\": \"A runtime replacement can interrupt the active system, break native features or duplicate background effects.\",\n  \"outcome\": \"Bun becomes the accepted application runtime while Node serves until readiness and remains a tested rollback.\",\n  \"nonGoals\": [\n    \"Change npm/package-lock.json\",\n    \"Replace test frameworks or bundler\",\n    \"Remove Node-dependent external CLIs\",\n    \"Remove retained Node within seven days after cutover\"\n  ],\n  \"sourceRefs\": [\n    \"session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:1\",\n    \"session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:8\"\n  ],\n  \"context\": [\n    {\n      \"kind\": \"owner-request\",\n      \"text\": \"Write the assessed migration into a plan, enable AUTO, implement personally and carry to shipped status now.\",\n      \"sourceRefs\": [\n        \"session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:8\"\n      ]\n    },\n    {\n      \"kind\": \"observed-fact\",\n      \"text\": \"Installed Bun1.3.14 did not invoke a module.register resolve hook and rejected the V8 flag fallback; required addons and application journeys remain untested.\",\n      \"sourceRefs\": [\n        \"WI-6554700010020701\"\n      ]\n    },\n    {\n      \"kind\": \"assumption\",\n      \"text\": \"Retain Node for at least seven days after cutover; no Node removal is part of this plan.\",\n      \"recommendation\": \"Keep compatible pinned Node artifacts installed and validated.\"\n    },\n    {\n      \"kind\": \"product-choice\",\n      \"text\": \"Implement personally with canonical independent acceptance, keep npm and existing tests, and block final default change on required platform evidence.\",\n      \"material\": true,\n      \"resolved\": true,\n      \"recommendation\": \"Use explicit role boundaries and the existing release pipeline.\"\n    }\n  ],\n  \"scenarios\": [\n    {\n      \"id\": \"SC-001\",\n      \"title\": \"Continue serving on Node during validation\",\n      \"kind\": \"normal\",\n      \"trigger\": \"A Bun candidate is prepared.\",\n      \"action\": \"Run the candidate in an isolated runtime while existing Node serving continues.\",\n      \"outcome\": \"Node remains selected and available until Bun passes the acceptance gate.\",\n      \"requirementIds\": [\n        \"R-1\",\n        \"R-2\",\n        \"R-4\"\n      ]\n    },\n    {\n      \"id\": \"SC-002\",\n      \"title\": \"Reject an unsafe or incomplete candidate\",\n      \"kind\": \"failure\",\n      \"trigger\": \"A required native capability or source guard fails under Bun.\",\n      \"action\": \"Record failing evidence and withhold Bun promotion while repairing the cause.\",\n      \"outcome\": \"No skipped capability is counted as ready and the Node path remains working.\",\n      \"requirementIds\": [\n        \"R-2\",\n        \"R-3\",\n        \"R-4\"\n      ]\n    },\n    {\n      \"id\": \"SC-003\",\n      \"title\": \"Transfer background execution once\",\n      \"kind\": \"concurrency\",\n      \"trigger\": \"A validated Bun request canary is ready for background ownership.\",\n      \"action\": \"Drain and hand off through existing singleton/lease controls.\",\n      \"outcome\": \"Exactly one runtime owns each mutating background role.\",\n      \"requirementIds\": [\n        \"R-5\",\n        \"R-7\"\n      ]\n    },\n    {\n      \"id\": \"SC-004\",\n      \"title\": \"Recover through retained Node\",\n      \"kind\": \"recovery\",\n      \"trigger\": \"Bun fails during the rollback rehearsal.\",\n      \"action\": \"Drain connections and restore the compatible pinned Node artifact and ownership.\",\n      \"outcome\": \"The system recovers without duplicate effects or unreadable data.\",\n      \"requirementIds\": [\n        \"R-1\",\n        \"R-5\",\n        \"R-7\"\n      ]\n    },\n    {\n      \"id\": \"SC-005\",\n      \"title\": \"Install and ship a validated artifact\",\n      \"kind\": \"normal\",\n      \"trigger\": \"All required platform journeys and independent acceptance pass.\",\n      \"action\": \"Promote the exact artifact and verify runtime identity in the delivered app.\",\n      \"outcome\": \"Bun is the accepted application default and Node rollback remains installed.\",\n      \"requirementIds\": [\n        \"R-6\",\n        \"R-8\"\n      ]\n    }\n  ],\n  \"considerations\": [\n    {\n      \"category\": \"Data safety\",\n      \"disposition\": \"covered\",\n      \"reason\": \"No incompatible persisted formats during coexistence.\",\n      \"scenarioIds\": [\n        \"SC-004\"\n      ]\n    },\n    {\n      \"category\": \"Platform coverage\",\n      \"disposition\": \"covered\",\n      \"reason\": \"Actual delivered Linux/macOS/Windows-WSL artifact matrix, not shell-only tests.\",\n      \"scenarioIds\": [\n        \"SC-005\"\n      ]\n    },\n    {\n      \"category\": \"Authorization\",\n      \"disposition\": \"covered\",\n      \"reason\": \"Owner selected AUTO and personal implementation; required independent review remains.\",\n      \"scenarioIds\": [\n        \"SC-001\",\n        \"SC-005\"\n      ]\n    }\n  ]\n}\n```\n\nAudience: the workspace operator, developers and installed Papercusp desktop/server users.\n\nProblem: runtime migration can interrupt the active Node system, weaken source guards, duplicate background effects or strand a platform on incompatible native binaries.\n\nOutcome: Bun becomes the accepted application runtime through explicit staged selection, with Node continuously serving until acceptance and a verified retained rollback artifact.\n\nNon-goals: changing npm/package-lock.json, replacing Vitest/node:test/esbuild, removing Node-dependent external CLIs, removing Node during the rollback window, or changing data schemas merely to change runtimes.\n\nSource turns: session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:1, session_turn:codex:01a164c3-b999-7182-a843-f9ae4d9b08f7:8. The owner asked to write the assessment into a plan, enable AUTO, implement personally and carry it to shipped now. The prior assessment is report rpt_1119f52c-a5b8-4e47-8344-c1a6e2918710; WI-6554700010020701.\n\nScenarios: (1) normal Node operation continues while an isolated Bun candidate fails safely; (2) a Bun request canary serves successful authenticated streaming and terminal journeys while Node owns background work; (3) accepted Bun takes background ownership without duplicate jobs; (4) a forced Bun failure drains and returns to the same compatible Node artifact; (5) a clean installed desktop launches the selected runtime offline on every supported platform.\n\nAssumptions: npm and current test frameworks remain. A seven-day minimum rollback retention is an agent-selected safety default, not a claim that seven days of soak have already elapsed. Unsupported required capabilities block final cutover. The owner selected this session for implementation; independent platform-routed acceptance reviewers are still required.",
  "scopeLimits": [
    "Original owner turns are 1 and 8; assistant assessment is context, not owner speech.",
    "Seven-day Node retention is an agent safety assumption, not elapsed-soak evidence.",
    "Current source-read preparation does not settle independent grading audit.",
    "EI-28028907482671021 must never be re-emitted by its author.",
    "D019 is terminal after refused canonical start: no retry, fallback or retarget.",
    "A distinct scope and fresh current activation audit/start are still required before execution.",
    "Bun candidate/native/installed/full-platform and shipped acceptance remain open; Node remains selected."
  ],
  "qualityCard": {
    "issueId": "EI-28028907482671021",
    "evidenceFingerprint": "b3f6812821c3d6e406be8d34316a82f7deb318576419a3eda7afe57c322d8274",
    "independentAudit": "pending-last-read"
  },
  "mappingPreparation": [
    {
      "sourceTurn": 1,
      "coveredIntent": "Staged runtime change while Node continues serving until system readiness.",
      "planTargets": [
        "R-1",
        "R-2",
        "R-4",
        "R-5",
        "R-7"
      ]
    },
    {
      "sourceTurn": 8,
      "coveredIntent": "Author migration plan, AUTO, personal implementation through verified shipment.",
      "planTargets": [
        "section:Product shaping",
        "R-6",
        "R-8"
      ]
    }
  ],
  "remainingBeforeActivation": [
    "Read current governing decisions and any distinct execution scope in full.",
    "Verify the canonical current card has a terminal independent grading-integrity PASS.",
    "Reconcile current plan/spec hashes and preserve original mappings/provenance/BARs.",
    "Record fresh scoped activation audit, then canonical start, without retrying D019."
  ]
}

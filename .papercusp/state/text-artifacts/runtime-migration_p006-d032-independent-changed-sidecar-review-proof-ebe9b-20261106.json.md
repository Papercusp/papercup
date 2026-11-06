---
rel_path: "runtime-migration/p006-d032-independent-changed-sidecar-review-proof-ebe9b-20261106.json"
updated_at: 1793989691192
_body: "content"
---

{
  "schemaVersion": "p006-d032-independent-review-v1",
  "workItem": "WI-6554700010045999",
  "proposalRef": "papercusp:runtime-migration/p006-d031-terminal-sidecar-architecture-d032-proposal-0dcd3-20261106.json",
  "proposalChars": 31982,
  "discoveryChars": 14044,
  "hashes": {
    "proposal": "0a593228e77ebcaf8f484241c610b5b1d59e680f70cc8b7b9fdc1f74a27358f4",
    "discovery": "f8da66bb8f4bd1c0b5bc7637217ed870e0637a8704cc31bc8cf69451a0a613ac",
    "packet": "e2fe7325dfee2c02300e5d88576a77e111039459603f8bea0460aa1ca1251ca0",
    "command": "92372b3ec5e185617b40b4db436de6b9321c5393922cb8d3456767d0dc17cbbd"
  },
  "sourcePins": {
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
  "all13SourcePinsMeasuredMatch": "exec29448f",
  "lockContractPins": {
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
  "sourceInspection": "exec c46198: maintained schema/current two sidecar hunks",
  "executableSchema": {
    "tool": "exec679990",
    "exitCode": 0,
    "ordinarySharedReader": true,
    "schemaPass": true,
    "positiveSyntheticD032Closure": true,
    "negativeUnsupportedD033Rejected": true,
    "physicalFilesEqual": true,
    "grantSizes": [
      12,
      1
    ],
    "limitation": "Synthetic evidence usability only; canonical server admission remains mandatory"
  },
  "canonicalReadback": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "slug": "node-to-bun-staged-migration-2026-10-22",
        "harness": "papercusp",
        "archived": false,
        "legacy": false,
        "frontmatter": {
          "title": "Bun runtime adoption with active Node coexistence and verified rollback",
          "slug": "node-to-bun-staged-migration-2026-10-22",
          "status": "ready",
          "created": "2026-10-22",
          "updated": "2026-11-06"
        },
        "contentHash": "bfc5d83acda642e55c1ea5a9114f722de4c02300384d303d179fd822fb3b661b",
        "version": 80,
        "forcedPast": null,
        "counts": {
          "items": 8,
          "decisions": 32,
          "sections": 11
        },
        "decisions": [
          {
            "id": "D-032",
            "title": "Close D031 and condition the changed-sidecar successor on exact actual D032 support",
            "body": "Date: 2026-11-06\nMeasured: Independent WI-6554700010045999 review read COMPLETE proposal31982/SHA0a593228e77ebcaf8f484241c610b5b1d59e680f70cc8b7b9fdc1f74a27358f4 and whole proposed Discovery14044/SHAf8da66bb8f4bd1c0b5bc7637217ed870e0637a8704cc31bc8cf69451a0a613ac. Current named13 source pins and3 lock-contract pins match (exec29448f). Actual sidecar38d8 source at2340-2346 and4609-4622 has the two reported packaging additions, outside the unchanged input-only callgraph. Maintained schema and pure target-readiness evaluation ran under ordinary install shared-reader admission (exec679990 exit0): schemaPASS, synthetic actualD032 closurePASS, unsupportedD033 negativeFAIL as expected; exact physical13 equality and grant sizes12+1. Synthetic evidence usability is not canonical admission or product/runtime proof.\nD031 is TERMINAL_NO_CANDIDATE_START: prior canonical admission passed, parent12 held, desktop1 refused live peer, all parent grants released; no candidate/scratch. Peer release and changed38d8 packaging architecture do not revive it. D011-D031 remain terminal/consumed.\nNEW disposition: REVIEWED_CHANGED_ARCHITECTURE_TWO_REPOSITORY_SUCCESSOR_READY_CONDITIONAL for ONLY papercusp:runtime-migration/p006-d031-terminal-sidecar-architecture-d032-proposal-0dcd3-20261106.json and its EXACT WHOLE14044/f8da66bb proposed Discovery. Actual allocated decision MUST be D-032. Complete ruling readback must equal this body apart from canonical Date/Related metadata; otherwise this edition is inapplicable. No retarget/pin refresh. Reconcile ONLY the exact whole declaration and verify full readback explicitly preserving terminalD031 and supporting actualD032 before fresh canonical observation/audit. Any other changed target, drift or material change terminates this edition.\nOriginal author WI-6554700010022072 may then perform ONE ordinary fresh Discovery observation/audit, semantic activation audit, plans:start and current execution-readiness through the qualified selected endpoint. All Discovery/spec-quality/independent acceptance/consult/start gates remain required. Before positive admission: no candidate command/scratch, generation/lease/build/install/runtime/VM action or implementation fanout. First refusal terminates; no repair/re-audit/restart within D032.\nAfter positive admission acquire ONE logical hold on SAME13 physical files as EXACT2 grants in order:12 parent paths under /home/marsh-office/papercupai-workspace/papercusp, then bin/build-desktop-sidecar.sh under /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop. Each<=300s/no renewal; overall deadline=min(actual expiries,firstGrant+300s). No waiting/wake/retry/reacquire. First refusal stops; second refusal/unknown releases every known grant and stops. Both positive before fresh evidence observation/command. Reserve enough lifetime for150s command and independent settlement or release/stop. No alias/external-path bypass/broader subtree/alternate root/force/peer override.\nUnder BOTH positive holds freshly verify all13 hashes, exact packet40259/e2fe7325, stdin6917/92372b3e and fixture4166/89aa, Discovery/activation/start currency, actual endpoint/build/published require_task_confinement schema, source containment and managed-task confinement preconditions. Prior admission or either single grant waives none. Any drift/stale authority/refusal/expiry terminates: release/report; no repair/re-audit/restart/reacquire.\nONLY all-positive permits ONE UNCHANGED150s managed input-only command with require_task_confinement:true:90+10s measurement,5+1s cleanup,44s reserve. Record actual absolute deadline; independently verify actual task/descendant settlement and owned scratch removal before it. First nonzero/timeout/unknown cleanup/refusal terminates. Release ALL returned lock_ids on every terminal branch and before await; verify release receipt. Unknown release is terminal. No retries/retarget/fallback/guard stripping/pin refresh/postdeadline source/task probes.\nThe changed sidecar Koffi fetch/handler-runtime staging establishes no native/security/installed acceptance. Retained23478662 remains custody/export-bounded; Bash-n0 syntax-only. Node selected/Bun UNSHIPPED; generation/native/installed/DBOS/canary60m/rollback/shipment open. Original author personally owns execution; no additional implementation agents. Reviewer does not execute or monitor the candidate.\nRelated: P-006",
            "date": "2026-11-06",
            "itemRefs": [
              "P-006"
            ],
            "affects": [],
            "lineNumber": 843,
            "provenance": {
              "kind": "agent",
              "agentId": "su-ebe9b9b1-f43d-4eb4-839d-e281da578e4b",
              "source": "write",
              "recordedAt": "2026-11-06 13:25:24.244476-05"
            }
          }
        ],
        "decisionSelection": {
          "requested": [
            "D-032"
          ],
          "matched": [
            "D-032"
          ],
          "missing": []
        }
      }
    ],
    "counts": {
      "ok": 1,
      "failed": 0
    }
  },
  "readbackExactApartDateRelated": true,
  "verificationScope": "Review only; no candidate execution, physical lock grant, broader runtime/security/installed/shipment acceptance or peer monitoring"
}

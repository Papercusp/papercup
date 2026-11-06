---
rel_path: "runtime-migration/p006-d031-independent-two-repository-review-proof-ebe9b-20261106.json"
updated_at: 1793986337730
_body: "content"
---

{
  "schemaVersion": "p006-d031-independent-two-repository-review-v1",
  "workItem": "WI-6554700010045986",
  "request": "coord-send-ca0b3004eb87672084456f816afda5fea47192c8f9528566984cff85158c7f12",
  "proposalRef": "papercusp:runtime-migration/p006-d030-terminal-repository-domain-successor-proposal-0dcd3-20261106.json",
  "proposalChars": 25180,
  "proposalSHA256": "e6cf91662e1d37614ae3fcbea76028bdfa999f35594a24ceecc57e16104babd3",
  "discoveryChars": 13345,
  "discoverySHA256": "b270d26938748c5c9987c3ab297d648a2e6e56dbec8134bf46223d53df656ebe",
  "review": {
    "inventoryToolCall": "exec_command:85df4e",
    "namedSourcePins": {
      "packages/operator-core/lib/vm-release-runtime-policy.ts": "6cd33e5b43b7bd9e89719fddfbae10ba4dac7ffa947e493303eaf88e8dc80f58",
      "scripts/lib/committed-source-loader.mjs": "b739ac60da137b22c916646ba003be8ddd9add1cee3837f814f8dbc9ee6f406b",
      "scripts/lib/runtime-compatibility.mjs": "3ea9afaf8952836afcfd79dbcc54bbc6b31764bd36e7d48db3453a2ebe7dd654",
      "scripts/lib/targeted-task-reuse.mjs": "5130a1851a1183e5171538ee9c7da0d54896033d5b4ebb083c9cc199989a3f74",
      "apps/operator/bin/release/dependency-generation.sh": "c52235afb140e625d1238e47cd7c01f8d55cc2d4e6d767dbf96d62374e464a4c",
      "apps/operator/bin/release/setup-release-checkout.sh": "6a55b4c5fd2d42e9f0738833f83e05611ab2ae9958741f4966fac9b2b2edd0e3",
      "apps/operator/lib/release/bun-source-only-post-read-guards.test.ts": "5fbcbf44858197e8c59d7e9950fe50e0c48fd0dec5cb6192afb76ca146bec42a",
      "apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json": "5d94b3c9b2d6eeb2702083574cc5b7941646317d52579a7bbabf64958fced22c",
      "papercusp-desktop/bin/build-desktop-sidecar.sh": "86ad06fbe0c59283b8809a14ed1f9970e16769bb434a6c93ea22b4ec6e9f8aa1",
      "packages/operator-core/lib/application-runtime-acceptance.ts": "0b0db46d500f0a98184f80adaf3461284ab125e3766d47cf51c7b403636636a5",
      "apps/operator/lib/release/fixtures/bun-dependency-input-only-guards.sh": "89aa00cef5820ba4b94759fa3744c78cc2ad03b7049c8a06485589c302081b01",
      "packages/operator-core/lib/agent-tools/capability/bash.ts": "0dbe169ad128599640d08ee65230e79bb1c2b3feaf1fcdf7066f0bc88cc7ff46",
      "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts": "14b917749db4b2938f175367b98b4f0168e660308530cd04d247d77d821be956"
    },
    "lockContractPins": {
      "acquire": {
        "path": "packages/operator-core/lib/agent-tools/locks/acquire.ts",
        "sha256": "43e2c0aefae92d07ec28497fc0be03fb02d9baad8afc97512a94b22a25af9397",
        "lines": "312-336",
        "fact": "All normalized paths are checked against nearest managed repository before acquire. One returned lock id has one coordination_domain; another domain is refused with the required domain/path."
      },
      "release": {
        "path": "packages/operator-core/lib/agent-tools/locks/release.ts",
        "sha256": "faa45712d9ddcb06b856143ce0d8c44fe56b7ab072482ff2451b88533d791eeb",
        "fact": "Existing release accepts lock_ids, with owner attribution and stored repository identities."
      },
      "regression": {
        "path": "packages/operator-core/lib/agent-tools/locks/coordination-domain.file-domain.test.ts",
        "sha256": "ad0a10fcf4ba57d7d24edca1f539b54839b8f772a6a015356b3a09f317365a27",
        "status": "source pin only; not run in this preparation"
      }
    },
    "allNamedPinsMatched": true,
    "physicalPathsMatch": true,
    "grantSizes": [
      12,
      1
    ],
    "boundLengths": {
      "questionBounds": 996,
      "conclusion": 1919,
      "disposition": 980
    },
    "verificationClass": "read-only source/schema/identity inspection",
    "notPerformed": [
      "executable schema validation",
      "canonical admission",
      "lock acquisition",
      "candidate execution",
      "peer monitoring"
    ]
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
        "contentHash": "f6812ee507ce99c4454fed9ea0aa47fcd5dc5726694cd7797a241b9cce25affc",
        "version": 78,
        "forcedPast": null,
        "counts": {
          "items": 8,
          "decisions": 31,
          "sections": 11
        },
        "decisions": [
          {
            "id": "D-031",
            "title": "Close D030 and condition the exact two-repository successor on actual D031 support",
            "body": "Date: 2026-11-06\nDate: 2026-11-06\nMeasured: Independent review WI-6554700010045986 read COMPLETE proposal25180/SHA e6cf91662e1d37614ae3fcbea76028bdfa999f35594a24ceecc57e16104babd3 and whole proposed Discovery13345/SHA b270d26938748c5c9987c3ab297d648a2e6e56dbec8134bf46223d53df656ebe. Read-only inventory85df4e confirms both hashes, all13 source pins plus3 cited lock-contract pins match, exact physical13-file equality and grant sizes12+1. Source acquire.ts:312-336 rejects mixed nearest-repository identities before routing; release.ts:539-573,673-700 resolves owner-checked lock_ids across stored domains. Maintained declaration schema read at plan-declarations.ts:131-170; authored bounds996/conclusion1919/reason980 fit its limits. Static review only: no new executable schema test, canonical admission, lock grant, runtime acceptance or candidate command.\nD030 is TERMINAL_NO_CANDIDATE_START: exact12508/811cf974 declaration and canonical Discovery24/activation25/start/current readiness passed, but its sole mixed-repository13-path hold refused the nested desktop domain. Proposal records empty own lock queue afterward and no candidate command/scratch. This edition does not retry or revive D030.\nNEW distinct disposition: REVIEWED_TWO_REPOSITORY_SUCCESSOR_READY_CONDITIONAL for ONLY papercusp:runtime-migration/p006-d030-terminal-repository-domain-successor-proposal-0dcd3-20261106.json and its EXACT WHOLE13345/b270d269 body. Actual allocated decision MUST be D-031 and complete ruling readback must equal this body apart from canonical Date/Related metadata; otherwise this edition is inapplicable. No retarget, pin refresh or admission. Reconcile only that exact whole Discovery body and verify complete readback supporting terminalD028/D029/D030 and actualD031 before fresh canonical observation/audit. Every other changed target, drift or material change terminates this edition.\nOriginal author WI-6554700010022072 may then perform ONE ordinary fresh targeted Discovery observation/audit, semantic activation audit, plans:start and current execution readiness through the qualified selected endpoint. All Discovery/spec-quality/independent-acceptance/consult/start gates remain required. Before positive admission: no native command, scratch, generation/lease/build/install/runtime/VM action or implementation fan-out. First refusal terminates; no repair/re-audit/restart within D031.\nAfter positive admission acquire ONE logical hold on SAME13 physical files as EXACT2 grants in deterministic order:12 parent paths under /home/marsh-office/papercupai-workspace/papercusp, then bin/build-desktop-sidecar.sh under /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop. Each<=300s/no renewal; overall deadline=min(actual expiries,firstGrant+300s). No waiting/wake/retry/reacquire. First refusal stops; second refusal/unknown releases every known grant and stops. Both positive before evidence observation/command. Reserve sufficient remaining lifetime for150s command plus independent settlement; otherwise release/stop. No aliases/external-path bypass/broader subtree/alternate root/force/peer override.\nUnder BOTH positive holds freshly verify all13 source hashes, exact packet40259/e2fe7325, stdin6917/92372b3e and fixture4166/89aa, Discovery/activation/start currency, actual selected endpoint/build/published require_task_confinement schema, source containment and task-confinement preconditions. Prior admission or either single grant waives none. Any drift/stale authority/refusal/expiry terminates: release/report, no repair/re-audit/restart/reacquire.\nONLY all-positive permits ONE UNCHANGED150s managed input-only command with require_task_confinement:true:90+10s measurement,5+1s cleanup,44s reserve. Record actual absolute deadline; independently verify actual task/descendant settlement and owned scratch removal before it. First nonzero/timeout/unknown cleanup/refusal terminates. Release ALL returned lock_ids on every terminal branch and before await; verify release receipt. Unknown release is terminal. No retries/retargeting/fallback/guard stripping/pin refresh/postdeadline source/task probes.\nD011-D030 stay terminal/consumed. Retained12-case23478662 proof remains custody/export-bounded; Bash-n0 syntax-only. Node selected/Bun UNSHIPPED. No broader generation/native/installed/DBOS/canary60m/rollback/shipment acceptance. Original author owns original personal/no-additional-implementation-agents execution. Independent reviewer does not execute or monitor the candidate.\nRelated: P-006",
            "date": "2026-11-06",
            "itemRefs": [
              "P-006"
            ],
            "affects": [],
            "lineNumber": 825
          }
        ],
        "decisionSelection": {
          "requested": [
            "D-031"
          ],
          "matched": [
            "D-031"
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
  "report": {
    "id": "rpt_faaa5c5f-4798-4dcc-8b2f-547de430e5e7",
    "path": "/reports/rpt_faaa5c5f-4798-4dcc-8b2f-547de430e5e7"
  },
  "terminalScope": "D011-D030 terminal/consumed; original author owns fresh D031 admission/holds/currency and at most one bounded attempt. Node selected/Bun unshipped."
}

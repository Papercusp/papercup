---
rel_path: "runtime-migration/p006-d022-e1ff5523-source-only-result-0dcd3-20261106.json"
updated_at: 1793965299648
_body: "content"
---

{
  "schemaVersion": "bun-p006-d022-source-only-result-v1",
  "recordedAt": "2026-11-06T11:40:54.870Z",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "workItem": "WI-6554700010022072",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "decision": "D-022",
  "status": "SOURCE_ONLY_PASS_CLEANUP_VERIFIED_SCOPE_CONSUMED",
  "source": {
    "commit": "e1ff55230c4bfc416a7c1e1fa7382968db8c3f39",
    "root": "/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106",
    "exactHeadStandaloneGitAndFullCleanStatus": "Verified by exact reviewed2339-character command's checked assignments/assertions, followed by native exit0.",
    "submodules": "Original native command recursive status succeeded; retained marker object_sourced=39 cloned=39 archive=0 live_tree=0."
  },
  "admissionProof": {
    "relPath": "runtime-migration/p006-d022-admission66-source-running-0dcd3-20261106.json",
    "wholeReadbackVerified": true,
    "chars": 18915,
    "canonicalStart": {
      "schema": "plan-execution-start-v1",
      "scope": {
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "planSlug": "node-to-bun-staged-migration-2026-10-22"
      },
      "sequence": 66,
      "revisionId": "85220",
      "currentPlanHash": "f45985d5cda9d1835dc8899aaec0762a406393522af4187859657037097639e0",
      "revisionHash": "f45985d5cda9d1835dc8899aaec0762a406393522af4187859657037097639e0",
      "snapshotChars": 118320,
      "snapshotSha256": "8a121d2ad1040fcf980830d011caaac7074cb37f929b7a26c435b630220b4406",
      "bodyEqualsCurrent": true
    },
    "discoveryAudit": 19,
    "activationAudit": 20
  },
  "originalCommand": {
    "proposalPath": "runtime-migration/p006-distinct-e1ff5523-source-only-proposal-0dcd3-20261106.json",
    "commandChars": 2339,
    "commandSha256": "30388636c75d0010b52af5568d6048d889e6e625abf64475fd245a6961cb2954",
    "launch": {
      "ok": true,
      "bash_id": "ae9fcbef-d26",
      "task_id": "0mw4wdbsezuyv8c179u",
      "status": "running",
      "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
      "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-ae9fcbef-d26.log",
      "timeout_ms": 390000,
      "deadline": "2026-11-06T11:41:09.086Z",
      "advice": "Background shell started. Preserve durable task_id \"0mw4wdbsezuyv8c179u\" across carry. Read output: capability:bash_output { task_id: \"0mw4wdbsezuyv8c179u\" } (or { bash_id: \"ae9fcbef-d26\" } in this launching context). Stop: processes:kill { taskId: \"0mw4wdbsezuyv8c179u\" }. It is terminated at 2026-11-06T11:41:09.086Z — re-launch with a larger `timeout` (max 43200000ms) if the shell job needs longer. All descendants in this task's confined service share that deadline; use a dedicated service launcher when a descendant needs a separate lifetime."
    }
  },
  "nativeResult": {
    "ok": true,
    "bash_id": "ae9fcbef-d26",
    "task_id": "0mw4wdbsezuyv8c179u",
    "status": "completed",
    "exit_code": 0,
    "running": false,
    "total_bytes": 9349,
    "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-ae9fcbef-d26.log",
    "cpu_unavailable": "job-not-running",
    "output": "[setup-release] CANDIDATE_SOURCE_INTEGRITY mode=object-sourced object_sourced=39 cloned=39 archive=0 live_tree=0\n[setup-release] SETUP_RELEASE_SOURCE_ONLY ref=e1ff55230c4bfc416a7c1e1fa7382968db8c3f39 sha=e1ff55230c4bfc416a7c1e1fa7382968db8c3f39 status=ready\n 6d7293640b12f8f2859f6ef0700fa30e72563932 apps/slack-asana-bug-drill (6d72936)\n 9b3c74f0b7fb75a8df4dc0ebc58a836b34d5874d libs/agent-chat (heads/main)\n 6d4ff179ca450345c94be88eb7186b68d5e11575 libs/generic/cache (heads/main)\n 40390b8a92c5fa8a5dd4c174c5533766540e29ca libs/generic/card-stack (heads/main)\n a074dc70498f8eaac5b84b8a7c401e0863c26bc5 libs/generic/chat-protocol (heads/main)\n 768071110fd650f271b4ddca5105ff97eb4d6796 libs/generic/control-mutation (heads/main)\n d0bf1b565ba14c5e908a00fdf8bd2f3e0c3051eb libs/generic/debounce-coalesce (heads/main)\n a35f07b72ab11377f5640a1f64f826bde4c329ec libs/generic/desktop-ipc (heads/main)\n c7cb3e4b2411d61d724946668bceb26c68076418 libs/generic/dock-workbench (heads/main)\n 398586d55e341754c67002e856de579e9cd51d35 libs/generic/embedded-pg-discovery (heads/main)\n dc1586c1b2f1195ea4f527f1e431b64b26ac5481 libs/generic/failure-detector (heads/main)\n 2ca138ffcae22876528a67b7207578e741d4c1d6 libs/generic/git-graph (heads/main)\n d587a42c45defd4152a548ae378418b307e2b675 libs/generic/ipc-endpoint-server (heads/main)\n d911f8a07e61a9ae497790c3834c4a6d8054fd54 libs/generic/ipc-framing (heads/main)\n fe9878936d3da86d872fc1a5fdd29877e903d1f0 libs/generic/memory (heads/main)\n ff6a4c544abfc27669cd0bf9badad9cb5ed2a47f libs/generic/model-pricing (heads/main)\n 50c3b455f0ce2159db52aecdefdc07580bfc70a0 libs/generic/papergrid (heads/main)\n bcd3963d3ed0d79e8d3fccb1aa8181da003b5d19 libs/generic/plan-parser (heads/main)\n 0cb518ace905679f1e1a6687968a6b405aa498f1 libs/generic/prospect-contract (heads/main)\n f3bacd6b33a3fd5c91c2badc82b8beb0be970d03 libs/generic/rate-limit (heads/main)\n 3149402b6c0e26516aa9f74b73ed58f5e7f69d1d libs/generic/rerank (heads/main)\n e4c1b5c87e3024aebd62de061e474e9f6a524a9c libs/generic/resumable-download (heads/main)\n 1a5b48715e2ce0ac18b406409b1ce22fc1416ae2 libs/generic/rrf (heads/main)\n 2137d76f3fc32a2f2ebd436ee8ded826269c245f libs/generic/rules (heads/main)\n 4a114841ec3b56deeed794878cc38e4563fdcf4d libs/generic/search (heads/main)\n a5c5ed8c40122fd272ea09d9aa2d3e6ee984db24 libs/generic/search-core (heads/main)\n 4de91e64ab6eb210497826be700b51062126f924 libs/generic/sse (heads/main)\n 0898e212aa8b0acf2e204aed21f4c1d63b710afc libs/generic/sync (heads/main)\n f97996e913b925eb57f4270249eeff007b3847f6 libs/generic/tauri-release-kit (heads/main)\n 209ee35a28f23e75b1d4d6ab498fe78b5e376fe7 libs/generic/token-kit (heads/main)\n 8a03970a4ab1869a59ba3505a0c6f22c590b72db libs/generic/tooldef (8a03970)\n da0e51a1bade6d3fdd99893894166e563d8c91d8 libs/generic/tooldef-http (heads/main)\n a8a3e11fc683f7b927b1bd44fec96ae95ff76536 libs/generic/ui-primitives (heads/main)\n 36af74c05de7d90d44e84fdce6a4444d7e4fbbed libs/papercusp (papercup-pin-03bc03ba-5295-g36af74c0)\n 500c0860e9ad723055f8a0e809e8fa627f352e50 libs/papercusp-db (heads/main)\n 507a29d1e151b09370983f21449270a17cd70119 libs/papercusp-shared (heads/main)\n c3ba3954080af319b94a38597f229d43fda0a299 libs/test-config (c3ba395)\n cfd6651a5bf799267d60128244acc77571170b0a libs/testing-shell (heads/main)\n 39b57b2a2099e164f77b4191a5928e28f62c6c84 papercusp-desktop (desktop-v0.0.7-alpha-2976-g39b57b2a)\napps/operator/bin/release/setup-release-checkout.sh: OK\napps/operator/bin/release/dependency-generation.sh: OK\nBUN_DISTINCT_E1FF5523_SOURCE_ONLY_READY\n"
  },
  "terminalTask": {
    "task_id": "0mw4wdbsezuyv8c179u",
    "workspace_id": "papercusp-workspace",
    "harness_slug": "papercusp",
    "launched_by": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
    "work_item_id": "WI-6554700010022072",
    "scope_unit": "pc-0mw4wdbsezuyv8c179u.service",
    "confined": true,
    "deadline_at": "2026-11-06T11:41:09.192Z",
    "state": "exited",
    "exit_code": 0,
    "exit_reason": null,
    "started_at": "2026-11-06T11:34:39.194Z",
    "ended_at": "2026-11-06T11:39:20.896Z",
    "detail": {
      "goalRef": "WI-6554700010022072",
      "bashJobId": "ae9fcbef-d26",
      "sandboxed": false,
      "budgetPolicy": "deadline-only-v1",
      "workloadClass": "other",
      "dispatchCallId": "zz67tp-1un",
      "verificationAttempt": {
        "label": null,
        "source": null,
        "outcome": "pass",
        "durationMs": 281702,
        "recordedAt": "2026-11-06T11:39:20.900Z",
        "structured": null,
        "fingerprint": null,
        "schemaVersion": 1,
        "evidenceExcerpt": null,
        "commandFingerprint": "8acd7d5ed86e",
        "evidenceExcerptTruncated": false
      },
      "terminalEventPending": false,
      "runnerMarkerNonceHash": "2ac1970d22dc43019af8918bc5b15ad2408623f98fbfa5f417a54fd03b7b9d2e",
      "terminalEventRevision": 1
    }
  },
  "cleanup": {
    "measuredAt": 1793965221.0711796,
    "taskCgroupExists": false,
    "remainingTaskPids": [],
    "cgroupEvents": null,
    "systemd": {
      "exitCode": 0,
      "stdout": "MainPID=0\nResult=success\nExecMainCode=0\nExecMainStatus=0\nControlGroup=\nActiveState=inactive\nSubState=dead\n",
      "stderr": ""
    },
    "log": {
      "bytes": 10541,
      "sha256": "d63de58800065b1dfaa2dd5b3ad5cbbdab7bf4464fc1ff91b991505b69b08ff1",
      "sourceReady": true,
      "finalReady": true,
      "sourceIntegrityLines": [
        "[setup-release] CANDIDATE_SOURCE_INTEGRITY mode=object-sourced object_sourced=39 cloned=39 archive=0 live_tree=0"
      ]
    }
  },
  "taskStatusReadRefusal": {
    "scope": "A follow-up read-only processes:list Python wrapper was denied before dispatch by PreToolUse authority lookup1500ms at9071/requestf86ed1a2-5b7a-4431-a55d-36bf37757724. No source/native command was reattempted. Independent local unit/cgroup inspection and canonical read-only ledger query already established terminal cleanup before original task deadline."
  },
  "verification": {
    "nativeExit0": true,
    "sourceOnlyReady": true,
    "finalReady": true,
    "recursiveSubmoduleStatusExit0": true,
    "inputHashGuardsBeforeAndAfterPassed": true,
    "taskSubtreeEmpty": true,
    "unitInactive": true,
    "checkedBeforeOriginalOuterDeadline": true
  },
  "limits": "D022 has finished and is consumed; never replay/retry/fallback/retarget this source command or probe it after its deadline. D011-D021 remain terminal including D021NO_START and originaltupleholds. This is source preparation only. Node selected/Bun UNSHIPPED. Dependency/native/package/installed/fullmatrix/P004/canary/rollback/final shipment acceptance remains OPEN. No new implementation agent, generation selection/lease/prune, dependency copy/install/build, VM/runtime or LIVE_GATE_OPS occurred."
}

---
rel_path: "evidence/c52-luna-r1-20261106/r4-compact-transport-20261109-v1.json"
updated_at: 1794186670143
_body: "content"
---

{
  "workItem": "EI-27024949538005215",
  "parent": "WI-6554700010045700",
  "scope": "R4 compact transport only; no full assessment, fresh census, promotion, or deployment claim",
  "rootCause": "The result-door numeric-core dispatch branch recognized fleet:leader-brief only; direct and nested work_items:burn_down used generic lossy projection. Full categorization prose could also overflow the compact preview budget.",
  "reuse": "Extended compactLeaderBriefForResultDoor and the existing result-door branch; no new API or count schema.",
  "replay": {
    "sourceBytes": 258825,
    "sourceSha256": "d64270d733895f74413e23ec03c1672946a720115ae3de2d657d112ee4d46767",
    "sourceGeneratedAt": "2026-11-09T00:43:22.991Z",
    "sourceRevision": 24,
    "rows": [
      {
        "route": {
          "toolName": "work_items:burn_down"
        },
        "elapsedMs": 157.36946599999965,
        "bytes": 5950,
        "projection": "work_items:burn_down-numeric-core",
        "preserved": {
          "schemaVersion": true,
          "generatedAt": true,
          "scope": true,
          "quality": true,
          "flow": true,
          "authority": true,
          "issueUnits": true,
          "intakeStages": true,
          "admissionParity": true,
          "remainingCounts": true
        },
        "fullUtf8Recovery": true,
        "spillPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/scratch/papercusp-workspace/work_items:burn_down/11111111-2222-4333-8444-555555555555/result-door-1794186548147.md",
        "cursor": {
          "kind": "scratch-page",
          "tool": "capability:read",
          "args": {
            "file_path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/scratch/papercusp-workspace/work_items:burn_down/11111111-2222-4333-8444-555555555555/result-door-1794186548147.md",
            "byte_offset": 0,
            "byte_limit": 3072
          },
          "maxByteLimit": 4096,
          "uri": "papercusp://scratch/papercusp-workspace/work_items:burn_down/11111111-2222-4333-8444-555555555555/result-door-1794186548147.md",
          "dataEncoding": "base64",
          "bodyOffsetInPayload": 957,
          "bodyOffsetInFile": 1684
        },
        "ok": true
      },
      {
        "route": {
          "toolName": "tools:invoke",
          "nestedTargetToolName": "work_items:burn_down"
        },
        "elapsedMs": 170.4025389999997,
        "bytes": 5934,
        "projection": "work_items:burn_down-numeric-core",
        "preserved": {
          "schemaVersion": true,
          "generatedAt": true,
          "scope": true,
          "quality": true,
          "flow": true,
          "authority": true,
          "issueUnits": true,
          "intakeStages": true,
          "admissionParity": true,
          "remainingCounts": true
        },
        "fullUtf8Recovery": true,
        "spillPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/scratch/papercusp-workspace/tools:invoke/11111111-2222-4333-8444-555555555555/result-door-1794186548214.md",
        "cursor": {
          "kind": "scratch-page",
          "tool": "capability:read",
          "args": {
            "file_path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/scratch/papercusp-workspace/tools:invoke/11111111-2222-4333-8444-555555555555/result-door-1794186548214.md",
            "byte_offset": 0,
            "byte_limit": 3072
          },
          "maxByteLimit": 4096,
          "uri": "papercusp://scratch/papercusp-workspace/tools:invoke/11111111-2222-4333-8444-555555555555/result-door-1794186548214.md",
          "dataEncoding": "base64",
          "bodyOffsetInPayload": 949,
          "bodyOffsetInFile": 1676
        },
        "ok": true
      }
    ]
  },
  "tests": {
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/agent-tools/fleet/fleet-metrics-contract.test.ts packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.test.ts",
    "result": "76 passed, 0 failed, 0 skipped; terminal exit 0",
    "ledgerIds": [
      23696309,
      23696308
    ],
    "logPath": "/tmp/c52-compact-final-tests.log",
    "logSha256": "f5b5ea954de24a5c1cd38a4154640ad47fdf341715745295e41d6a616273a1bf",
    "summaryLines": [
      "TEST_FILE_PROVENANCE head=729986dd35 testedPaths=2 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-09T01:08:42.715Z",
      " Test Files  2 passed (2)",
      "      Tests  76 passed (76)",
      "   Duration  41.95s (transform 58.92s, setup 1.09s, import 79.67s, tests 1.31s, environment 0ms)",
      "TEST_FILE_PROVENANCE head=729986dd35 testedPaths=2 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-09T01:09:35.179Z",
      "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=729986dd35 uncommittedPaths=1/2 provenance=stamped startedAt=2026-11-09T01:08:42.715Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=2328345 skippedTests=0"
    ],
    "redEvidence": {
      "routeRedLog": "/tmp/c52-compact-red.log",
      "routeResult": "2 failures / 24 passes / terminal 1 before production edit",
      "categoryRedLog": "/tmp/c52-compact-budget-red.log",
      "categoryResult": "2 failures / 26 passes / terminal 1 after routing fix, before explanation compaction"
    }
  },
  "sourceFiles": {
    "packages/operator-core/lib/result-door.ts": "4940e6e0082e1d4d8e42dc8bca86dc049f8a768a6cee6182b60622fdb97b7b27",
    "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts": "14c756716a946984f77ada8956345755a096e95564384f5c56117b77a66767c1",
    "packages/operator-core/lib/agent-tools/fleet/fleet-metrics-contract.test.ts": "ab3ac897fd4db3ab8c1e91ff1c8257d532dc4ce12fb153b4228c6e4865cf3e6d"
  },
  "headAtCapture": "729986dd35171f1e0cb11bd1505295917f2d946f",
  "limitations": [
    "Replay uses the retained 2026-11-09T00:43:22.991Z revision-24 census; it is not a new population measurement.",
    "Replay elapsedMs measures the transport function only, not end-to-end burn-down API latency.",
    "Focused local tests cover edited working-tree imports; deployed runtime containment has not been asserted.",
    "Original R1-R8/all26, WI-6554700010045744, and D025-off constraints remain open."
  ]
}

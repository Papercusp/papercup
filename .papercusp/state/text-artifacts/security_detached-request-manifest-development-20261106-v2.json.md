---
rel_path: "security/detached-request-manifest-development-20261106-v2.json"
updated_at: 1793953606313
_body: "content"
---

{
  "schema": "detached-request-manifest-development-v2",
  "workItem": "EI-28022013442930187",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "rootCauseEvidence": {
    "originalSnapshot": "/tmp/security-p001-reaction-corrected-status-20261106.json",
    "missing": "snapshot.requestedFiles",
    "receivingBuild": "d740fc3802",
    "receivingBuilder": "git show d740fc3802:packages/operator-core/lib/agent-tools/testing/run.ts has no requestedFiles request fields",
    "currentBuilderSha256": "edc87ccf07f5b800836fe1ed74a045341844de998e5c7abed1e4d699551e4d2b",
    "runtimeContainment": {
      "measuredVia": "dev:pipeline_position path testing/run.ts testClass operator-api on :3170",
      "stagingBuild": "86a76bfc35",
      "stagingContainsChange": true,
      "releaseBuild": "d740fc3802",
      "releaseContainsChange": false
    }
  },
  "change": {
    "path": "packages/operator-core/lib/agent-tools/testing/run-selectors.test.ts",
    "sha256": "9b1cc15c162b6349fe4b0a056ec8a2705cdc6c5ce88b0a130c3a5c1329cd5141",
    "case": "retains exact ledger file identities in every detached request before the runner starts",
    "scope": "Exact normalized requested-file manifests and copy stability across ordinary/focused/mixed-root request builders; extends existing testing surface."
  },
  "verification": {
    "types": {
      "exitCode": 0,
      "nativeSession": 36238,
      "drained": true,
      "log": "/tmp/security-detached-request-manifest-types-20261106.log",
      "scope": "one named test file"
    },
    "test": {
      "origin": "876022e1-bb62-40ce-97e0-4ee4c8dcbdcf",
      "detached": "be9d2bdb-1bd3-4fdd-826f-feda0b45bba4",
      "taskId": "0mw4ns4401t7o09lizn",
      "lastStatus": "pass",
      "exitCode": 0,
      "finishedAt": 1793950558144,
      "requestedFiles": [
        "packages/operator-core/lib/agent-tools/testing/run-selectors.test.ts"
      ],
      "reported": {
        "passed": 1,
        "failed": 0,
        "filtered": 39
      },
      "overall": "terminal detached wrapper PASS with exact requested-file ledger",
      "ledger": {
        "id": 23459151,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 0,
          "passed": 1,
          "skipped": 39,
          "filePath": "packages/operator-core/lib/agent-tools/testing/run-selectors.test.ts",
          "commitSha": "5890b27671cbef0dac9ff212ee220ca1a529c131",
          "testLayer": "unit",
          "runGroupId": "be9d2bdb-1bd3-4fdd-826f-feda0b45bba4",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-11-06T07:34:29.371Z",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": "retains exact ledger file identities",
          "collectionFailed": false,
          "passedCaseTitles": [
            "testing:run selector arbitration > retains exact ledger file identities in every detached request before the runner starts"
          ],
          "worktreeDirtyReason": "HEAD moved 8d7f05438878 -> 5890b27671cb",
          "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/testing/run-selectors.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-11-06T07:35:26.011Z",
        "finishedAt": "2026-11-06T07:35:26.030Z",
        "durationMs": 19,
        "commitSha": "5890b27671cbef0dac9ff212ee220ca1a529c131",
        "runGroupId": "be9d2bdb-1bd3-4fdd-826f-feda0b45bba4",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 1067.5,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false
      },
      "priorResponse": "/tmp/security-detached-request-manifest-regression-20261106.json",
      "priorPendingStatusFile": "/tmp/security-detached-request-manifest-status-20261106.json"
    }
  },
  "limitations": [
    "Current-build development regression only; historical source pins retained.",
    "39 tests were filtered.",
    "Old corrected-reaction wrapper error/exit0 remains separate from its ledger proof.",
    "No SEC, confinement, installed or shipment acceptance.",
    "All seven population closures remain UNKNOWN; signed Mac and independent review holds remain."
  ],
  "supersedes": "security/detached-request-manifest-development-20261106-v1.json",
  "canonicalGateRepair": {
    "planVersion": 39,
    "contentHash": "abb755f9a364c528a289f5e1631dae16a869fd792f355a5d1ba4ba2176b13e86",
    "discoveryAudit": 12,
    "activationAudit": 13,
    "parentRepair": "/tmp/security-parent-repair-result-20261106.json",
    "startReceipt": "/tmp/security-start-parent-repair-execution-20261106.json"
  }
}


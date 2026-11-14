---
rel_path: "portability/census/v59-v62/31-p053-v60-verification.json.part-000"
updated_at: 1794254851488
_body: "content"
---

{
  "sourcePins": {
    "packages/operator-core/lib/backup/state-census-producers.ts": "2dc696d1ffb3b7f45697321d0a9a14d9d827fc51f4930ab260b28cd75bd72370",
    "packages/operator-core/lib/backup/state-census-producers.test.ts": "2ed1eb1a8bde72dc6a31d3e365bc0ffa01ae17bc2fe59f809db25c6d9c575638",
    "scripts/state-census-roots.mts": "e0f8c4c3487269c4169b57dc43abf4abe802733003356fd41a17c917e75a36f0",
    "packages/operator-core/lib/backup/state-census-cli.test.ts": "354be1a6920a6aac3b85ae3d3a1c3c1442dded7945a2f35c5a3d8aba8ce748d9",
    "packages/operator-core/lib/admin-commands.ts": "5252c8ffa09caefb24a757281d6887998c84660002370cea8854bd660fa71544",
    "packages/operator-core/lib/admin-commands.test.ts": "9fb8fd99e2c6b5f2c49446d42d356245bb4d0a46375c7d6ebd6d12db6e90adbe"
  },
  "sourceUnchanged": true,
  "wholeInstallVerified": false,
  "correctedProducerRecovery": {
    "ok": true,
    "mode": "evidence-recovery",
    "evidenceBundle": {
      "status": "recorded",
      "verificationFingerprint": "888f51962b93c449ebc2dc32453df02efcfcc9b10b6cf9717dc7cbd0d694544f",
      "acceptance": "requires-review",
      "rows": [
        {
          "specId": "PPC-P-053-1",
          "specRevision": 2,
          "evidenceRef": "test-run-group:bdf7239f-6f42-4742-b760-eed0683a7b16:0",
          "testRunId": 23776207,
          "ledgerRunGroupId": "27276a14-2a6e-4d67-be31-507956a71d90",
          "phase": "settled",
          "outcome": "pass",
          "bindingStatus": "created"
        }
      ],
      "total": 1,
      "omitted": 0,
      "readRef": {
        "tool": "plans:get-spec-evidence",
        "args": {
          "harness": "papercusp",
          "slug": "portable-papercusp-container-and-native-2026-10-06",
          "workItemIds": [
            "WI-10007347"
          ],
          "evidenceRefs": [
            "test-run-group:bdf7239f-6f42-4742-b760-eed0683a7b16:0"
          ]
        }
      },
      "pendingRetirement": {
        "status": "complete",
        "retiredCount": 1,
        "bindingIds": [
          79686
        ],
        "omitted": 0,
        "failures": [],
        "failuresOmitted": 0
      },
      "detachedRunStatus": {
        "runId": "27276a14-2a6e-4d67-be31-507956a71d90",
        "status": "pass",
        "exitCode": 0,
        "finishedAt": 1794253187117
      },
      "recovery": {
        "tool": "testing:run",
        "args": {
          "harness": "papercusp",
          "recoverEvidence": {
            "workItemId": "WI-10007347",
            "planSlug": "portable-papercusp-container-and-native-2026-10-06",
            "originRunId": "bdf7239f-6f42-4742-b760-eed0683a7b16",
            "runId": "27276a14-2a6e-4d67-be31-507956a71d90"
          }
        }
      },
      "recoveryWait": {
        "limitMs": 30000,
        "waitedMs": 35,
        "ledgerWaitedMs": 24,
        "outcome": "terminal"
      }
    }
  },
  "priorAdminAndCliLedgers": [
    {
      "id": 23776188,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": "papercusp",
      "root": "/home/marsh-office/papercupai-workspace/papercusp",
      "executionDetails": {
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "failed": 0,
        "passed": 18,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/backup/state-census-cli.test.ts",
        "commitSha": "b28a830ccedbc9912cb074d2fd44e69111fb5c18",
        "testLayer": "unit",
        "runGroupId": "58056ba8-e1f3-4c26-92ed-388a8fb71f58",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-09T19:35:36.255Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": true,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "unit census executable exit contract > recovers GCed reaper identities from canonical terminal latches and leaves unproven tails as residue",
          "unit census executable exit contract > bounds reaper identity reads, skips needless latches and propagates unavailable evidence",
          "unit census executable exit contract > recovers pre-latch archives only from exact canonical reaper outcomes in registered workspaces",
          "unit census executable exit contract > retains exact legacy task and message identities when default is absent from the registry",
          "unit census executable exit contract > retains completed writer inputs when credential discovery fails",
          "unit census executable exit contract > composes installed environment secrets before credential discovery without needing a database catalogue",
          "unit census executable exit contract > retains independent producer inputs before a later filesystem discovery failure",
          "unit census executable exit contract > merges receipt-backed Stripe declarations while preserving an unproven sibling as residue",
          "unit census executable exit contract > retains inactive workspace runtime state without owning copied foreign files or unregistered homes",
          "unit census executable exit contract > includes the legacy default writer home without registering arbitrary sibling homes",
          "unit census executable exit contract > does not follow a linked legacy default writer home or invent an absent one",
          "unit census executable exit contract > preserves the legacy host runtime home while leaving unrelated files and linked fallbacks unclassified",
          "unit census executable exit contract > keeps environment preferences in registered workspaces without claiming host logs or lookalikes",
          "unit census executable exit contract > retains credential references from inactive workspace pools and fails on an unreadable pool",
          "unit census executable exit contract > limits schema reads to exact source tables and preserves the overflow guard",
          "unit census executable exit contract > root diagnostic explicitly reports partial scope and fails unknown filesystem ownership",
          "unit census executable exit contract > includes receipt-backed reaper tails in the root census and leaves unproven tails as residue",
          "unit census executable exit contract > returns drift exit1 for an unknown installed unit"
        ],
        "worktreeDirtyReason": "98 porcelain line(s) before the run: M apps/operator/bin/hono-host.ts |  M apps/operator/bin/llm-test.ts |  M apps/operator/bin/release/dependency-generation.sh |  M apps/operator/lib/mcp-proxy/proxy.test.ts |  M apps/operator/lib/mcp-proxy/proxy.ts",
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/backup/state-census-cli.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-11-09T19:35:43.574Z",
      "finishedAt": "2026-11-09T19:35:53.250Z",
      "durationMs": 9676,
      "commitSha": "b28a830ccedbc9912cb074d2fd44e69111fb5c18",
      "runGroupId": "58056ba8-e1f3-4c26-92ed-388a8fb71f58",
      "source": "local",
      "branch": "staging",
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 228.6,
      "saturationSuspect": null,
      "worktreeDirty": true,
      "isScratchConfig": false
    },
    {
      "id": 23776187,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": "papercusp",
      "root": "/home/marsh-office/papercupai-workspace/papercusp",
      "executionDetails": {
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "failed": 0,
        "passed": 6,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/admin-commands.test.ts",
        "commitSha": "b28a830ccedbc9912cb074d2fd44e69111fb5c18",
        "testLayer": "unit",
        "runGroupId": "58056ba8-e1f3-4c26-92ed-388a8fb71f58",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-09T19:35:36.255Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": true,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "admin-commands registry > listCommands returns a non-empty set, each with an id + command",
          "admin-commands registry > getCommand resolves a known id",
          "admin-commands registry > getCommand returns null for an unknown id",
          "admin-commands registry > command ids are unique",
          "admin-commands registry > loads VM config from the command runtime HOME rather than the workspace home",
          "admin-commands registry > EI-18666147162251862: start-mac-vm no longer self-matches via a bare `pgrep -f`"
        ],
        "worktreeDirtyReason": "98 porcelain line(s) before the run: M apps/operator/bin/hono-host.ts |  M apps/operator/bin/llm-test.ts |  M apps/operator/bin/release/dependency-generation.sh |  M apps/operator/lib/mcp-proxy/proxy.test.ts |  M apps/operator/lib/mcp-proxy/proxy.ts",
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/admin-commands.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-11-09T19:35:40.493Z",
      "finishedAt": "2026-11-09T19:35:40.518Z",
      "durationMs": 25,
      "commitSha": "b28a830ccedbc9912cb074d2fd44e69111fb5c18",
      "runGroupId": "58056ba8-e1f3-4c26-92ed-388a8fb71f58",
      "source": "local",
      "branch": "staging",
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 228.6,
      "saturationSuspect": null,
      "worktreeDirty": true,
      "isScratchConfig": false
    }
  ],
  "hostProbe": {
    "declarations": [
      {
        "kind": "path",
        "root": "hosted-config-1",
        "name": "build-vms.env",
        "classification": "secret",
        "producer": "admin-build-vm-config"
      }
    ],
    "roots": [
      {
        "id": "hosted-config-1",
        "path": "/home/marsh-office/.papercusp"
      }
    ],
    "before": {
      "dev": 66307,
      "ino": 18143465,
      "mode": 33152,
      "size": 422,
      "mtimeMs": 1783900945499.418,
      "ctimeMs": 1783900945501.418,
      "regular": true,
      "link": false
    },
    "after": {
      "dev": 66307,
      "ino": 18143465,
      "mode": 33152,
      "size": 422,
      "mtimeMs": 1783900945499.418,
      "ctimeMs": 1783900945501.418,
      "regular": true,
      "link": false
    },
    "metadataUnchanged": true,
    "scope": "exact VM config path; no credential content read",
    "wholeInstallVerified": false
  },
  "typecheck": "v59 all4files exit0; v60 corrected test exit0",
  "lint": "v59 all4files exit0,9warnings; v60 corrected test exit0,3warnings"
}


---
rel_path: "portability/census/endpoint-desktop-v9-p053-v9-corrected-source-and-test-proof-ff22409589b57d14.json"
updated_at: 1794221067893
_body: "content"
---

{
  "sourceSha256": {
    "packages/operator-core/lib/backup/state-census-producers.ts": "a244439ba7a9b864fdbb8575f733737d818625eea396d51b68db5418a33bd336",
    "packages/operator-core/lib/backup/state-census-producers.test.ts": "0ba1da083092eac026bac757a3cff4a3f5f2ec7f295783b98667d077f3930b5c",
    "packages/operator-core/lib/backup/state-census-cli.test.ts": "fbd682e8d979fc5b609a3c9cf83d0d5a946244c26c170218b2144e8c40d92230"
  },
  "backgroundRequest": {
    "ok": true,
    "mode": "background",
    "status": "pending",
    "runId": "50ef687d-7987-43e6-bf0e-7d4b8d6c5c16",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "rootSource": "registered-harness",
    "deadline": {
      "startedAtMs": 1794220710558,
      "taskDeadlineAtMs": 1794221010558,
      "cleanupReserveMs": 30000,
      "childCutoffAtMs": 1794220980558
    },
    "detachedRunId": "7c881ded-5bbb-4086-a4d1-536a0ef04c06",
    "detachedDurable": true,
    "taskId": "0mw94oq21176898q1dc",
    "statusRef": {
      "tool": "testing:run-status",
      "args": {
        "runId": "7c881ded-5bbb-4086-a4d1-536a0ef04c06"
      }
    },
    "message": "One background run was accepted. No test verdict is available yet; poll the returned handle before requesting another run.",
    "phaseTimingsMs": {
      "preflightMs": 1.84,
      "provenanceMs": 22.17,
      "preparationMs": 5.69,
      "admissionGateMs": 5.67,
      "handoffMs": 1915.74,
      "admissionWaitMs": null,
      "routerExecutionMs": null,
      "ledgerIdReadbackMs": null,
      "finalizationMs": null,
      "totalHandlerMs": 1949.04
    }
  },
  "firstRunTerminal": "/tmp/p053-v9-test-terminal2.json",
  "rootRegistrationFix": "Register additional runtime roots only after a proven writer file. Existing hostile-neighbor regression exposed eager directory-only registration."
}


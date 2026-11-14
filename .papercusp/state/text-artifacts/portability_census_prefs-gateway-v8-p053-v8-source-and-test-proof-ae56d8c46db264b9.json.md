---
rel_path: "portability/census/prefs-gateway-v8-p053-v8-source-and-test-proof-ae56d8c46db264b9.json"
updated_at: 1794219656678
_body: "content"
---

{
  "sourceSha256": {
    "packages/operator-core/lib/backup/state-census-producers.ts": "ea3692d40b3158efdf3591721fd0ad63decdd990978d5851110ec68b8ea4ac44",
    "packages/operator-core/lib/backup/state-census-producers.test.ts": "92740548ad34224c546c0f8c0dbd912f9ef872b685cb710e1de5b0f9d61bbbe0",
    "packages/operator-core/lib/backup/state-census-cli.test.ts": "fbd682e8d979fc5b609a3c9cf83d0d5a946244c26c170218b2144e8c40d92230"
  },
  "backgroundRequest": {
    "ok": true,
    "mode": "background",
    "status": "pending",
    "runId": "13329ac1-7b4a-443a-ba02-c36bcc5c07d4",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "rootSource": "registered-harness",
    "deadline": {
      "startedAtMs": 1794219277940,
      "taskDeadlineAtMs": 1794219577940,
      "cleanupReserveMs": 30000,
      "childCutoffAtMs": 1794219547940
    },
    "detachedRunId": "310bb53f-225f-41aa-8d42-55ce629cd1bf",
    "detachedDurable": true,
    "taskId": "0mw93u0j718r7wfb1va",
    "statusRef": {
      "tool": "testing:run-status",
      "args": {
        "runId": "310bb53f-225f-41aa-8d42-55ce629cd1bf"
      }
    },
    "message": "One background run was accepted. No test verdict is available yet; poll the returned handle before requesting another run.",
    "phaseTimingsMs": {
      "preflightMs": 1.44,
      "provenanceMs": 22.63,
      "preparationMs": 12.65,
      "admissionGateMs": 12.64,
      "handoffMs": 1762.39,
      "admissionWaitMs": null,
      "routerExecutionMs": null,
      "ledgerIdReadbackMs": null,
      "finalizationMs": null,
      "totalHandlerMs": 1801.38
    }
  },
  "observedStatus": {
    "runId": "310bb53f-225f-41aa-8d42-55ce629cd1bf",
    "kind": "vitest",
    "label": "testing:run background (packages/operator-core/lib/backup/state-census-producers.test.ts, packages/operator-core/lib/backup/state-census-cli.test.ts)",
    "requestedFiles": [
      "packages/operator-core/lib/backup/state-census-producers.test.ts",
      "packages/operator-core/lib/backup/state-census-cli.test.ts"
    ],
    "command": [
      "/home/marsh-office/.local/node25/bin/node",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const replay = {\"root\":\"/home/marsh-office/papercupai-workspace/papercusp\",\"files\":[\"packages/operator-core/lib/backup/state-census-producers.test.ts\",\"packages/operator-core/lib/backup/state-census-cli.test.ts\"],\"deadline\":{\"startedAtMs\":1794219277940,\"taskDeadlineAtMs\":1794219577940,\"cleanupReserveMs\":30000,\"childCutoffAtMs\":1794219547940},\"timeoutMs\":300000,\"taskDeadlineAtMs\":1794219577940,\"cleanupReserveMs\":30000,\"allowDetachedRecovery\":false,\"workspaceId\":\"papercusp-workspace\",\"harnessSlug\":\"papercusp\",\"workItemId\":\"WI-10007347\",\"allowSiblingCheckoutFallback\":false};\nconst bootstrapStartedAtMs = Date.now();\nconst trace = (phase, detail = {}) => {\n  const atMs = Date.now();\n  process.stderr.write(JSON.stringify({ schemaVersion: \"testing-run-bootstrap-v1\", phase,\n    runId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null, atMs,\n    elapsedMs: atMs - bootstrapStartedAtMs, sinceRequestMs: atMs - replay.deadline.startedAtMs,\n    taskDeadlineAtMs: replay.deadline.taskDeadlineAtMs, childCutoffAtMs: replay.deadline.childCutoffAtMs,\n    cleanupReserveMs: replay.deadline.cleanupReserveMs,\n    remainingChildMs: Math.max(0, replay.deadline.childCutoffAtMs - atMs), ...detail }) + \"\\n\");\n};\ntrace(\"bootstrap-start\");\nlet failedPhase = \"core-import\";\ntry {\n  trace(\"core-import-start\");\n  const { runTestFilesCore } = await import(\"file:///home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-a5240523111a.JfZ9lh/checkout/packages/operator-core/lib/agent-tools/testing/run.ts\");\n  trace(\"core-import-complete\");\n  failedPhase = \"core-execution\";\n  trace(\"core-execution-start\");\n  const result = await runTestFilesCore({ ...replay, runId: process.env.PAPERCUSP_TEST_RUN_GROUP }, { reportDirectories: {\"/home/marsh-office/papercupai-workspace/papercusp\":\"/tmp/pcv/testing-run-replay-zc9P7z\"} });\n  trace(\"core-execution-complete\", { ok: result.ok, error: result.error ?? null });\n  console.log(JSON.stringify(result));\n  process.exitCode = result.ok ? 0 : 1;\n} catch (error) {\n  trace(\"bootstrap-error\", { failedPhase, errorName: error instanceof Error ? error.name : \"unknown\" });\n  throw error;\n}"
    ],
    "status": "running",
    "exitCode": null,
    "startedAt": 1794219279666,
    "finishedAt": null,
    "output": "[detached-report] Vitest reported pass across 2 requested file(s) (91 passed, 0 failed, 0 skipped); the task manager still reports the process as running, so the overall run remains nonterminal.",
    "truncated": false,
    "taskId": "0mw93u0j718r7wfb1va",
    "provisionalVerdict": {
      "status": "pass",
      "fileCount": 2,
      "finishedAt": 1794219322446,
      "passed": 91,
      "failed": 0,
      "skipped": 0
    }
  },
  "priorCheckpoint": "/tmp/p053-v7-final-checkpoint-payload.json"
}


---
rel_path: "portability/census/v59-v62/58-p053-v62-scaling-result.json.part-000"
updated_at: 1794254873437
_body: "content"
---

{
  "ok": true,
  "summary": {
    "ok": true,
    "bash_id": "9a787448-4ff",
    "task_id": "0mw9ornphdsqj3a1n6k",
    "status": "completed",
    "running": false,
    "yielded": false,
    "exit_code": 0,
    "duration_ms": 2020,
    "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
    "output": "{\"sourcePin\":\"738a90b7c540fbb87e5c13ac28fd3305c25beaf0ca3b618f900f7ac62e9b73cf\",\"samples\":[{\"requested\":64,\"results\":[{\"condition\":\"all-declarations\",\"entries\":64,\"declarations\":77748,\"pairChecks\":4975872,\"wallMs\":153.21880599999997,\"cpuMs\":223.136,\"resultSha256\":\"7e0bb53e2cf14ffc90837de8b9cd22318f5d6f81016cadd1c49e3eb236fe41a2\"},{\"condition\":\"same-kind-declarations\",\"entries\":64,\"declarations\":1481,\"pairChecks\":94784,\"wallMs\":1.6913460000000669,\"cpuMs\":1.69,\"resultSha256\":\"7e0bb53e2cf14ffc90837de8b9cd22318f5d6f81016cadd1c49e3eb236fe41a2\"}],\"sameResult\":true},{\"requested\":256,\"results\":[{\"condition\":\"all-declarations\",\"entries\":256,\"declarations\":77748,\"pairChecks\":19903488,\"wallMs\":205.34110399999997,\"cpuMs\":224.094,\"resultSha256\":\"2d74e703380f6b6eca7d0ffc59ccc639daafe91539c710ef0b4dab2e161e7d1f\"},{\"condition\":\"same-kind-declarations\",\"entries\":256,\"declarations\":1481,\"pairChecks\":379136,\"wallMs\":9.760066000000052,\"cpuMs\":9.721,\"resultSha256\":\"2d74e703380f6b6eca7d0ffc59ccc639daafe91539c710ef0b4dab2e161e7d1f\"}],\"sameResult\":true},{\"requested\":1024,\"results\":[{\"condition\":\"all-declarations\",\"entries\":1024,\"declarations\":77748,\"pairChecks\":79613952,\"wallMs\":635.932216,\"cpuMs\":635.865,\"resultSha256\":\"d3a9ec87508989836acee56eaecb8da38b69c637c5e0937bbc1d087c96986df6\"},{\"condition\":\"same-kind-declarations\",\"entries\":1024,\"declarations\":1481,\"pairChecks\":1516544,\"wallMs\":19.390022000000044,\"cpuMs\":19.349,\"resultSha256\":\"d3a9ec87508989836acee56eaecb8da38b69c637c5e0937bbc1d087c96986df6\"}],\"sameResult\":true}]}\n",
    "truncated": false,
    "total_bytes": 1526,
    "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-9a787448-4ff.log",
    "response_window_ms": 45000,
    "timeout_ms": 45000,
    "deadline": "2026-11-09T20:01:26.669Z",
    "_meta": {
      "shellExecution": {
        "version": 1,
        "bash_id": "9a787448-4ff",
        "task_id": "0mw9ornphdsqj3a1n6k",
        "status": "completed",
        "exit_code": 0,
        "running": false,
        "yielded": false
      },
      "explicitFullRequest": true,
      "_seeAlso": [
        {
          "tool": "capability:bash_output (read a backgrounded run)"
        },
        {
          "tool": "capability:git (git actions, gated as git)"
        },
        {
          "tool": "logs:read { unit, since, grep, limit } (service logs; filters inside journalctl)"
        }
      ]
    }
  },
  "logs": [],
  "dryRun": false,
  "dispatchCount": 1,
  "dispatchTimings": {
    "calls": [
      {
        "ordinal": 0,
        "tool": "capability:bash",
        "effect": "write",
        "elapsedMs": 2466,
        "disposition": "settled",
        "callId": "tij1r2-bae"
      }
    ],
    "totalCount": 1,
    "omittedCount": 0,
    "maxCalls": 24
  },
  "intermediateBytes": 2519,
  "runtimeObservations": {
    "authorizationObservationCount": 1,
    "authorityWideningDetected": false,
    "midTurnPromptInjectionObservability": "not-observable"
  },
  "childFailures": [],
  "partial": false,
  "mutations": {
    "count": 1,
    "byTool": {
      "capability:bash": 1
    },
    "attemptedCount": 1,
    "settledPrefixCount": 1,
    "dispositions": {
      "settled": [
        0
      ]
    },
    "note": "count includes only write calls that settled successfully before code:run returned; disposition indexes are zero-based dispatch order and in_flight calls require verification before retry"
  }
}


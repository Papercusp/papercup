---
rel_path: "evidence/c52-luna-r1-20261106/owner444-decoded-timing-sample-20261108T2209Z.json"
updated_at: 1794175531431
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner444-decoded-timing-sample-v1",
  "source": {
    "artifact": "evidence/c52-luna-r1-20261106/owner444-historical-toolparts-20261108T2206Z.json",
    "session": "01a1b179-a684-7d33-9096-fd052373187e",
    "part": 77,
    "ts": "2026-11-06 15:49:39.853+00",
    "indexedTextChars": 2023
  },
  "innerResult": {
    "ok": true,
    "summary": {
      "ok": true,
      "bash_id": "06f637d3-394",
      "task_id": "0mw55h5361c3fmpn47r",
      "status": "completed",
      "running": false,
      "yielded": false,
      "exit_code": 0,
      "duration_ms": 4557,
      "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
      "output": "{\"budgetMs\":3000,\"forkStartMs\":5,\"forkReturnMs\":17,\"spawnEventMs\":17,\"sendCallbackMs\":17,\"progress\":[{\"phase\":\"job-received\",\"parentElapsedMs\":874,\"workerElapsedMs\":0},{\"phase\":\"typescript-load\",\"parentElapsedMs\":874,\"workerElapsedMs\":1},{\"phase\":\"compiler-query\",\"parentElapsedMs\":1348,\"workerElapsedMs\":475}],\"outcome\":{\"timedOut\":false,\"answerAtMs\":2004},\"workerResult\":{\"error\":null,\"backend\":\"typescript-service\",\"siteCount\":3},\"spawnError\":null,\"exit\":{\"code\":null,\"signal\":\"SIGKILL\",\"exitMs\":2281}}\n",
      "truncated": false,
      "total_bytes": 506,
      "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-06f637d3-394.log",
      "response_window_ms": 45000,
      "timeout_ms": 15000,
      "deadline": "2026-11-06T15:49:48.617Z"
    },
    "logs": [],
    "dryRun": false,
    "dispatchCount": 1,
    "intermediateBytes": 1019,
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
  },
  "sample": {
    "budgetMs": 3000,
    "forkStartMs": 5,
    "forkReturnMs": 17,
    "spawnEventMs": 17,
    "sendCallbackMs": 17,
    "progress": [
      {
        "phase": "job-received",
        "parentElapsedMs": 874,
        "workerElapsedMs": 0
      },
      {
        "phase": "typescript-load",
        "parentElapsedMs": 874,
        "workerElapsedMs": 1
      },
      {
        "phase": "compiler-query",
        "parentElapsedMs": 1348,
        "workerElapsedMs": 475
      }
    ],
    "outcome": {
      "timedOut": false,
      "answerAtMs": 2004
    },
    "workerResult": {
      "error": null,
      "backend": "typescript-service",
      "siteCount": 3
    },
    "spawnError": null,
    "exit": {
      "code": null,
      "signal": "SIGKILL",
      "exitMs": 2281
    }
  },
  "limits": [
    "One later same-fixture sample does not establish the caca118b8e historical failing-run phase or cause.",
    "Retained indexed outer tool body is clipped; decoded result and sample are qualified separately."
  ]
}

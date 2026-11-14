---
rel_path: "evidence/c52-luna-r1-20261106/owner444-completed-output-archive-20261108T2211Z.json"
updated_at: 1794175604920
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner444-completed-output-archive-v1",
  "output": {
    "ok": true,
    "bash_id": "06f637d3-394",
    "task_id": "0mw55h5361c3fmpn47r",
    "status": "completed",
    "exit_code": 0,
    "running": false,
    "total_bytes": 1155,
    "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-06f637d3-394.log",
    "recovered_from_ledger": true,
    "output_tail": "{\"budgetMs\":3000,\"forkStartMs\":5,\"forkReturnMs\":17,\"spawnEventMs\":17,\"sendCallbackMs\":17,\"progress\":[{\"phase\":\"job-received\",\"parentElapsedMs\":874,\"workerElapsedMs\":0},{\"phase\":\"typescript-load\",\"parentElapsedMs\":874,\"workerElapsedMs\":1},{\"phase\":\"compiler-query\",\"parentElapsedMs\":1348,\"workerElapsedMs\":475}],\"outcome\":{\"timedOut\":false,\"answerAtMs\":2004},\"workerResult\":{\"error\":null,\"backend\":\"typescript-service\",\"siteCount\":3},\"spawnError\":null,\"exit\":{\"code\":null,\"signal\":\"SIGKILL\",\"exitMs\":2281}}\n\n[capability:bash] JOB END: status=completed exit=0 at 2026-11-06T15:49:38.142Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.\n\n[capability:bash] JOB END: status=completed exit=0 at 2026-11-06T15:49:38.173Z — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has been durably recorded yet: the job may still be running, or it may have died before its close handler wrote JOB END. Check capability:bash_output/task ledger; recovery writes JOB DIED after a ledger-confirmed unobserved death.\n",
    "output": "{\"budgetMs\":3000,\"forkStartMs\":5,\"forkReturnMs\":17,\"spawnEventMs\":17,\"sendCallbackMs\":17,\"progress\":[{\"phase\":\"job-received\",\"parentElapsedMs\":874,\"workerElapsedMs\":0},{\"phase\":\"typescript-load\",\"parentElapsedMs\":874,\"workerElapsedMs\":1},{\"phase\":\"compiler-query\",\"parentElapsedMs\":1348,\"workerElapsedMs\":475}],\"outcome\":{\"timedOut\":false,\"answerAtMs\":2004},\"workerResult\":{\"error\":null,\"backend\":\"typescript-service\",\"siteCount\":3},\"spawnError\":null,\"exit\":{\"code\":null,\"signal\":\"SIGKILL\",\"exitMs\":2281}}\n\n[capability:bash] JOB END: status=completed exit=0 at 2026-11-06T15:49:38.142Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.\n\n[capability:bash] JOB END: status=completed exit=0 at 2026-11-06T15:49:38.173Z — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has been durably recorded yet: the job may still be running, or it may have died before its close handler wrote JOB END. Check capability:bash_output/task ledger; recovery writes JOB DIED after a ledger-confirmed unobserved death.\n"
  },
  "sql": "SELECT a.workspace_id,a.source_kind,a.session_id,a.owner,a.harness_slug,a.session_root,a.file_count,a.archived_at,a.cold_storage,f.relpath,f.codec,f.sha256,f.bytes_raw,f.bytes_stored FROM harness_shared.session_archives a LEFT JOIN harness_shared.session_archive_files f ON f.workspace_id=a.workspace_id AND f.source_kind=a.source_kind AND f.session_id=a.session_id WHERE a.workspace_id='default' AND a.owner='su-respawn-a51c8b849fb8963797d2928c1a3a8446' AND a.session_id IN ('01a1b159-8662-78c0-9ff2-bdfd7777b1f7','01a1b179-a684-7d33-9096-fd052373187e') ORDER BY a.session_id,f.relpath LIMIT 20",
  "archive": {
    "advisory": "⚠ absence unverified: rowCount is 0 and no positiveControlSql was run. Re-run with a known-positive SELECT through the same table/scope/instrument before treating this as evidence of absence.",
    "mode": "query",
    "rowCount": 0,
    "truncated": false,
    "fields": [],
    "elapsedMs": 259,
    "rows": [],
    "absence": {
      "status": "unverified",
      "code": "positive-control-not-run"
    }
  }
}

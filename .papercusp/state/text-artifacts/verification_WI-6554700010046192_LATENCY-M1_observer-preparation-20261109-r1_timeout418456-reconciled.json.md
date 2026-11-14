---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-preparation-20261109-r1/timeout418456-reconciled.json"
updated_at: 1794194681415
_body: "content"
---

{
  "owner": "su-24790d3e-5b5a-41fa-a8b0-4faf7584ec9f",
  "priorAwait": 418456,
  "timeout": true,
  "holder": {
    "resource": "git-sync:papercusp",
    "owner": "system:git-sync:2196820:2ef48bd4-1eba-4163-9b88-87665ef664c9",
    "owner_label": "git-sync:papercusp",
    "mode": "exclusive",
    "status": "held",
    "reason": "auto-commit papercusp",
    "acquired_ts": "2026-11-09T03:06:09.660Z",
    "expires_ts": "2026-11-09T03:34:21.147Z",
    "coordination_domain": "papercusp-workspace"
  },
  "activity": {
    "owner": "system:git-sync:2196820:2ef48bd4-1eba-4163-9b88-87665ef664c9",
    "phase": "local-sync",
    "active": true,
    "owner_pid": 2196820,
    "started_at": 1794193569675,
    "updated_at": 1794194654019,
    "workflow_id": "sched-.routinesTick-2026-11-09T03:06:00.000Z-21",
    "completed_at": null,
    "git_commands": {
      "scope": "local-sync-runner",
      "active": [
        {
          "id": 1399,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "started_at": 1794194654019,
          "subcommand": "diff"
        }
      ],
      "completed": [
        {
          "id": 1383,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194633019,
          "subcommand": "diff",
          "duration_ms": 301,
          "completed_at": 1794194633320
        },
        {
          "id": 1384,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194633320,
          "subcommand": "ls-files",
          "duration_ms": 1067,
          "completed_at": 1794194634387
        },
        {
          "id": 1385,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194634388,
          "subcommand": "ls-files",
          "duration_ms": 668,
          "completed_at": 1794194635055
        },
        {
          "id": 1386,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "failed",
          "exit_code": 1,
          "started_at": 1794194635055,
          "subcommand": "check-ignore",
          "duration_ms": 346,
          "completed_at": 1794194635401
        },
        {
          "id": 1387,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "failed",
          "exit_code": 1,
          "started_at": 1794194635401,
          "subcommand": "check-ignore",
          "duration_ms": 491,
          "completed_at": 1794194635892
        },
        {
          "id": 1388,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194636594,
          "subcommand": "diff",
          "duration_ms": 226,
          "completed_at": 1794194636820
        },
        {
          "id": 1389,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194636820,
          "subcommand": "reset",
          "duration_ms": 540,
          "completed_at": 1794194637360
        },
        {
          "id": 1390,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194637361,
          "subcommand": "diff",
          "duration_ms": 1755,
          "completed_at": 1794194639116
        },
        {
          "id": 1391,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194639116,
          "subcommand": "diff",
          "duration_ms": 460,
          "completed_at": 1794194639576
        },
        {
          "id": 1392,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194639685,
          "subcommand": "write-tree",
          "duration_ms": 1545,
          "completed_at": 1794194641230
        },
        {
          "id": 1393,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194641265,
          "subcommand": "rev-parse",
          "duration_ms": 598,
          "completed_at": 1794194641862
        },
        {
          "id": 1394,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194644719,
          "subcommand": "read-tree",
          "duration_ms": 1038,
          "completed_at": 1794194645757
        },
        {
          "id": 1395,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194645757,
          "subcommand": "rev-parse",
          "duration_ms": 366,
          "completed_at": 1794194646123
        },
        {
          "id": 1396,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194646125,
          "subcommand": "add",
          "duration_ms": 1176,
          "completed_at": 1794194647301
        },
        {
          "id": 1397,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194647515,
          "subcommand": "diff",
          "duration_ms": 1363,
          "completed_at": 1794194648878
        },
        {
          "id": 1398,
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "status": "succeeded",
          "exit_code": 0,
          "started_at": 1794194648878,
          "subcommand": "ls-files",
          "duration_ms": 4587,
          "completed_at": 1794194653464
        }
      ],
      "active_count": 1,
      "omitted_count": 0,
      "completed_count": 1398,
      "completed_omitted_count": 1382
    },
    "outcome_status": null
  },
  "freshness": {
    "status": "degraded",
    "measured_at": "2026-11-09T03:24:41.237Z",
    "last_synced_at": "2026-11-09T03:00:22.968Z",
    "age_ms": 1458269,
    "cadence_ms": 180000,
    "stale_after_ms": 540000,
    "missed_intervals": 8,
    "raw_last_status": "skipped",
    "scheduler": {
      "status": "not-firing",
      "last_completed_at": "2026-11-09T03:00:22.968Z",
      "age_ms": 1458269,
      "cadence_ms": 180000,
      "stale_after_ms": 540000,
      "missed_intervals": 8,
      "stalled_behind_in_flight_fire": true
    },
    "execution": {
      "status": "in-flight",
      "phase": "local-sync",
      "started_at": "2026-11-09T03:06:09.675Z",
      "age_ms": 1111562,
      "last_progress_at": "2026-11-09T03:24:14.019Z",
      "progress_age_ms": 27218,
      "holds_exclusive_locks": [],
      "locks_reported": false
    },
    "safe_to_restart": false,
    "safe_to_restart_reason": "A git-sync fire has been in flight for 19m and is still recording progress. Restarting would drop the exclusive git-sync lock mid-write and destroy its uncommitted work.",
    "in_flight": {
      "active": true,
      "phase": "local-sync",
      "started_at": "2026-11-09T03:06:09.675Z",
      "age_ms": 1111562,
      "long_running_age_ms": 1111562,
      "last_progress_at": "2026-11-09T03:24:14.019Z",
      "progress_age_ms": 27218,
      "stuck": false
    },
    "warning": "No completed git-sync outcome for more than 3 scheduled intervals, but a fire IS in flight (19m, phase 'local-sync') and is still recording progress. The stale clock is explained by that live fire, NOT by a stalled scheduler: do not restart or kill git-sync (safe_to_restart is false — a restart drops the exclusive git-sync lock mid-write and destroys its uncommitted work)."
  },
  "newAwait": {
    "ok": true,
    "await_id": 418496,
    "event": "resource:released:git-sync:papercusp",
    "expires_ts": "2026-11-09T03:39:41.341Z",
    "on_timeout": "wake",
    "wake_handle": "session #56619 (codex) — injectable/resumable",
    "operational_brief": {
      "schemaVersion": "operational-brief-v1",
      "surface": "await-wait",
      "subject": "resource:released:git-sync:papercusp",
      "state": {
        "status": "known",
        "value": "waiting",
        "source": "event_awaits"
      },
      "owner": {
        "status": "known",
        "value": "named-resource release path (packages/operator-core/lib/agent-tools/locks/resource-broadcast.ts → packages/operator-core/lib/harness/git-sync/git-sync-events.ts) via emitResourceReleasedEvent",
        "source": "events:catalog emitter"
      },
      "nextAction": {
        "status": "known",
        "value": "END YOUR TURN. You are re-invoked when resource:released:git-sync:papercusp fires, or with a timeout wake by 2026-11-09T03:39:41.341Z. On a timeout wake, check that named-resource release path (packages/operator-core/lib/agent-tools/locks/resource-broadcast.ts → packages/operator-core/lib/harness/git-sync/git-sync-events.ts) via emitResourceReleasedEvent is progressing before re-arming; a stalled emitter is your blocker to diagnose.",
        "source": "event_awaits"
      },
      "blockers": {
        "status": "known",
        "value": [
          "waiting for resource:released:git-sync:papercusp to fire"
        ],
        "source": "event_awaits"
      },
      "lastVerified": {
        "status": "known",
        "value": {
          "ref": "event_awaits#418496",
          "at": "2026-11-09T03:24:41.342Z",
          "summary": "one-shot wake await registered and pending"
        },
        "source": "event_awaits"
      },
      "deadline": {
        "status": "known",
        "value": "2026-11-09T03:39:41.341Z",
        "source": "event_awaits.expires_ts"
      },
      "facts": {
        "awaitId": 418496,
        "eventKey": "resource:released:git-sync:papercusp",
        "onTimeout": "wake",
        "wakeHandle": {
          "status": "known",
          "value": "adv-session",
          "source": "event_awaits"
        },
        "payloadFiltered": true,
        "announced": false,
        "retract": "events:cancel { await_id: 418496 }"
      },
      "unknowns": []
    },
    "advice": "Registered. End your turn now — you will be re-invoked when the event fires (or at the deadline). Do not poll."
  }
}


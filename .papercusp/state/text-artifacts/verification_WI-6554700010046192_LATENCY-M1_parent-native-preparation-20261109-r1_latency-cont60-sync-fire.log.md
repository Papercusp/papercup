---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-cont60-sync-fire.log"
updated_at: 1794255622680
_body: "content"
---

{
  "ok": true,
  "fired": true,
  "slug": "papercusp",
  "status": "skipped",
  "success": false,
  "committed": false,
  "head_before": "6cd9e7e540b86461b37b1843bdb4c5b31563d536",
  "head_after": "6cd9e7e540b86461b37b1843bdb4c5b31563d536",
  "outcome": {
    "status": "skipped",
    "reason": "held_exclusive",
    "blockedOn": "git-sync:papercusp",
    "holders": [
      {
        "owner": "system:git-sync:2196820:001184ee-973e-4a1c-89ee-bd10d31be460",
        "owner_label": "git-sync:papercusp",
        "mode": "exclusive",
        "status": "held",
        "lock_id": "551b62a7-2dcb-41b9-a330-0f9d893a87c1",
        "reason": "auto-commit papercusp",
        "acquired_ts": "2026-11-09T19:57:06.539Z",
        "expires_ts": "2026-11-09T20:20:10.275Z",
        "fence_seq": 78392
      }
    ]
  },
  "continuation": {
    "completion_event": {
      "key": "resource:released:git-sync:papercusp",
      "payload_fields": [
        "resource",
        "workspaceId",
        "releasedAtMs"
      ],
      "payload_filter": {
        "all": [
          {
            "resource": {
              "equals": "git-sync:papercusp"
            }
          },
          {
            "workspaceId": {
              "equals": "papercusp-workspace"
            }
          },
          {
            "releasedAtMs": {
              "gte": 1794254226539
            }
          }
        ]
      }
    },
    "await_tool": "events:await",
    "progress_ref": {
      "surface": "locks:list",
      "tool": "locks:list",
      "args": {
        "resource": "git-sync:papercusp"
      },
      "workspace_id": "papercusp-workspace",
      "install_slug": "papercusp",
      "resource": "git-sync:papercusp",
      "fields": [
        "resources[].holders",
        "resources[].held",
        "holders",
        "draining"
      ]
    }
  },
  "note": "git-sync skipped: an in-flight git-sync auto-commit holds git-sync:papercusp (held_exclusive). Wait for the exact resource release event in continuation.completion_event, then retry git-sync:run. The event reports a release but does not reserve the resource; if another exclusive holder wins before the retry, it may skip again and return a fresh continuation. For the workspace-wide barrier, inspect current holders because another shared holder may remain. Your changes are not lost; continuation.progress_ref retains live holder state."
}


---
rel_path: "evidence/c52-luna-r1-20261106/r3-wake-unknown-membership-extension-20261107T0545Z.json"
updated_at: 1794029749232
_body: "content"
---

{
  "schemaVersion": "c52-unknown-recipient-membership-extension-v1",
  "parent": "WI-6554700010045700",
  "sourceEvidence": {
    "sql": "SELECT workspace_id,owner_id,id,at,fleet_slug,fleet_role,event FROM harness_shared.fleet_membership_events WHERE workspace_id IN ('papercusp-workspace','default') AND owner_id IN ('su-20abc82a-837e-42eb-a37a-babde843dd5a','su-bbfd627f-1859-4ffe-aa04-8c96b24955ea','su-9ab8c7bf-12d5-412a-aefd-0ec60b3aa6bd','su-438edda7-b4e7-4e73-9e38-4102d3e5b546','su-598a1fb5-569f-4322-bda8-20888ead8e48','su-f2d016a8-63fb-4eaf-8c29-d7c9e68500ce','su-b0e4b489-d1bf-4ef8-bfbf-b00468dc485a','su-ebe9b9b1-f43d-4eb4-839d-e281da578e4b','su-4055ed75-e29e-4167-bcc0-1373d32f8c8c','su-89f4c459-af3d-4a13-81e0-80ce7d0c157d') AND at<'2026-11-06T00:35:00Z'::timestamptz ORDER BY owner_id,at,id",
    "data": {
      "mode": "query",
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "workspace_id",
        "owner_id",
        "id",
        "at",
        "fleet_slug",
        "fleet_role",
        "event"
      ],
      "elapsedMs": 346,
      "rows": [
        {
          "workspace_id": "papercusp-workspace",
          "owner_id": "su-9ab8c7bf-12d5-412a-aefd-0ec60b3aa6bd",
          "id": "17979",
          "at": "2026-11-05 15:58:29.778113+00",
          "fleet_slug": "code-intel-ship-sol61-xhigh-20261102",
          "fleet_role": "member",
          "event": "join"
        }
      ],
      "positiveControl": {
        "rows": [
          {
            "id": "17464",
            "workspace_id": "papercusp-workspace",
            "owner_id": "su-e94e8cd2-206f-4334-baff-cf3fdfe94916"
          }
        ],
        "rowCount": 1,
        "truncated": false,
        "fields": [
          "id",
          "workspace_id",
          "owner_id"
        ],
        "status": "passed"
      },
      "_meta": {
        "explicitFullRequest": true,
        "format": "json",
        "_seeAlso": [
          {
            "tool": "work_items:claimable"
          },
          {
            "tool": "plans:list"
          },
          {
            "tool": "db:migrations"
          },
          {
            "tool": "testing:runs"
          },
          {
            "tool": "issues:list / work_items:get"
          },
          {
            "tool": "dev:pg_active_queries"
          },
          {
            "tool": "dev:pg_table_sizes"
          },
          {
            "tool": "dev:pg_health"
          }
        ]
      }
    }
  },
  "interpretation": "Ten distinct unknown recipient owners across24retained endpoints remain unqualified at the send time. The one returned membership fact17979 is Nov5, later than the Nov2 call to9ab8. No earlier role is inferred. Positive control17464 passed.",
  "limits": [
    "Current historical ledger absence cannot prove the recipients were never fleet members.",
    "Workspace scope includes papercusp-workspace and documented legacy default.",
    "This extends scope qualification only; no full criterion or full assessment acceptance."
  ]
}

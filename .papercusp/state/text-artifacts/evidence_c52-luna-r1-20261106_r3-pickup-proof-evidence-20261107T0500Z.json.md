---
rel_path: "evidence/c52-luna-r1-20261106/r3-pickup-proof-evidence-20261107T0500Z.json"
updated_at: 1794027069785
_body: "content"
---

{
  "schemaVersion": "c52-fleet-pickup-evidence-v1",
  "createdAt": "2026-11-07T04:51:02.321019+00:00",
  "parent": "WI-6554700010045700",
  "defect": "EI-28103084158545179",
  "defectAssignee": "su-c52a1707-13f5-4080-870b-f7143c271d73",
  "fleet": "nonp2p-bug-drain-luna-max-0930",
  "window": {
    "from": "2026-10-30T00:35:00Z",
    "toExclusive": "2026-11-06T00:35:00Z"
  },
  "criterion": [
    {
      "revision": 57,
      "criteriaHash": "57b504287a278d9c790c85f82f9e02030755a249e5c03952f89f6e04cb113be4"
    },
    {
      "key": "leader-dispatch-and-pickup-verification",
      "title": "[leader] Handoffs and wakes reached a live member, and pickup was verified",
      "model": "When the leader hands work to a member (coord:dispatch / coord:wake / directed send with wake), it reads the delivery result: woken vs recipient_dead vs alive_not_wakeable, and confirms real pickup (the member's progress or reply) rather than trusting woken:1. Ended members are relaunched or retired, never re-woken into a black hole. The leader addresses owners directly instead of relaying through a third member.",
      "method": "Delivery and pickup come from harness_shared.event_wake_deliveries (NOTE workspace_id='default', not the app slug): rows with source = a leader owner_id and subscriber_id = a member, grouped by status (delivered/dropped/dead); turn_proof IS NOT NULL = verified pickup; pickup_escalated_at set = a missed pickup; repeated status='dead' rows for one subscriber_id = waking a black hole. tool_invocations (tool_name IN coord:dispatch / coord:wake / coord:send; args_json->>'to') supplies only the attempt count. For dispatched items, time from dispatch to the item's first progress (work_items.last_progress_at); items with no progress after 2 leader wakes are unverified handoffs.",
      "driftMarkers": "Repeated wakes to ended sessions; dispatched items with no progress after 2 leader wakes and no follow-up; 'handed off' reported without pickup evidence; work relayed through a third agent."
    }
  ],
  "totals": {
    "raw_deliveries": 702,
    "in_role_deliveries": 372,
    "in_role_literal_proof": 19,
    "in_role_positive_proof": 14,
    "in_role_escalated": 0,
    "unknown_role": 0
  },
  "rawInterpretation": {
    "historicalOwnerDeliveries": 702,
    "literalNonNullProof": 29,
    "confirmedProof": 18,
    "nonNullWithoutConfirmedPickup": 11
  },
  "qualifiedInterpretation": {
    "sameFleetLeaderToMemberAtCreatedAt": 372,
    "literalNonNullProof": 19,
    "confirmedProof": 14,
    "nonNullWithoutConfirmedPickup": 5,
    "nullProofUnknown": 353,
    "notPickedUp": 1,
    "superseded": 4,
    "excludedBecauseNotInRequiredRoles": 330
  },
  "sourceWriters": [
    {
      "path": "packages/operator-core/lib/events/await/store.ts",
      "sha256": "37b268586b33add34a20649da15463a6fce3184d1f9d6dd1915b8150544d71d8"
    },
    {
      "path": "packages/operator-core/lib/events/await/turn-proof.ts",
      "sha256": "e718c85f7538b9a80d026730c5a8e6857f30cf6d6bebcdff198eb7ab86fe5b03"
    },
    {
      "path": "packages/operator-core/lib/events/await/pickup-sweep.ts",
      "sha256": "bd2fd77f34dcb83eea2c6ee2b59d4a59e020f33f52f4e2e7aa4b0c057996665e"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/tools/wake.ts",
      "sha256": "29b7c930607070df62e73f587c5d948451ce58f64d888c7410a59342d9508d25"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/tools/send.ts",
      "sha256": "d56823d50db865f3d21f38966bd69be7ba16a708c206e5507ef4056c4a30862b"
    }
  ],
  "sources": {
    "c52-leader-wake-proof-population.json": {
      "sha256": "d23fbc1dfe20525ed731f6e3e8d0c9dae3dbf18256718f217291200307b8c44c",
      "data": {
        "mode": "query",
        "rowCount": 6,
        "truncated": false,
        "fields": [
          "status",
          "turn_proof",
          "deliveries",
          "frozen_literal_nonnull_proof",
          "positive_pickup_proof",
          "escalated_pickup",
          "sources",
          "subscribers"
        ],
        "elapsedMs": 2511,
        "rows": [
          {
            "status": "dead",
            "turn_proof": null,
            "deliveries": "1",
            "frozen_literal_nonnull_proof": "0",
            "positive_pickup_proof": "0",
            "escalated_pickup": "0",
            "sources": "1",
            "subscribers": "1"
          },
          {
            "status": "delivered",
            "turn_proof": "host-attested",
            "deliveries": "2",
            "frozen_literal_nonnull_proof": "2",
            "positive_pickup_proof": "2",
            "escalated_pickup": "0",
            "sources": "2",
            "subscribers": "2"
          },
          {
            "status": "delivered",
            "turn_proof": "not-picked-up",
            "deliveries": "3",
            "frozen_literal_nonnull_proof": "3",
            "positive_pickup_proof": "0",
            "escalated_pickup": "1",
            "sources": "2",
            "subscribers": "2"
          },
          {
            "status": "delivered",
            "turn_proof": "observed",
            "deliveries": "16",
            "frozen_literal_nonnull_proof": "16",
            "positive_pickup_proof": "16",
            "escalated_pickup": "0",
            "sources": "6",
            "subscribers": "12"
          },
          {
            "status": "delivered",
            "turn_proof": "superseded",
            "deliveries": "8",
            "frozen_literal_nonnull_proof": "8",
            "positive_pickup_proof": "0",
            "escalated_pickup": "0",
            "sources": "4",
            "subscribers": "5"
          },
          {
            "status": "delivered",
            "turn_proof": null,
            "deliveries": "672",
            "frozen_literal_nonnull_proof": "0",
            "positive_pickup_proof": "0",
            "escalated_pickup": "0",
            "sources": "21",
            "subscribers": "87"
          }
        ],
        "positiveControl": {
          "rows": [
            {
              "id": "1112478",
              "status": "delivered",
              "turn_proof": null
            }
          ],
          "rowCount": 1,
          "truncated": false,
          "fields": [
            "id",
            "status",
            "turn_proof"
          ],
          "status": "passed"
        }
      }
    },
    "c52-leader-wake-proof-role-qualified.json": {
      "sha256": "ff8a52d6a05ae18d2231322d9c464d12f1970cdfdfbf24fb08f160c6074870b0",
      "data": {
        "advisory": "⚠ population-narrowing query shape: this SQL uses LIMIT; zero rows from the bounded query do not establish that the underlying population is empty. Re-run without the narrowing clause before making an absence claim, or report the result as a bounded subset rather than a census. (EI-22433765987075358).",
        "mode": "query",
        "rowCount": 6,
        "truncated": false,
        "fields": [
          "status",
          "turn_proof",
          "raw_deliveries",
          "in_role_deliveries",
          "in_role_literal_proof",
          "in_role_positive_proof",
          "in_role_escalated",
          "unknown_role"
        ],
        "elapsedMs": 1442,
        "rows": [
          {
            "status": "dead",
            "turn_proof": null,
            "raw_deliveries": "1",
            "in_role_deliveries": "0",
            "in_role_literal_proof": "0",
            "in_role_positive_proof": "0",
            "in_role_escalated": "0",
            "unknown_role": "0"
          },
          {
            "status": "delivered",
            "turn_proof": "host-attested",
            "raw_deliveries": "2",
            "in_role_deliveries": "1",
            "in_role_literal_proof": "1",
            "in_role_positive_proof": "1",
            "in_role_escalated": "0",
            "unknown_role": "0"
          },
          {
            "status": "delivered",
            "turn_proof": "not-picked-up",
            "raw_deliveries": "3",
            "in_role_deliveries": "1",
            "in_role_literal_proof": "1",
            "in_role_positive_proof": "0",
            "in_role_escalated": "0",
            "unknown_role": "0"
          },
          {
            "status": "delivered",
            "turn_proof": "observed",
            "raw_deliveries": "16",
            "in_role_deliveries": "13",
            "in_role_literal_proof": "13",
            "in_role_positive_proof": "13",
            "in_role_escalated": "0",
            "unknown_role": "0"
          },
          {
            "status": "delivered",
            "turn_proof": "superseded",
            "raw_deliveries": "8",
            "in_role_deliveries": "4",
            "in_role_literal_proof": "4",
            "in_role_positive_proof": "0",
            "in_role_escalated": "0",
            "unknown_role": "0"
          },
          {
            "status": "delivered",
            "turn_proof": null,
            "raw_deliveries": "672",
            "in_role_deliveries": "353",
            "in_role_literal_proof": "0",
            "in_role_positive_proof": "0",
            "in_role_escalated": "0",
            "unknown_role": "0"
          }
        ]
      }
    },
    "c52-wake-delivery-schema.json": {
      "sha256": "b75ba13a831796fd3112c1e6c4943fbbf01023ef1423b2ce17558f3aa6d4870b",
      "data": {
        "relation": "harness_shared.event_wake_deliveries",
        "columns": [
          {
            "name": "id",
            "type": "bigint",
            "comment": null
          },
          {
            "name": "workspace_id",
            "type": "text",
            "comment": null
          },
          {
            "name": "await_id",
            "type": "bigint",
            "comment": null
          },
          {
            "name": "subscriber_id",
            "type": "text",
            "comment": null
          },
          {
            "name": "event_key",
            "type": "text",
            "comment": null
          },
          {
            "name": "payload",
            "type": "jsonb",
            "comment": null
          },
          {
            "name": "summary",
            "type": "text",
            "comment": null
          },
          {
            "name": "status",
            "type": "text",
            "comment": null
          },
          {
            "name": "channel",
            "type": "text",
            "comment": null
          },
          {
            "name": "attempts",
            "type": "integer",
            "comment": null
          },
          {
            "name": "last_error",
            "type": "text",
            "comment": null
          },
          {
            "name": "next_attempt_at",
            "type": "timestamp with time zone",
            "comment": null
          },
          {
            "name": "created_at",
            "type": "timestamp with time zone",
            "comment": null
          },
          {
            "name": "delivered_at",
            "type": "timestamp with time zone",
            "comment": null
          },
          {
            "name": "urgent",
            "type": "boolean",
            "comment": null
          },
          {
            "name": "min_sleep_sec",
            "type": "integer",
            "comment": null
          },
          {
            "name": "coalesced_count",
            "type": "integer",
            "comment": null
          },
          {
            "name": "source",
            "type": "text",
            "comment": null
          },
          {
            "name": "turn_proof",
            "type": "text",
            "comment": "P-006/D-004: did this delivery start a turn. host-attested | observed | awaiting | not-picked-up | superseded; NULL = booked before migration 1441. Independent of status, which only says the delivery was handed to a channel."
          },
          {
            "name": "turn_started_at",
            "type": "timestamp with time zone",
            "comment": "When the turn-start proof was established (host attestation time or first observed turn signal)."
          },
          {
            "name": "pickup_deadline_at",
            "type": "timestamp with time zone",
            "comment": "Awaiting rows resolve to not-picked-up after this instant (delivered_at + PAPERCUSP_WAKE_PICKUP_WINDOW_SEC, default 600)."
          },
          {
            "name": "pickup_escalated_at",
            "type": "timestamp with time zone",
            "comment": "Set when a not-picked-up delivery was handed to host recovery (at most once per delivery)."
          }
        ],
        "indexes": [
          {
            "name": "event_wake_deliveries_await_lookup",
            "definition": "CREATE INDEX event_wake_deliveries_await_lookup ON harness_shared.event_wake_deliveries USING btree (workspace_id, await_id)"
          },
          {
            "name": "event_wake_deliveries_pkey",
            "definition": "CREATE UNIQUE INDEX event_wake_deliveries_pkey ON harness_shared.event_wake_deliveries USING btree (id)"
          },
          {
            "name": "idx_event_wake_deliveries_due",
            "definition": "CREATE INDEX idx_event_wake_deliveries_due ON harness_shared.event_wake_deliveries USING btree (workspace_id, next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'parked'::text, 'delivering'::text]))"
          },
          {
            "name": "idx_event_wake_deliveries_pickup_awaiting",
            "definition": "CREATE INDEX idx_event_wake_deliveries_pickup_awaiting ON harness_shared.event_wake_deliveries USING btree (pickup_deadline_at) WHERE (turn_proof = 'awaiting'::text)"
          },
          {
            "name": "idx_event_wake_deliveries_subscriber",
            "definition": "CREATE INDEX idx_event_wake_deliveries_subscriber ON harness_shared.event_wake_deliveries USING btree (subscriber_id, created_at DESC)"
          }
        ]
      }
    },
    "c52-pickup-query-provenance.json": {
      "sha256": "d220f6a79b2dd60eeb399dff54c32c0c9a4cc2fc730e66fb99c9535527988f3e",
      "data": {
        "advisory": "⚠ single-agent activity ; ⓘ a tool covers this rea\n⚠ single-agent activity read: harness_shared.tool_invocations records MCP calls ONLY, so this window is NOT \"everything this agent did\" — native Claude Code Bash/Read/Grep/Edit produce no row at all, and this box's bypass-permissions preamble actively steers agents to native Bash for reads. Measured over ingested transcript parts (24h): native 54,009 calls across 183 agents vs MCP 35,479 across 128, so ~60% of recorded tool use is invisible here. The error is DIRECTIONAL — missing rows can only make an agent look LESS active, so a sparse or empty window reads as \"idle\" and escalates into waking, accusing or reassigning a peer who was working (EI-21847759967934033: this ledger showed one agent making only coord:glance / activity:report while it was in fact running Bash the whole time). THE RULE: positive rows prove activity; absence here proves …[TRUNCATED +1160 chars — recover: tools:invoke { name:'dev:pg_query', args:{ …original args, payloadTier:'full' } }]",
        "mode": "query",
        "rowCount": 3,
        "truncated": false,
        "fields": [
          "id",
          "invoked_at",
          "status",
          "args_json",
          "serving_host",
          "serving_process_id",
          "serving_build_sha"
        ],
        "elapsedMs": 41,
        "rows": [
          {
            "id": "47639994",
            "invoked_at": "2026-11-07 04:44:46.748+00",
            "status": "ok",
            "args_json": {
              "describe": "harness_shared.event_wake_deliveries",
              "allowUnscoped": false
            },
            "serving_host": "port-3170",
            "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:43638740",
            "serving_build_sha": "df01a886c5"
          },
          {
            "id": "47640201",
            "invoked_at": "2026-11-07 04:45:32.976+00",
            "status": "ok",
            "args_json": {
              "sql": "SELECT d.status,d.turn_proof,count(*) AS deliveries,count(*) FILTER(WHERE d.turn_proof IS NOT NULL) AS frozen_literal_nonnull_proof,count(*) FILTER(WHERE d.turn_proof IN('host-attested','observed')) AS positive_pickup_proof,count(*) FILTER(WHERE d.pickup_escalated_at IS NOT NULL) AS escalated_pickup,count(DISTINCT d.source) AS sources,count(DISTINCT d.subscriber_id) AS subscribers FROM harness_shared.event_wake_deliveries d WHERE d.workspace_id='default' AND d.source IN(SELECT DISTINCT owner_id FROM harness_shared.fleet_membership_events WHERE workspace_id='papercusp-workspace' AND fleet_slug='nonp2p-bug-drain-luna-max-0930' AND fleet_role='leader' AND at<'2026-11-06T00:35:00Z'::timestamptz) AND d.subscriber_id IN(SELECT DISTINCT owner_id FROM harness_shared.fleet_membership_events WHERE workspace_id='papercusp-workspace' AND fleet_slug='nonp2p-bug-drain-luna-max-0930' AND fleet_role='member' AND at<'2026-11-06T00:35:00Z'::timestamptz) AND d.created_at>='2026-10-30T00:35:00Z'::timestamptz AND d.created_at<'2026-11-06T00:35:00Z'::timestamptz GROUP BY d.status,d.turn_proof ORDER BY d.status,d.turn_proof",
              "maxRows": 100,
              "timeoutMs": 10000,
              "allowUnscoped": false,
              "positiveControlSql": "SELECT id,status,turn_proof FROM harness_shared.event_wake_deliveries WHERE workspace_id='default' AND created_at>='2026-10-30T00:35:00Z'::timestamptz AND created_at<'2026-11-06T00:35:00Z'::timestamptz ORDER BY id DESC LIMIT 1"
            },
            "serving_host": "port-3170",
            "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:43638740",
            "serving_build_sha": "df01a886c5"
          },
          {
            "id": "47640697",
            "invoked_at": "2026-11-07 04:47:08.874+00",
            "status": "ok",
            "args_json": {
              "sql": "WITH candidates AS MATERIALIZED (SELECT d.id,d.source,d.subscriber_id,d.status,d.turn_proof,d.created_at,d.pickup_escalated_at FROM harness_shared.event_wake_deliveries d WHERE d.workspace_id='default' AND d.source IN(SELECT DISTINCT owner_id FROM harness_shared.fleet_membership_events WHERE workspace_id='papercusp-workspace' AND fleet_slug='nonp2p-bug-drain-luna-max-0930' AND fleet_role='leader' AND at<'2026-11-06T00:35:00Z'::timestamptz) AND d.subscriber_id IN(SELECT DISTINCT owner_id FROM harness_shared.fleet_membership_events WHERE workspace_id='papercusp-workspace' AND fleet_slug='nonp2p-bug-drain-luna-max-0930' AND fleet_role='member' AND at<'2026-11-06T00:35:00Z'::timestamptz) AND d.created_at>='2026-10-30T00:35:00Z'::timestamptz AND d.created_at<'2026-11-06T00:35:00Z'::timestamptz), qualified AS (SELECT d.*,s.fleet_slug='nonp2p-bug-drain-luna-max-0930' AND s.fleet_role='leader' AND r.fleet_slug='nonp2p-bug-drain-luna-max-0930' AND r.fleet_role='member' AS in_role FROM candidates d LEFT JOIN LATERAL (SELECT e.fleet_slug,e.fleet_role FROM harness_shared.fleet_membership_events e WHERE e.workspace_id='papercusp-workspace' AND e.owner_id=d.source AND e.at<=d.created_at ORDER BY e.at DESC,e.id DESC LIMIT 1) s ON true LEFT JOIN LATERAL (SELECT e.fleet_slug,e.fleet_role FROM harness_shared.fleet_membership_events e WHERE e.workspace_id='papercusp-workspace' AND e.owner_id=d.subscriber_id AND e.at<=d.created_at ORDER BY e.at DESC,e.id DESC LIMIT 1) r ON true) SELECT status,turn_proof,count(*) AS raw_deliveries,count(*) FILTER(WHERE in_role) AS in_role_deliveries,count(*) FILTER(WHERE in_role AND turn_proof IS NOT NULL) AS in_role_literal_proof,count(*) FILTER(WHERE in_role AND turn_proof IN('host-attested','observed')) AS in_role_positive_proof,count(*) FILTER(WHERE in_role AND pickup_escalated_at IS NOT NULL) AS in_role_escalated,count(*) FILTER(WHERE in_role IS NULL) AS unknown_role FROM qualified GROUP BY status,turn_proof ORDER BY status,turn_proof",
              "maxRows": 100,
              "timeoutMs": 15000,
              "allowUnscoped": false
            },
            "serving_host": "port-3170",
            "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:43638740",
            "serving_build_sha": "df01a886c5"
          }
        ]
      }
    }
  },
  "limits": [
    "This is retained evidence for one submethod, not a final criterion rating or full grade.",
    "Current source and independent live schema establish the turn_proof enum; historical rows are read now with current retained proof states.",
    "The frozen@57 literal NONNULL predicate misclassifies not-picked-up and superseded; current rubric read remains revision57/hash57b50428. Preserve the immutable requested authority and both counts; do not silently change it.",
    "Only host-attested and observed are positive pickup proof per existing TURN_PROOF_CONFIRMED; NULL is unknown, not proof of no pickup.",
    "Role is qualified from latest append-only membership at delivery created_at, not from live presence.",
    "Attempt counts, repeated-dead subscriber grouping, dispatched-item first-progress/2leaderwake qualification and complete independent acceptance remain UNFINISHED.",
    "A last-progress timestamp must not be silently treated as a complete first-progress history. No claim yet about adequacy of available histories.",
    "All8/all26/fixed6221/D025OFF preserved; no source edits/newtests/probe0134/gateops/fanout/restarts/refire."
  ]
}


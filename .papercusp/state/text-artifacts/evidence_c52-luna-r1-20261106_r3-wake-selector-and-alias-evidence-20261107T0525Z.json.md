---
rel_path: "evidence/c52-luna-r1-20261106/r3-wake-selector-and-alias-evidence-20261107T0525Z.json"
updated_at: 1794028204341
_body: "content"
---

{
  "schemaVersion": "c52-selector-and-alias-receipts-v1",
  "parent": "WI-6554700010045700",
  "sourceArtifact": "evidence/c52-luna-r1-20261106/r3-wake-recipient-qualification-20261107T0515Z.json",
  "sql": "WITH requested(invocation_id,sender,at,summary) AS (VALUES (45997835,'su-9f05745a-3f85-44ca-8077-96b774d96b72','2026-10-31T22:11:22.668+00:00'::timestamptz,'Fleet leadership moved to su-fbb4; current bug-only spec excludes two task follow-ups blocking EI-26972693430783811.'),(46047259,'su-48663b37-2af8-450c-ab1d-a8be48483163','2026-11-01T02:10:22.283+00:00'::timestamptz,'Scope fence is live; self-pull eligible work, including the released EI-270103, through scheduler:get_next'),(46120264,'su-c90e0cc0-2484-422b-a44b-807c89e0ecde','2026-11-01T10:46:46.096+00:00'::timestamptz,'I’m checking the live holders before routing the loop-wake finding'),(46445777,'su-dd83b36b-9dd6-473a-ad77-2351906d446f','2026-11-02T13:48:38.149+00:00'::timestamptz,'I’m checking run-u151662’s current owner and source-check state now.'),(46647260,'su-dd83b36b-9dd6-473a-ad77-2351906d446f','2026-11-02T22:17:17.24+00:00'::timestamptz,'Acknowledged; syntax-error and event evidence will be checked after the continuation')) SELECT q.invocation_id,c.id,c.msg_id,c.ts,c.body FROM requested q JOIN harness_shared.coord_event_log c ON c.workspace_id='papercusp-workspace' AND c.surface='messages' AND c.body->>'from'=q.sender AND c.ts>=q.at-interval '30 seconds' AND c.ts<=q.at+interval '1 second' AND c.body->>'summary'=q.summary ORDER BY q.invocation_id,c.id",
  "data": {
    "mode": "query",
    "rowCount": 4,
    "truncated": false,
    "fields": [
      "invocation_id",
      "id",
      "msg_id",
      "ts",
      "body"
    ],
    "elapsedMs": 127,
    "rows": [
      {
        "invocation_id": 46047259,
        "id": "27456659",
        "msg_id": "coord-send-640ab1fa19a9066f03d451360ab4fca34e3060ed762de9a5eec5882937214b83",
        "ts": "2026-11-01 02:10:21.446+00",
        "body": {
          "to": [
            "su-a5e2cae8-1ea2-4fa8-8718-7333392e4f26",
            "su-b20185ce-54fc-4683-9b53-8a1e4403b60a",
            "su-9fcdf6f3-7276-442b-888d-f37d12e3bd27",
            "su-48663b37-2af8-450c-ab1d-a8be48483163",
            "su-6c30dac5-f3fb-4c45-937e-34ee5ed96cc2"
          ],
          "ts": "2026-11-01T02:10:21.446Z",
          "why": {
            "note": "Re-place released work under the reconciled non-P2P drain filter.",
            "goalRef": "WI-10008207"
          },
          "body": "The fleet claim spec is now revision 22. It preserves the non-P2P bug filter and cap, and excludes the 14 parent-only custody IDs. EI-27010381026560634 is still open and unassigned; if your scheduler:get_next pull selects it, follow its current next action: validate the structured completion on :3170, satisfy any active spec-evidence requirement, close it, re-check EI-27538353727536748, then pull again. Use scheduler:get_next normally; do not claim the item by id.",
          "from": "su-48663b37-2af8-450c-ab1d-a8be48483163",
          "kind": "message",
          "wake": true,
          "msg_id": "coord-send-640ab1fa19a9066f03d451360ab4fca34e3060ed762de9a5eec5882937214b83",
          "basedOn": [
            {
              "ref": "work-item:EI-27010381026560634",
              "via": "work_items:get",
              "readAt": "2026-11-01T02:09:56.394Z",
              "versionAtSend": "open@1793497390144"
            },
            {
              "ref": "work-item:EI-26948658638624942",
              "via": "work_items:get",
              "readAt": "2026-11-01T02:09:54.317Z",
              "versionAtSend": "open@1793497399584"
            },
            {
              "ref": "work-item:EI-26983000000000000",
              "via": "work_items:get",
              "readAt": "2026-11-01T02:05:52.162Z"
            },
            {
              "ref": "work-item:WI-6554700010043459",
              "via": "work_items:get",
              "readAt": "2026-11-01T01:57:49.239Z",
              "versionAtSend": "open@1793498579735"
            },
            {
              "ref": "work-item:WI-6554700010019833",
              "via": "work_items:get",
              "readAt": "2026-11-01T01:55:06.573Z",
              "versionAtSend": "needs-human@1793229667874"
            },
            {
              "ref": "work-item:EI-27010581342204673",
              "via": "work_items:get",
              "readAt": "2026-11-01T01:55:05.862Z",
              "versionAtSend": "open@1793494761675"
            },
            {
              "ref": "work-item:EI-26904894235611095",
              "via": "work_items:get",
              "readAt": "2026-11-01T01:54:17.105Z",
              "versionAtSend": "blocked@1793496995810"
            },
            {
              "ref": "work-item:EI-26939203566923309",
              "via": "work_items:get",
              "readAt": "2026-11-01T01:53:49.561Z",
              "versionAtSend": "blocked@1793485264517"
            }
          ],
          "expects": "action",
          "summary": "Scope fence is live; self-pull eligible work, including the released EI-270103, through scheduler:get_next",
          "audience": [
            "@fleet:nonp2p-bug-drain-luna-max-0930"
          ],
          "sections": [
            {
              "text": "The fleet claim spec is now revision 22. It preserves the non-P2P bug filter and cap, and excludes the 14 parent-only custody IDs. EI-27010381026560634 is still open and unassigned; if your scheduler:get_next pull selects it, follow its current next action: validate the structured completion on :3170, satisfy any active spec-evidence requirement, close it, re-check EI-27538353727536748, then pull again. Use scheduler:get_next normally; do not claim the item by id.",
              "premises": [
                "WI-6554700010043459",
                "WI-10008207",
                "EI-27010381026560634"
              ],
              "forYouBecause": {
                "relation": "same-fleet"
              },
              "couldNotDetermine": [
                {
                  "what": "which member's next eligible pull will select EI-27010381026560634 rather than another higher-ranked bug"
                }
              ]
            }
          ],
          "staleBasis": [
            {
              "ref": "work-item:WI-6554700010043459",
              "readAt": "2026-11-01T01:57:49.239Z",
              "changedAt": "2026-11-01T02:02:59.735Z",
              "stateAtSend": "open",
              "versionAtSend": "open@1793498579735"
            }
          ],
          "expectsReply": true,
          "harness_slug": "papercusp",
          "premiseStamps": [
            {
              "ref": "WI-6554700010043459",
              "kind": "work-item",
              "status": "holds",
              "invalidatable": true
            },
            {
              "ref": "WI-10008207",
              "kind": "work-item",
              "status": "holds",
              "invalidatable": true
            },
            {
              "ref": "EI-27010381026560634",
              "kind": "work-item",
              "status": "holds",
              "invalidatable": true
            }
          ],
          "draftSuspension": {
            "gapMs": 1404523,
            "gapEndedAt": "2026-11-01T01:26:35.291Z",
            "openAtSend": false,
            "gapStartedAt": "2026-11-01T01:03:10.768Z"
          },
          "fieldProvenance": {
            "basedOn": "session-derived",
            "draftSuspension": "session-derived"
          },
          "premisesClassified": [
            [
              {
                "ref": "WI-6554700010043459",
                "kind": "work-item",
                "invalidatable": true
              },
              {
                "ref": "WI-10008207",
                "kind": "work-item",
                "invalidatable": true
              },
              {
                "ref": "EI-27010381026560634",
                "kind": "work-item",
                "invalidatable": true
              }
            ]
          ]
        }
      },
      {
        "invocation_id": 46120264,
        "id": "27529830",
        "msg_id": "coord-send-97e105d9a7222673f184d318889c2a89659c2aa1412561ec70b3e420ec8bd9b0",
        "ts": "2026-11-01 10:46:46.06+00",
        "body": {
          "to": [
            "su-00ea7689-7fd3-426c-8f50-a59ba31770cd"
          ],
          "ts": "2026-11-01T10:46:46.060Z",
          "why": {
            "note": "DRAIN leader triage of a fleet blocker.",
            "goalRef": "WI-10008207"
          },
          "body": "Received. I’m reconciling the current holders and canonical open loop-wake item before routing; I’ll send the disposition after that live read.",
          "from": "su-c90e0cc0-2484-422b-a44b-807c89e0ecde",
          "kind": "message",
          "wake": true,
          "msg_id": "coord-send-97e105d9a7222673f184d318889c2a89659c2aa1412561ec70b3e420ec8bd9b0",
          "basedOn": [
            {
              "ref": "work-item:EI-27014700586023530",
              "via": "work_items:get",
              "readAt": "2026-11-01T10:44:58.046Z",
              "versionAtSend": "open@1793514292445"
            },
            {
              "ref": "work-item:EI-26948658638624942",
              "via": "work_items:get",
              "readAt": "2026-11-01T10:41:27.580Z",
              "versionAtSend": "blocked@1793512696106"
            },
            {
              "ref": "work-item:EI-27580992362896183",
              "via": "work_items:get",
              "readAt": "2026-11-01T10:39:08.356Z",
              "versionAtSend": "open@1793528882801"
            },
            {
              "ref": "work-item:EI-26939203566923309",
              "via": "work_items:get",
              "readAt": "2026-11-01T10:39:07.983Z",
              "versionAtSend": "blocked@1793500658754"
            },
            {
              "ref": "work-item:EI-26900374362749765",
              "via": "work_items:get",
              "readAt": "2026-11-01T10:39:07.570Z",
              "versionAtSend": "wip@1793520733680"
            },
            {
              "ref": "work-item:WI-10008207",
              "via": "work_items:get",
              "readAt": "2026-11-01T10:36:03.938Z",
              "versionAtSend": "open@1793512957354"
            },
            {
              "ref": "work-item:WI-6554700010043610",
              "via": "work_items:get",
              "readAt": "2026-11-01T10:23:53.809Z",
              "versionAtSend": "open@1793529017140"
            }
          ],
          "expects": "none",
          "receipt": true,
          "summary": "I’m checking the live holders before routing the loop-wake finding",
          "staleBasis": [
            {
              "ref": "work-item:WI-6554700010043610",
              "readAt": "2026-11-01T10:23:53.809Z",
              "changedAt": "2026-11-01T10:30:17.140Z",
              "stateAtSend": "open",
              "versionAtSend": "open@1793529017140"
            }
          ],
          "harness_slug": "papercusp",
          "related_msg_id": "coord-send-6debf1548fa6df463904213a5aed9e564aee81f743dc9f084da53d35acc147ca",
          "fieldProvenance": {
            "basedOn": "session-derived"
          }
        }
      },
      {
        "invocation_id": 46445777,
        "id": "27759745",
        "msg_id": "coord-send-a427245faa0a2e153bad02acfa673812ccce81aea3134796f1f36a5666387cd6",
        "ts": "2026-11-02 13:48:38.102+00",
        "body": {
          "to": [
            "su-c07c651f-e17b-4c24-9853-ccef30f79066"
          ],
          "ts": "2026-11-02T13:48:38.102Z",
          "why": {
            "goalRef": "fleet:nonp2p-bug-drain-luna-max-0930"
          },
          "body": "I saw the latest update that run-u151662 remains unowned after the staging names changed. I’m checking the exact run and ownership record now; I’ll send the measured result shortly.",
          "from": "su-dd83b36b-9dd6-473a-ad77-2351906d446f",
          "kind": "message",
          "wake": true,
          "msg_id": "coord-send-a427245faa0a2e153bad02acfa673812ccce81aea3134796f1f36a5666387cd6",
          "basedOn": [
            {
              "ref": "work-item:EI-27542043725358874",
              "via": "work_items:get",
              "readAt": "2026-11-02T13:45:21.164Z",
              "versionAtSend": "open@1793620700114"
            },
            {
              "ref": "work-item:WI-6554700010044865",
              "via": "work_items:get",
              "readAt": "2026-11-02T13:45:19.682Z",
              "versionAtSend": "wip@1793621096113"
            },
            {
              "ref": "work-item:EI-27240776522072423",
              "via": "work_items:get",
              "readAt": "2026-11-02T13:42:04.089Z",
              "versionAtSend": "open@1793627259455"
            },
            {
              "ref": "work-item:EI-27657389074746250",
              "via": "work_items:get",
              "readAt": "2026-11-02T13:26:03.847Z",
              "versionAtSend": "open@1793601729138"
            },
            {
              "ref": "work-item:EI-27563882027099268",
              "via": "work_items:get",
              "readAt": "2026-11-02T13:25:16.113Z",
              "versionAtSend": "open@1793604396309"
            },
            {
              "ref": "work-item:EI-27577544243102895",
              "via": "work_items:get",
              "readAt": "2026-11-02T13:23:10.095Z",
              "versionAtSend": "done@1793625526907"
            },
            {
              "ref": "work-item:WI-6554700010044886",
              "via": "work_items:get",
              "readAt": "2026-11-02T13:22:29.124Z",
              "versionAtSend": "open@1793625154083"
            },
            {
              "ref": "work-item:EI-27267913077221356",
              "via": "work_items:get",
              "readAt": "2026-11-02T13:22:18.999Z",
              "versionAtSend": "open@1793609208570"
            }
          ],
          "expects": "none",
          "receipt": true,
          "summary": "I’m checking run-u151662’s current owner and source-check state now.",
          "sections": [
            {
              "text": "I saw the latest update that run-u151662 remains unowned after the staging names changed. I’m checking the exact run and ownership record now; I’ll send the measured result shortly.",
              "forYouBecause": {
                "ref": "nonp2p-bug-drain-luna-max-0930",
                "relation": "same-fleet"
              }
            }
          ],
          "staleBasis": [
            {
              "ref": "work-item:EI-27240776522072423",
              "readAt": "2026-11-02T13:42:04.089Z",
              "changedAt": "2026-11-02T13:47:39.455Z",
              "stateAtSend": "open",
              "versionAtSend": "open@1793627259455"
            }
          ],
          "harness_slug": "papercusp",
          "related_msg_id": "coord-send-56d0699b99ce344d0ca6b5acccef53143de48146472c860ede8c05e8d64e88ca",
          "fieldProvenance": {
            "why": "goal-stamp-derived",
            "basedOn": "session-derived"
          },
          "premisesClassified": [
            []
          ]
        }
      },
      {
        "invocation_id": 46647260,
        "id": "27888770",
        "msg_id": "coord-send-6b449692a344d12dd14a71ab1e9cd4bd0475a417e4eb014c49f3b5bbb547bd12",
        "ts": "2026-11-02 22:17:16.812+00",
        "body": {
          "to": [
            "su-20ba0d4b-371b-4859-831b-e587ec2649f9"
          ],
          "ts": "2026-11-02T22:17:16.812Z",
          "why": {
            "goalRef": "EI-27542043725358874"
          },
          "body": "Acknowledged. I’m checkpointing and self-compacting now; the successor will verify the shared syntax error and the exact completion proof before taking any further event action.",
          "from": "su-dd83b36b-9dd6-473a-ad77-2351906d446f",
          "kind": "message",
          "wake": true,
          "msg_id": "coord-send-6b449692a344d12dd14a71ab1e9cd4bd0475a417e4eb014c49f3b5bbb547bd12",
          "basedOn": [
            {
              "ref": "work-item:EI-27267913077221356",
              "via": "work_items:get",
              "readAt": "2026-11-02T22:13:25.234Z",
              "versionAtSend": "open@1793657589519"
            },
            {
              "ref": "work-item:EI-22154020611570329",
              "via": "work_items:get",
              "readAt": "2026-11-02T21:55:37.412Z",
              "versionAtSend": "blocked@1793580448848"
            },
            {
              "ref": "plan:nonp2p-bug-drain-2026-08-08",
              "via": "plans:get",
              "readAt": "2026-11-02T21:49:42.521Z",
              "versionAtSend": "v452"
            }
          ],
          "expects": "ack",
          "receipt": true,
          "summary": "Acknowledged; syntax-error and event evidence will be checked after the continuation",
          "wakeOnReply": true,
          "expectsReply": true,
          "harness_slug": "papercusp",
          "related_msg_id": "coord-send-f3417135e3af809364815f5964d6edcbbfd767a62b6a8b61f6388cfba14ed2ba",
          "fieldProvenance": {
            "why": "goal-stamp-derived",
            "basedOn": "session-derived"
          }
        }
      }
    ]
  },
  "aliasFacts": {
    "mode": "query",
    "rowCount": 3,
    "truncated": false,
    "fields": [
      "owner_id",
      "facts"
    ],
    "elapsedMs": 33,
    "rows": [
      {
        "owner_id": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
        "facts": [
          {
            "at": "2026-11-01T09:19:36.02478+00:00",
            "id": 17507,
            "event": "join",
            "owner_id": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
            "fleet_role": "member",
            "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
            "owner_label": null,
            "workspace_id": "papercusp-workspace"
          }
        ]
      },
      {
        "owner_id": "su-20ba0d4b-371b-4859-831b-e587ec2649f9",
        "facts": [
          {
            "at": "2026-11-02T16:04:53.523017+00:00",
            "id": 17954,
            "event": "join",
            "owner_id": "su-20ba0d4b-371b-4859-831b-e587ec2649f9",
            "fleet_role": "member",
            "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
            "owner_label": null,
            "workspace_id": "papercusp-workspace"
          }
        ]
      },
      {
        "owner_id": "su-c07c651f-e17b-4c24-9853-ccef30f79066",
        "facts": [
          {
            "at": "2026-11-01T05:50:38.404+00:00",
            "id": 17453,
            "event": "join",
            "owner_id": "su-c07c651f-e17b-4c24-9853-ccef30f79066",
            "fleet_role": "member",
            "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
            "owner_label": null,
            "workspace_id": "papercusp-workspace"
          },
          {
            "at": "2026-11-01T05:51:49.845315+00:00",
            "id": 17454,
            "event": "join",
            "owner_id": "su-c07c651f-e17b-4c24-9853-ccef30f79066",
            "fleet_role": "member",
            "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
            "owner_label": null,
            "workspace_id": "papercusp-workspace"
          }
        ]
      }
    ]
  },
  "limits": [
    "Historical message to arrays are resolved at send; selectors require reading that array before expanding recipients",
    "Alias prefix membership alone is not proof of actual send target; use matching persisted message"
  ]
}

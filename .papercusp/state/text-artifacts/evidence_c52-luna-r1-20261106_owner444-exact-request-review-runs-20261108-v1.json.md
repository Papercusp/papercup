---
rel_path: "evidence/c52-luna-r1-20261106/owner444-exact-request-review-runs-20261108-v1.json"
updated_at: 1794173387073
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner444-exact-request-review-runs-v1",
  "subject": "EI-27743172902314040",
  "requestId": "44c5b282-1f8f-457b-809d-2d9dae07e8c6",
  "observedAt": "2026-11-08T21:29:47.061Z",
  "sql": "SELECT id, started_at, finished_at, run_kind, batch_size, promoted, merged, held, detail, count(*) OVER () AS matching_rows FROM harness_shared.admission_runs WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND run_kind='promoter-tick' AND id LIKE '%:review:44c5b282-1f8f-457b-809d-2d9dae07e8c6' ORDER BY started_at, id",
  "positiveControlSql": "SELECT id FROM harness_shared.admission_runs WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND run_kind='promoter-tick' ORDER BY started_at DESC LIMIT 1",
  "result": {
    "mode": "query",
    "rowCount": 2,
    "truncated": false,
    "fields": [
      "id",
      "started_at",
      "finished_at",
      "run_kind",
      "batch_size",
      "promoted",
      "merged",
      "held",
      "detail",
      "matching_rows"
    ],
    "elapsedMs": 149,
    "rows": [
      {
        "id": "sched-.routinesTick-2026-11-06T17:15:00.000Z-5:review:44c5b282-1f8f-457b-809d-2d9dae07e8c6",
        "started_at": "2026-11-06 17:15:33.109273+00",
        "finished_at": "2026-11-06 17:18:48.634767+00",
        "run_kind": "promoter-tick",
        "batch_size": 1,
        "promoted": 0,
        "merged": 0,
        "held": 1,
        "detail": {
          "mode": "promoter",
          "status": "complete",
          "outcome": {
            "unit": "items",
            "attempted": 1,
            "unchanged": 1,
            "rolledBack": 0,
            "successful": 0,
            "blockedReason": null,
            "failureReason": null,
            "uniqueRowsChanged": 0
          },
          "verdicts": {},
          "heldReasons": [
            {
              "itemId": "EI-27743172902314040",
              "reason": "merge guard claim-held: reference EI-25899294317941518 carries payload._claimHold"
            }
          ],
          "flaggedPairs": 6,
          "modelCostUsd": 0.02217,
          "guardRefusals": [
            {
              "detail": "review subject has a terminal, human, policy, mixed or unproven park/dependency",
              "itemId": "EI-27012912988975360",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review subject has a terminal, human, policy, mixed or unproven park/dependency",
              "itemId": "EI-27067800946139331",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27089747134753290",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review subject has a terminal, human, policy, mixed or unproven park/dependency",
              "itemId": "EI-27157013404898468",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review subject has a terminal, human, policy, mixed or unproven park/dependency",
              "itemId": "EI-27157469594143583",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27159571075992710",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review subject has a terminal, human, policy, mixed or unproven park/dependency",
              "itemId": "EI-27160122555520476",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review subject has a terminal, human, policy, mixed or unproven park/dependency",
              "itemId": "EI-27161588434368536",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27162754929728642",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review subject has a terminal, human, policy, mixed or unproven park/dependency",
              "itemId": "EI-27163400630125472",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27207673393613132",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27220123610879780",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester is neither current custodian nor canonical fleet leader",
              "itemId": "EI-27220735383013578",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27243465000947052",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27249244591096372",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27266051027298738",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27267913077221356",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27269500512594195",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "review requester absent, revoked or foreign",
              "itemId": "EI-27530211878753633",
              "reason": "review-gated",
              "canonicalId": null
            },
            {
              "detail": "reference EI-25899294317941518 carries payload._claimHold",
              "itemId": "EI-27743172902314040",
              "reason": "claim-held",
              "canonicalId": null
            }
          ],
          "targetItemIds": [
            "EI-27743172902314040"
          ],
          "queueSelection": {
            "runScope": "targeted",
            "schemaVersion": 1,
            "selectedItemIds": [
              "EI-27743172902314040"
            ],
            "comparisonItemIds": [
              "EI-25712136859740569",
              "EI-25899294317941518",
              "EI-25958851469309990",
              "EI-26748090500659197",
              "EI-27738080736342493",
              "WI-6554700010045205"
            ]
          },
          "producingRuntime": {
            "pid": 649315,
            "host": "main-server-Precision-7865-Tower",
            "unit": null,
            "version": null,
            "buildSha": null,
            "buildTime": null,
            "observedAt": "2026-11-06T17:15:32.910Z",
            "schemaVersion": 1,
            "bootReportedAt": null,
            "processIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:39862157",
            "buildIdentityReason": "boot-record-unverifiable",
            "buildIdentitySource": "runtime-vintage-kernel-pin",
            "buildIdentityStatus": "unknown",
            "environmentFingerprint": null
          },
          "writerCoverageGap": [],
          "promotedToFirstClaim": {
            "p50Ms": 48730206.6175,
            "p95Ms": 956867577.1756496,
            "sampleSize": 16060
          }
        },
        "matching_rows": "2"
      },
      {
        "id": "sched-.routinesTick-2026-11-06T19:00:00.000Z-75:review:44c5b282-1f8f-457b-809d-2d9dae07e8c6",
        "started_at": "2026-11-06 19:01:27.657877+00",
        "finished_at": "2026-11-06 21:19:48.415277+00",
        "run_kind": "promoter-tick",
        "batch_size": null,
        "promoted": null,
        "merged": null,
        "held": null,
        "detail": {
          "mode": "promoter",
          "error": "reaped: still running past the promoter-tick stranded threshold with no finish (process died mid-run)",
          "status": "failed",
          "outcome": {
            "unit": "items",
            "attempted": null,
            "unchanged": null,
            "rolledBack": null,
            "successful": null,
            "blockedReason": null,
            "failureReason": "stranded",
            "uniqueRowsChanged": null
          },
          "reapedAt": "2026-11-06T21:19:48.275Z",
          "reapedBy": "sched-.routinesTick-2026-11-06T21:18:30.000Z-35",
          "queueSelection": {
            "runScope": "targeted",
            "schemaVersion": 1,
            "selectedItemIds": [
              "EI-27743172902314040"
            ],
            "comparisonItemIds": [
              "EI-25712136859740569",
              "EI-25899294317941518",
              "EI-25958851469309990",
              "EI-26748090500659197",
              "EI-27738080736342493",
              "WI-6554700010045205"
            ]
          },
          "strandedAfterMs": 7200000,
          "producingRuntime": {
            "pid": 649315,
            "host": "main-server-Precision-7865-Tower",
            "unit": null,
            "version": null,
            "buildSha": null,
            "buildTime": null,
            "observedAt": "2026-11-06T19:01:27.089Z",
            "schemaVersion": 1,
            "bootReportedAt": null,
            "processIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:39862157",
            "buildIdentityReason": "boot-record-unverifiable",
            "buildIdentitySource": "runtime-vintage-kernel-pin",
            "buildIdentityStatus": "unknown",
            "environmentFingerprint": null
          }
        },
        "matching_rows": "2"
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "id": "sched-.routinesTick-2026-11-08T21:15:00.000Z-39"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "id"
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
}

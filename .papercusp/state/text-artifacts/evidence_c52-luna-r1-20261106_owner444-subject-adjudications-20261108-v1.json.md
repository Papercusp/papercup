---
rel_path: "evidence/c52-luna-r1-20261106/owner444-subject-adjudications-20261108-v1.json"
updated_at: 1794173447072
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner444-subject-adjudications-v1",
  "subject": "EI-27743172902314040",
  "observedAt": "2026-11-08T21:30:47.063Z",
  "sql": "SELECT a,b,verdict,canonical,judged_by,run_id,judged_at,evidence,count(*) OVER () AS matching_rows FROM harness_shared.dedup_adjudications WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND (a='EI-27743172902314040' OR b='EI-27743172902314040') ORDER BY judged_at,a,b",
  "positiveControlSql": "SELECT a,b FROM harness_shared.dedup_adjudications WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' ORDER BY judged_at DESC LIMIT 1",
  "result": {
    "mode": "query",
    "rowCount": 0,
    "truncated": false,
    "fields": [],
    "elapsedMs": 428,
    "rows": [],
    "positiveControl": {
      "rows": [
        {
          "a": "EI-21283616861729346",
          "b": "EI-26455344393292692"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "a",
        "b"
      ],
      "status": "passed"
    },
    "absence": {
      "status": "verified",
      "code": "positive-control-passed"
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
  },
  "limits": [
    "Pair ledger uses ON CONFLICT DO NOTHING and is not a latest-per-item outcome log.",
    "A dedup verdict is not an execution or authenticated owner-clearance receipt."
  ]
}

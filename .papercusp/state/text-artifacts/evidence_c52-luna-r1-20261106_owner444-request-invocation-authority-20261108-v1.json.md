---
rel_path: "evidence/c52-luna-r1-20261106/owner444-request-invocation-authority-20261108-v1.json"
updated_at: 1794173604823
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner444-request-invocation-authority-v1",
  "subject": "EI-27743172902314040",
  "requestId": "44c5b282-1f8f-457b-809d-2d9dae07e8c6",
  "observedAt": "2026-11-08T21:33:24.816Z",
  "sql": "SELECT id,tool_name,role,run_id,spawn_id,coord_owner_id,invoked_at,duration_ms,status,output_ref,error_code,error_message,args_json,principal_kind,principal_auth_method,principal_trust,serving_host,serving_process_id,serving_build_sha,count(*) OVER () AS matching_rows FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND run_id='2a180db5-de54-412c-88a7-002d4c5cd2a3' AND invoked_at >= '2026-11-06T16:34:00Z'::timestamptz AND invoked_at < '2026-11-06T16:37:00Z'::timestamptz AND args_json->>'id'='EI-27743172902314040' ORDER BY id",
  "positiveControlSql": "SELECT id FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND invoked_at >= '2026-11-06T16:34:00Z'::timestamptz AND invoked_at < '2026-11-06T16:37:00Z'::timestamptz ORDER BY id LIMIT 1",
  "result": {
    "advisory": "⚠ buckets may not sum: this returns a SCALAR over harness_shared.tool_invocations, and at least one discriminating predicate reads a jsonb path, which yields NULL when the key is ABSENT. A NULL operand makes a comparison UNKNOWN rather than false, so such a row satisfies NO branch — it is silently absent from every bucket AND from the filtered total, while the numbers still come back well-formed (WI-10002034: a measured census reported 96/0/2 while 94 rows fell through every FILTER, and re-asking it as an exhaustive partition INVERTED the conclusion). A scalar cannot show you this, because the wrong answer is shaped exactly like the right one. Re-ask it as an exhaustive partition, where every row lands in exactly one labelled cell — a NULL in any `d<N>` column IS the fall-through population, and the cells MUST add up to the unfiltered total:\nSELECT\n       (run_id='2a180db5-de54-412c-88a7-002d4c5cd2a3') AS d1,\n       (invoked_at >= '2026-11-06T16:34:00Z'::timestamptz) AS d2,\n       (invoked_at < '2026-11-06T16:37:00Z'::timestamptz) AS d3,\n       count(*) AS row_count\n  FROM harness_shared.tool_invocations\n WHERE workspace_id='papercusp-workspace'\n   AND harness_slug='papercusp'\n GROUP BY 1, 2, 3\n ORDER BY 4 DESC\n LIMIT 50;\nCheck that the cells sum before quoting any bucket as a finding.",
    "mode": "query",
    "rowCount": 1,
    "truncated": false,
    "fields": [
      "id",
      "tool_name",
      "role",
      "run_id",
      "spawn_id",
      "coord_owner_id",
      "invoked_at",
      "duration_ms",
      "status",
      "output_ref",
      "error_code",
      "error_message",
      "args_json",
      "principal_kind",
      "principal_auth_method",
      "principal_trust",
      "serving_host",
      "serving_process_id",
      "serving_build_sha",
      "matching_rows"
    ],
    "elapsedMs": 115,
    "rows": [
      {
        "id": "47451386",
        "tool_name": "work_items:review-admission",
        "role": "operator",
        "run_id": "2a180db5-de54-412c-88a7-002d4c5cd2a3",
        "spawn_id": "ephemeral-87acb6575596ec7c",
        "coord_owner_id": "su-respawn-a51c8b849fb8963797d2928c1a3a8446",
        "invoked_at": "2026-11-06 16:35:03.6+00",
        "duration_ms": 888,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "error_message": null,
        "args_json": {
          "id": "EI-27743172902314040",
          "harness": "papercusp",
          "purpose": "admission-review"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3170",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:38072446",
        "serving_build_sha": "b96618c020",
        "matching_rows": "1"
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "id": "47451050"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "id"
      ],
      "status": "passed"
    }
  }
}

---
rel_path: "evidence/c52-luna-r1-20261106/owner9-historical-native-parts-20261108-v1.json"
updated_at: 1794179184813
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner9-native-parts-v1",
  "workItem": "WI-6554700010045700",
  "source": "owner9-exact-clear-invocations-20261108-v1.json",
  "targets": [
    {
      "item_id": "EI-25398054129696034",
      "entry_index": 0,
      "ref": "conv-mv6ifdq6-0000-b827b04e02234c6ebb380e4e6f9d38c8",
      "clearer": "su-82592767-2742-45b8-b053-4b096877bacc",
      "cleared_at": "2026-10-13T17:10:36.045Z"
    },
    {
      "item_id": "EI-25938663476959671",
      "entry_index": 0,
      "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
      "clearer": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
      "cleared_at": "2026-10-15T21:37:23.200Z"
    },
    {
      "item_id": "EI-26217185985299604",
      "entry_index": 1,
      "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
      "clearer": "su-55595f20-e777-401b-92a3-3f06394a9541",
      "cleared_at": "2026-10-27T16:29:30.536Z"
    },
    {
      "item_id": "EI-27707885265505216",
      "entry_index": 0,
      "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
      "clearer": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
      "cleared_at": "2026-11-06T03:22:43.141Z"
    }
  ],
  "sql": "WITH targets AS (SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS t(item_id text,clearer text,cleared_at timestamptz)) SELECT t.item_id,p.workspace_id,p.source_kind,p.session_id,p.part_idx,p.ts,p.owner,p.speaker,p.part_kind,p.tool_name,p.text FROM targets t CROSS JOIN LATERAL (SELECT * FROM harness_shared.session_turn_parts WHERE workspace_id='papercusp-workspace' AND owner=t.clearer AND part_kind='tool_use' AND ts>=t.cleared_at-interval '10 minutes' AND ts<t.cleared_at+interval '10 minutes' AND position(t.item_id in text)>0 ORDER BY ts,part_idx LIMIT 21) p ORDER BY t.item_id,p.ts,p.part_idx LIMIT 85",
  "positiveControlSql": "SELECT session_id,part_idx,owner FROM harness_shared.session_turn_parts WHERE workspace_id='papercusp-workspace' AND owner='su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b' AND part_kind='tool_use' AND ts>='2026-10-15T21:27:00Z' AND ts<'2026-10-15T21:48:00Z' LIMIT 1",
  "result": {
    "advisory": "⚠ population-narrowing query shape: this SQL uses LIMIT; zero rows from the bounded query do not establish that the underlying population is empty. Re-run without the narrowing clause before making an absence claim, or report the result as a bounded subset rather than a census. (EI-22433765987075358). ⚠ unsafe session_turn_parts JSON decode: `text` is heterogeneous faithful-render text across text/tool_use/tool_result/thinking parts, so a direct `text::json/jsonb` or CAST(text AS json/jsonb) can raise PostgreSQL 22P02 on a non-JSON or truncated row. Decode defensively with `CASE WHEN text IS JSON THEN text::jsonb END` (or inspect raw text), and remember this transcript corpus uses workspace_id = 'default'; it has no separate JSON argument column. ⚠ absence unverified: positiveControlSql also returned 0 rows, so the instrument/scope has not been shown capable of finding a known-positive row.",
    "mode": "query",
    "rowCount": 0,
    "truncated": false,
    "fields": [],
    "elapsedMs": 25,
    "rows": [],
    "positiveControl": {
      "rows": [],
      "rowCount": 0,
      "truncated": false,
      "fields": [],
      "status": "failed"
    },
    "absence": {
      "status": "unverified",
      "code": "positive-control-empty"
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

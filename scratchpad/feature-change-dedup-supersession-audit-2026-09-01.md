# Feature/change corpus audit — durable P-001 evidence

This file is the durable rerun record for plan
`feature-change-dedup-supersession-audit-2026-09-01`, item `P-001`, and spec
`SPEC-FC-AUDIT-CORPUS@1`.

## Fixed watermark

`2026-09-01T15:49:00Z` (UTC).

The canonical reader and the independent database census both apply this watermark
to `updatedAt`/`updated_at`; feature rows convert it to epoch milliseconds because
`harness_features_consolidated.updated_ts` is bigint.

## Canonical export invocation

Run the following tool call from the `papercusp` harness. It is intentionally
argument-complete and has no implicit row cap:

```json
{
  "harness": "papercusp",
  "toDir": "scratchpad/.fc-audit-export",
  "terminalOnly": false,
  "includeObservations": false
}
```

Tool: `work_items:export`. The directory is a deterministic, repo-relative
regeneration target; generated row files may be removed after hashing. Expected
manifest at this watermark: `written=58796`,
`missing=[]`, `truncatedByLimit=false`. From the exported JSON rows, retain rows
whose `kind` is `feature` or `change`, whose `state` is not one of
`done|passed|resolved|closed|deprecated|dropped`, whose `payload.lane` is not
`observation`, and whose `updatedAt <= 2026-09-01T15:49:00Z`. Sort retained IDs
bytewise and hash the comma-delimited ID string with MD5 and SHA-256.

## Independent writer-backed census

Execute this exact read-only query with `dev:pg_query` using
`{"allowUnscoped":false,"maxRows":10,"timeoutMs":30000}`:

```sql
WITH p AS (SELECT '2026-09-01T15:49:00Z'::timestamptz AS wm),
f AS (
  SELECT feature_id AS id, item_kind AS kind
  FROM harness_shared.harness_features_consolidated, p
  WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp'
    AND item_kind='feature'
    AND updated_ts <= (EXTRACT(EPOCH FROM p.wm)*1000)::bigint
    AND status <> ALL(ARRAY['done','passed','resolved','closed','deprecated','dropped']::text[])
    AND COALESCE(payload->>'lane','') IS DISTINCT FROM 'observation'
),
i AS (
  SELECT issue_id AS id, kind
  FROM harness_shared.engineer_issues, p
  WHERE workspace_id='papercusp-workspace' AND scope='harness:papercusp'
    AND kind='change' AND updated_at <= p.wm
    AND state <> ALL(ARRAY['done','passed','resolved','closed','deprecated','dropped']::text[])
    AND lane IS DISTINCT FROM 'observation'
),
u AS (SELECT * FROM f UNION ALL SELECT * FROM i)
SELECT '2026-09-01T15:49:00Z' AS watermark,
       count(*)::int AS target,
       count(*) FILTER (WHERE kind='feature')::int AS feature,
       count(*) FILTER (WHERE kind='change')::int AS change,
       md5(string_agg(id, ',' ORDER BY id)) AS id_md5,
       encode(digest(string_agg(id, ',' ORDER BY id),'sha256'),'hex') AS id_sha256
FROM u;
```

Result at capture: `target=2808`, `feature=175`, `change=2633`,
`id_md5=61c2677e1f177e75b03b2b9a65c0e4a5`,
`id_sha256=bfa54d255095b7d6bf5ec59e628501387c371f7401752c41a2e0cde0b009b1f7`.
The sorted ID hashes from the canonical export and this query are identical.

## Writer citations

Use `capability:read` with the exact repository-relative paths and line windows:

```json
{"file_path":"packages/operator-core/lib/work-item-dispatch-states.ts","offset":41,"limit":39,"raw":true}
{"file_path":"packages/operator-core/lib/work-item-dispatch-states.ts","offset":163,"limit":11,"raw":true}
{"file_path":"packages/operator-core/lib/work-items.ts","offset":1057,"limit":13,"raw":true}
{"file_path":"packages/operator-core/lib/work-items.ts","offset":1321,"limit":7,"raw":true}
{"file_path":"packages/operator-core/lib/issues-engineer.ts","offset":1817,"limit":109,"raw":true}
```

These windows establish the terminal-state aliases, family storage units, harness
scope, and observation-lane exclusion used by the query.

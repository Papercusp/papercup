-- Slot identity is floor(epoch milliseconds / 300000), matching COVERAGE_EXPECTED_INTERVAL_MS.
WITH bounds AS (
  SELECT (floor(extract(epoch FROM now()) * 1000 / 300000) * 300000)::bigint AS end_ms
), r AS (
  SELECT name, COALESCE(metadata->'sync_delta'->'coverage',
    metadata->'sync_lint_guards'->'coverage', '{}'::jsonb) AS cov
  FROM harness_shared.routines
  WHERE workspace_id='papercusp-workspace'
    AND name IN ('sync-batch-delta-check','sync-batch-lint-guards')
), expected AS (
  SELECT generate_series(end_ms - 86400000, end_ms - 300000, 300000) / 300000 AS slot
  FROM bounds
), tick_slots AS (
  SELECT r.name, floor((e->>'atMs')::numeric / 300000) AS slot,
    bool_or(COALESCE((e->>'evaluated')::boolean, false)) AS evaluated,
    bool_or(COALESCE(e->>'status','') <> '') AS accounted
  FROM r CROSS JOIN bounds
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.cov->'ticks','[]'::jsonb)) e
  WHERE (e->>'atMs')::bigint >= end_ms - 86400000
    AND (e->>'atMs')::bigint < end_ms
  GROUP BY r.name, floor((e->>'atMs')::numeric / 300000)
), t AS (
  SELECT r.name, (r.cov ? 'alarmOpenSinceMs') AS alarm_open,
    EXISTS (
      SELECT 1 FROM harness_shared.work_items w
      WHERE w.workspace_id='papercusp-workspace'
        AND w.condition_key = CASE r.name
          WHEN 'sync-batch-delta-check' THEN 'sync-delta-coverage-low'
          ELSE 'sync-lint-guards-coverage-low' END
        AND w.status NOT IN ('done','dropped','resolved','closed')
        AND (w.payload->'_conditionUpsert'->>'lastSeenAt')::timestamptz > now() - interval '4 hours'
    ) AS alarm_fresh,
    count(s.slot) AS slots,
    count(*) FILTER (WHERE s.evaluated) AS ev,
    count(*) FILTER (WHERE NOT COALESCE(s.accounted, false)) AS unaccounted
  FROM r CROSS JOIN expected LEFT JOIN tick_slots s ON s.name=r.name AND s.slot=expected.slot
  GROUP BY r.name, r.cov
)
SELECT count(*)::int AS routines,
  COALESCE(min(slots), 0)::int AS min_slots,
  COALESCE(min(ev::float8 / 288), 0)::float8 AS min_ratio,
  COALESCE(sum(unaccounted), 0)::int AS unaccounted_slots,
  count(*) FILTER (WHERE ev::float8 / 288 < 0.95 AND NOT (alarm_open AND alarm_fresh))::int
    AS low_without_current_alarm,
  (CASE WHEN count(*) = 2 AND bool_and(slots >= 300 AND unaccounted = 0
    AND (ev::float8 / 288 >= 0.95 OR (alarm_open AND alarm_fresh))) THEN 1 ELSE 0 END)::int AS accounted
FROM t;

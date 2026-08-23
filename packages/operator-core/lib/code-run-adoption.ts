/**
 * code-run-adoption — the ADOPTION metric for `code:run` (code-run-token-frugality, owner directive
 * 2026-06-26). The missing measurement: the 2026-06-26 audit had to hand-roll telemetry to answer
 * "are agents actually batching?". This makes that a first-class, reusable read so the inline nudge's
 * effect (and any A/B of it — flip FLAGS.CODE_RUN_FANOUT_NUDGE and compare) is MEASURED, not assumed.
 *
 * The definition mirrors the nudge so the metric measures exactly what the nudge targets — the
 * thresholds are IMPORTED from code-run-batch-nudge, not re-stated, so they can never drift:
 *
 *   - A spawn is a BATCHABLE OPPORTUNITY when, across its (successful) tool calls, it either fired one
 *     tool from ≥ BATCH_NUDGE_THRESHOLD SEPARATE inference turns (the same-tool pattern) or touched
 *     ≥ FANOUT_DISTINCT_THRESHOLD distinct tools spanning ≥ FANOUT_DISTINCT_THRESHOLD separate turns
 *     (the fan-out pattern). Batch tools (code:* / recipes:*) are EXCLUDED from those counts (a
 *     code:run call is not "work to be batched").
 *   - A spawn ADOPTED code:run when it made ≥1 code:run / recipes:run call.
 *   - adoptionRate (per role/day) = opportunity-spawns-that-also-used-code:run ÷ opportunity-spawns.
 *     That is the number to watch: of the spawns that COULD have batched, how many DID.
 *
 * TURNS, not raw calls (P-012, agent-operability-clarity-full-audit-2026-07-13): this metric used to
 * classify an opportunity off raw tool-call counts (`maxSameTool`/`distinctTools`) — the same flaw the
 * live nudge had before P-012. Several tool calls dispatched from ONE model inference turn (parallel
 * tool_use — the harness's own "make independent calls in the same response block" guidance) cost a
 * single round-trip; counting them as separate "opportunities to batch" inflated the denominator with
 * spawns that were ALREADY optimal. `maxSameToolTurns`/`distinctTurns` (below) cluster calls into
 * inferred turns the same way the nudge does — see `clusterTurns`/`TURN_GAP_MS` in
 * code-run-batch-nudge.ts, imported (not re-implemented) so metric and nudge can never drift on what
 * "a wasted round-trip" means. `workCalls`/`distinctTools` are kept for informational/debugging
 * purposes but no longer drive the opportunity classification.
 *
 * Pure + injectable (the load-token-rollups.ts RunQuery precedent): `summarizeSpawnAdoption` /
 * `computeCodeRunAdoption` are pure and unit-tested without PG; `readCodeRunAdoption` runs the
 * canonical SQL through an injected runQuery. CODE_RUN_ADOPTION_SQL is the production/live query
 * (also runnable via dev:pg_query — see the agent-insight doc) and pre-aggregates per spawn so a
 * large tool_invocations table never streams raw rows over the wire.
 */
import {
  BATCH_NUDGE_THRESHOLD,
  EXCLUDED_TOOL_NORMS,
  FANOUT_DISTINCT_THRESHOLD,
  PREFERRED_DOOR_NORMS,
  TURN_GAP_MS,
  clusterTurns,
  sqlNormList,
} from './code-run-batch-nudge';

/** Injectable query runner (mirrors harness-insights/load-token-rollups.ts). */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/** P-008 run-quality rollup. Every value is derived from metadata_json written
 * by code:run/result-door; payload text is never selected or logged. */
export interface CodeRunInstrumentationRollup {
  runs: number;
  backendCounts: Record<string, number>;
  toolCalls: number;
  intermediateBytes: number;
  returnedContextBytes: number;
  spilledBytes: number;
  durationMs: number;
  failedRuns: number;
  failureClassCounts: Record<string, number>;
  recipeCaptures: number;
  recipeReuses: number;
  recipeCacheHits: number;
  recipeCandidates: number;
  recipeRevisions: number;
  aggregateOutputEscapes: number;
}

export const CODE_RUN_INSTRUMENTATION_SQL = `
WITH code_runs AS (
  -- invoked_at + output_ref are carried for the spill-resolution correlation below:
  -- output_ref holds the papercusp:// spill URI, metadata_json->>'spillPath' the filesystem
  -- path, and a later capability:read may address the spill by EITHER.
  SELECT metadata_json, invoked_at, output_ref
  FROM harness_shared.tool_invocations
  WHERE invoked_at >= now() - (($1)::int || ' days')::interval
    AND transport = 'mcp'
    -- WI-40720: was \`= 'coderun'\` — a single door, so the rollout telemetry gates below
    -- (bytes/run, failure rate, recipe reuse, backend routing) measured code:run alone and
    -- silently omitted every recipes:run and orchestrate:run execution. \`runs\` now means
    -- PREFERRED-DOOR runs, which is what a staged default-on rollout has to be graded on.
    AND lower(replace(replace(tool_name, ':', ''), '_', '')) IN (${sqlNormList(PREFERRED_DOOR_NORMS)})
), backend_counts AS (
  SELECT COALESCE(NULLIF(metadata_json->>'backend', ''), 'unknown') AS backend,
         count(*)::int AS runs
  FROM code_runs
  GROUP BY 1
), failure_class_counts AS (
  SELECT metadata_json->>'failureClass' AS failure_class,
         count(*)::int AS runs
  FROM code_runs
  WHERE metadata_json->>'failureClass' IS NOT NULL
  GROUP BY 1
)
SELECT
  count(*)::int AS runs,
  COALESCE((SELECT jsonb_object_agg(backend, runs) FROM backend_counts), '{}'::jsonb) AS backend_counts,
  COALESCE(sum(CASE WHEN (metadata_json->>'toolCalls') ~ '^[0-9]+$' THEN (metadata_json->>'toolCalls')::bigint ELSE 0 END), 0) AS tool_calls,
  COALESCE(sum(CASE WHEN (metadata_json->>'intermediateBytes') ~ '^[0-9]+$' THEN (metadata_json->>'intermediateBytes')::bigint ELSE 0 END), 0) AS intermediate_bytes,
  COALESCE(sum(CASE WHEN (metadata_json->>'returnedContextBytes') ~ '^[0-9]+$' THEN (metadata_json->>'returnedContextBytes')::bigint ELSE 0 END), 0) AS returned_context_bytes,
  COALESCE(sum(CASE WHEN (metadata_json->>'spilledBytes') ~ '^[0-9]+$' THEN (metadata_json->>'spilledBytes')::bigint ELSE 0 END), 0) AS spilled_bytes,
  COALESCE(sum(CASE WHEN (metadata_json->>'durationMs') ~ '^[0-9]+$' THEN (metadata_json->>'durationMs')::bigint ELSE 0 END), 0) AS duration_ms,
  count(*) FILTER (WHERE metadata_json->>'failureClass' IS NOT NULL)::int AS failed_runs,
  COALESCE((SELECT jsonb_object_agg(failure_class, runs) FROM failure_class_counts), '{}'::jsonb) AS failure_class_counts,
  count(*) FILTER (WHERE metadata_json->>'recipeCapture' = 'captured')::int AS recipe_captures,
  count(*) FILTER (WHERE metadata_json->>'recipeReuse' = 'true')::int AS recipe_reuses,
  count(*) FILTER (WHERE metadata_json->>'recipeCacheHit' = 'true')::int AS recipe_cache_hits,
  COALESCE(sum(CASE WHEN (metadata_json->>'recipeCandidateCount') ~ '^[0-9]+$' THEN (metadata_json->>'recipeCandidateCount')::bigint ELSE 0 END), 0) AS recipe_candidates,
  count(*) FILTER (WHERE NULLIF(metadata_json->>'recipeRevision', '') IS NOT NULL)::int AS recipe_revisions,
  count(*) FILTER (WHERE metadata_json->>'aggregateOutputEscape' = 'true')::int AS aggregate_output_escapes
FROM code_runs
`;

export async function readCodeRunInstrumentation(
  runQuery: RunQuery,
  sinceDays: number,
): Promise<CodeRunInstrumentationRollup> {
  const [row] = await runQuery<Record<string, unknown>>(CODE_RUN_INSTRUMENTATION_SQL, [clampSinceDays(sinceDays)]);
  const n = (key: string): number => Number(row?.[key]) || 0;
  const counts = (key: string): Record<string, number> => {
    const value = row?.[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([name, count]) => [name, Number(count) || 0]));
  };
  return {
    runs: n('runs'),
    backendCounts: counts('backend_counts'),
    toolCalls: n('tool_calls'),
    intermediateBytes: n('intermediate_bytes'),
    returnedContextBytes: n('returned_context_bytes'),
    spilledBytes: n('spilled_bytes'),
    durationMs: n('duration_ms'),
    failedRuns: n('failed_runs'),
    failureClassCounts: counts('failure_class_counts'),
    recipeCaptures: n('recipe_captures'),
    recipeReuses: n('recipe_reuses'),
    recipeCacheHits: n('recipe_cache_hits'),
    recipeCandidates: n('recipe_candidates'),
    recipeRevisions: n('recipe_revisions'),
    aggregateOutputEscapes: n('aggregate_output_escapes'),
  };
}

export interface NativeExecRoutingRollup {
  nativeExecCalls: number;
  nativeExecSessions: number;
  routedRunCalls: number;
  routedRunSessions: number;
  routedFraction: number | null;
}

export const NATIVE_EXEC_ROUTING_SQL = `
WITH native AS (
  SELECT count(*)::int AS calls, count(DISTINCT session_id)::int AS sessions
  FROM harness_shared.session_turn_parts
  WHERE workspace_id = 'default' AND source_kind = 'codex'
    AND ts >= now() - (($1)::int || ' days')::interval
    AND part_kind = 'tool_use' AND tool_name = 'exec'
), routed AS (
  SELECT count(*)::int AS calls, count(DISTINCT spawn_id)::int AS sessions
  FROM harness_shared.tool_invocations
  WHERE invoked_at >= now() - (($1)::int || ' days')::interval
    AND transport = 'mcp' AND spawn_id IS NOT NULL
    AND lower(replace(replace(tool_name, ':', ''), '_', '')) IN (${sqlNormList(PREFERRED_DOOR_NORMS)})
)
SELECT native.calls AS native_calls, native.sessions AS native_sessions,
       routed.calls AS routed_calls, routed.sessions AS routed_sessions
FROM native CROSS JOIN routed
`;

export async function readNativeExecRouting(runQuery: RunQuery, sinceDays: number): Promise<NativeExecRoutingRollup> {
  const [row] = await runQuery<Record<string, number | string>>(NATIVE_EXEC_ROUTING_SQL, [clampSinceDays(sinceDays)]);
  const nativeExecCalls = Number(row?.native_calls) || 0;
  const routedRunCalls = Number(row?.routed_calls) || 0;
  const denominator = nativeExecCalls + routedRunCalls;
  return {
    nativeExecCalls,
    nativeExecSessions: Number(row?.native_sessions) || 0,
    routedRunCalls,
    routedRunSessions: Number(row?.routed_sessions) || 0,
    routedFraction: denominator > 0 ? routedRunCalls / denominator : null,
  };
}

/** Normalized names of the batch tools — excluded from the "work" counts.
 *  IMPORTED from `code-run-batch-nudge`, not re-listed here. It used to be a local copy annotated
 *  "mirrors the nudge's EXCLUDED set; kept in lockstep by the agent-insight doc + the metric test" —
 *  and it had already fallen out of lockstep (WI-40720). A doc is not a mechanism. */
const BATCH_TOOL_NORMS: ReadonlySet<string> = EXCLUDED_TOOL_NORMS;

/** Normalized names that count as ACTUAL preferred-door adoption (the execution of a batch). */
const BATCH_RUNNER_NORMS: ReadonlySet<string> = PREFERRED_DOOR_NORMS;

/** Normalized names of NON-AGENT POLLER tools, excluded from the work counts
 *  (code-run-self-state-adoption-2026-07-03 P-006). The 2026-07-03 audit found a single
 *  system poller — activity:recent fired 2×/spawn, ~16.5k spawns/12h on the mcp transport
 *  under role 'operator' — manufacturing the overwhelming majority of "batchable
 *  opportunities" (87k of 88k in a 3d window). A machine cadence is not an LLM decision;
 *  counting it graded the fleet 'broken' on traffic no nudge could ever move. */
const POLLER_TOOL_NORMS: ReadonlySet<string> = new Set(['activityrecent']);

/** Strip everything but [a-z0-9] and lowercase — so `code:run` and `code_run` both normalize equal. */
function normalize(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** One raw tool-call row (for the from-raw `computeCodeRunAdoption` path / tests). `invokedAt` is
 *  REQUIRED (P-012): turn-clustering needs a timestamp per call — without one every call would have
 *  to be assumed its own turn, silently reverting to the raw-count behavior this metric replaced. */
export interface CallRow {
  spawnId: string;
  role: string;
  /** ISO day bucket (YYYY-MM-DD). */
  day: string;
  toolName: string;
  /** Epoch ms this call was invoked — the ONLY signal available to infer turn boundaries (P-012;
   *  see clusterTurns/TURN_GAP_MS in code-run-batch-nudge.ts). */
  invokedAt: number;
}

/** Per-spawn aggregate — the shape CODE_RUN_ADOPTION_SQL returns and the reducer consumes. */
export interface SpawnAdoptionRow {
  role: string;
  day: string;
  /** Non-batch tool calls in the spawn. Informational only since P-012 — NOT the opportunity signal
   *  (see maxSameToolTurns/distinctTurns). */
  workCalls: number;
  /** Distinct non-batch tools in the spawn. Informational only since P-012 (paired with
   *  distinctTurns — see isBatchableSpawn — because tool DIVERSITY alone does not imply wasted
   *  round-trips if it all landed in one turn). */
  distinctTools: number;
  /** Max count of any single non-batch tool in the spawn, by RAW CALLS. Superseded by
   *  maxSameToolTurns for the opportunity classification; kept for debugging/back-compat display. */
  maxSameTool: number;
  /** Max count of DISTINCT INFERENCE TURNS any single non-batch tool was called from (P-012) — the
   *  same-tool opportunity signal. A tool called 5× from ONE turn (parallel) scores 1 here, not 5. */
  maxSameToolTurns: number;
  /** Distinct inference turns spanned by the spawn's non-batch calls (P-012) — the fan-out
   *  opportunity signal, paired with distinctTools. */
  distinctTurns: number;
  /** The spawn made ≥1 code:run / recipes:run call. */
  usedCodeRun: boolean;
}

/** Per-(role, day) adoption rollup. */
export interface AdoptionSummary {
  role: string;
  day: string;
  /** Total spawns observed (that made ≥1 successful tool call) for this role/day. */
  spawns: number;
  /** Spawns with a batchable opportunity (same-tool ≥N or ≥M distinct tools). */
  opportunitySpawns: number;
  /** Of those, how many ALSO used code:run / recipes:run. */
  opportunitySpawnsUsingCodeRun: number;
  /** opportunitySpawnsUsingCodeRun ÷ opportunitySpawns — the headline number; null when no opportunity. */
  adoptionRate: number | null;
  /** Spawns that used code:run at all (opportunity or not). */
  codeRunSpawns: number;
}

/** Is this spawn a batchable opportunity? Uses the SAME thresholds as the live nudge (imported, so
 *  the metric and the nudge can never disagree about what "batchable" means) — and, since P-012,
 *  the SAME turn-based gating: a same-tool repeat only counts if it spans ≥ BATCH_NUDGE_THRESHOLD
 *  separate turns, and a fan-out only counts if it ALSO spans ≥ FANOUT_DISTINCT_THRESHOLD separate
 *  turns (tool diversity alone is not waste if it all happened in one turn). */
export function isBatchableSpawn(
  row: Pick<SpawnAdoptionRow, 'maxSameToolTurns' | 'distinctTools' | 'distinctTurns'>,
): boolean {
  return (
    row.maxSameToolTurns >= BATCH_NUDGE_THRESHOLD ||
    (row.distinctTools >= FANOUT_DISTINCT_THRESHOLD && row.distinctTurns >= FANOUT_DISTINCT_THRESHOLD)
  );
}

/** Fold per-spawn rows into per-(role, day) adoption summaries (deterministic; stable role/day sort). */
export function summarizeSpawnAdoption(rows: SpawnAdoptionRow[]): AdoptionSummary[] {
  const byKey = new Map<string, AdoptionSummary>();
  for (const r of rows) {
    const key = `${r.role}\x00${r.day}`;
    let s = byKey.get(key);
    if (!s) {
      s = {
        role: r.role,
        day: r.day,
        spawns: 0,
        opportunitySpawns: 0,
        opportunitySpawnsUsingCodeRun: 0,
        adoptionRate: null,
        codeRunSpawns: 0,
      };
      byKey.set(key, s);
    }
    s.spawns += 1;
    if (r.usedCodeRun) s.codeRunSpawns += 1;
    if (isBatchableSpawn(r)) {
      s.opportunitySpawns += 1;
      if (r.usedCodeRun) s.opportunitySpawnsUsingCodeRun += 1;
    }
  }
  const out = [...byKey.values()];
  for (const s of out) {
    s.adoptionRate = s.opportunitySpawns > 0 ? s.opportunitySpawnsUsingCodeRun / s.opportunitySpawns : null;
  }
  out.sort((a, b) => (a.role === b.role ? a.day.localeCompare(b.day) : a.role.localeCompare(b.role)));
  return out;
}

/** Build per-spawn rows from raw call rows (the from-raw path: tests + callers already holding rows).
 *  Turn-clusters each spawn's work calls (P-012, via the SAME `clusterTurns`/`TURN_GAP_MS` the live
 *  nudge uses) so `maxSameToolTurns`/`distinctTurns` measure inference turns, not raw call counts. */
export function spawnRowsFromCalls(calls: CallRow[]): SpawnAdoptionRow[] {
  interface Acc {
    role: string;
    day: string;
    usedCodeRun: boolean;
    /** Work (non-batch, non-poller) calls kept for turn-clustering: tool name + timestamp. */
    workCalls: { toolName: string; at: number }[];
  }
  const bySpawn = new Map<string, Acc>();
  for (const c of calls) {
    let a = bySpawn.get(c.spawnId);
    if (!a) {
      a = { role: c.role, day: c.day, usedCodeRun: false, workCalls: [] };
      bySpawn.set(c.spawnId, a);
    }
    const norm = normalize(c.toolName);
    if (BATCH_RUNNER_NORMS.has(norm)) a.usedCodeRun = true;
    if (!BATCH_TOOL_NORMS.has(norm) && !POLLER_TOOL_NORMS.has(norm)) {
      a.workCalls.push({ toolName: c.toolName, at: c.invokedAt });
    }
  }
  const out: SpawnAdoptionRow[] = [];
  for (const a of bySpawn.values()) {
    const turnOf = clusterTurns(a.workCalls);
    const allTurns = new Set<number>();
    const turnsByTool = new Map<string, Set<number>>();
    const rawCountByTool = new Map<string, number>();
    a.workCalls.forEach((w, i) => {
      allTurns.add(turnOf[i]);
      rawCountByTool.set(w.toolName, (rawCountByTool.get(w.toolName) ?? 0) + 1);
      let s = turnsByTool.get(w.toolName);
      if (!s) {
        s = new Set<number>();
        turnsByTool.set(w.toolName, s);
      }
      s.add(turnOf[i]);
    });
    let maxSameToolTurns = 0;
    for (const s of turnsByTool.values()) if (s.size > maxSameToolTurns) maxSameToolTurns = s.size;
    let maxSameTool = 0;
    for (const cnt of rawCountByTool.values()) if (cnt > maxSameTool) maxSameTool = cnt;
    out.push({
      role: a.role,
      day: a.day,
      workCalls: a.workCalls.length,
      distinctTools: rawCountByTool.size,
      maxSameTool,
      maxSameToolTurns,
      distinctTurns: allTurns.size,
      usedCodeRun: a.usedCodeRun,
    });
  }
  return out;
}

/** From raw call rows → per-(role, day) adoption summaries (the pure, test-friendly entry point). */
export function computeCodeRunAdoption(calls: CallRow[]): AdoptionSummary[] {
  return summarizeSpawnAdoption(spawnRowsFromCalls(calls));
}

/** Hard ceiling on the lookback window, independent of whatever a caller asks for. The
 *  dev:code_run_adoption TOOL already clamps `sinceDays` to 90 via its zod schema, but
 *  `readCodeRunAdoption` has two OTHER direct callers (system-health/compute.ts,
 *  overwatch/scorecard-backstop.ts) that bypass that tool-layer clamp entirely — so the real
 *  ceiling belongs HERE, where every caller funnels through it (WI-3815). */
export const CODE_RUN_ADOPTION_MAX_SINCE_DAYS = 90;

/** Statement-level timeout for the heavy tool_invocations scan (WI-3815: during the 2026-07-10
 *  host-load incident, repeated scans of this query were the recurring offender left stuck in
 *  PG's ClientWrite state — the backend had finished, but a starved Node event loop never drained
 *  the result, so the connection sat open indefinitely and `pg_cancel_backend` couldn't clear it;
 *  three such zombies saturated the operator PG pool for ~4h). This bounds worst-case SERVER-side
 *  execution time as a general safety net (a degraded box, a missing index, lock contention) —
 *  it does not by itself guarantee an already-finished-but-unflushed query gets reaped, which is
 *  why `buildCodeRunAdoptionQuery` also caps the result-row count below (the more direct lever for
 *  THIS incident's mechanism: less data to flush to a slow-draining client). Scoped via SET LOCAL
 *  to just this query's statement batch — never leaks onto the pooled connection's next query. */
export const CODE_RUN_ADOPTION_STATEMENT_TIMEOUT_MS = 30_000;

/** Hard ceiling on rows returned (WI-3815) — the final SELECT is one row per SPAWN (not per
 *  role/day; the role/day fold happens in JS via summarizeSpawnAdoption), so a busy 90-day window
 *  can legitimately be tens of thousands of rows. This is a pathological-case safety valve, not a
 *  routine truncation floor — sized well above any observed real window so normal reads are
 *  never truncated (a truncated read would silently under-count and skew adoptionRate). */
export const CODE_RUN_ADOPTION_ROW_CAP = 200_000;

/** Clamp an arbitrary sinceDays to [1, CODE_RUN_ADOPTION_MAX_SINCE_DAYS], defaulting to 7 for
 *  anything missing/non-finite/non-positive. Pure + exported so the clamp itself is unit-tested
 *  without PG. */
export function clampSinceDays(sinceDays: number | undefined): number {
  const n = sinceDays == null ? NaN : Math.trunc(sinceDays);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(n, CODE_RUN_ADOPTION_MAX_SINCE_DAYS);
}

/**
 * The shared CTE body for both CODE_RUN_ADOPTION_SQL (ad-hoc, $1-parameterized) and
 * buildCodeRunAdoptionQuery (bounded, WI-3815) — factored out so the two can never drift on the
 * turn-clustering logic. `dateWhereClause` is the only variance between the two callers (a $1 bind
 * vs an inlined, clamped interval literal).
 *
 * P-012 (agent-operability-clarity-full-audit-2026-07-13): `gapped`/`turned` cluster each spawn's
 * WORK calls into inferred INFERENCE TURNS via the SAME timing-gap heuristic the live nudge uses
 * (TURN_GAP_MS, code-run-batch-nudge.ts — imported as a literal here since SQL can't import TS) — a
 * new turn starts whenever the gap since the PREVIOUS call in that spawn exceeds TURN_GAP_MS ms.
 * Several calls landing inside ONE turn (parallel tool_use) cost a single round-trip and must not
 * inflate `max_same_tool_turns`/`distinct_turns` as if each were its own — that was the raw-call-count
 * flaw this migration fixes. `max_same_tool`/`distinct_tools` (raw, non-turn-aware) are kept
 * alongside for informational/debugging parity with the pre-P-012 shape.
 */
function adoptionQueryBody(dateWhereClause: string): string {
  return `
WITH calls AS (
  SELECT
    spawn_id,
    role,
    (invoked_at AT TIME ZONE 'UTC')::date::text AS day,
    tool_name,
    invoked_at,
    lower(regexp_replace(tool_name, '[^a-zA-Z0-9]', '', 'g')) AS norm
  FROM harness_shared.tool_invocations
  WHERE ${dateWhereClause}
    AND status = 'ok'
    -- P-006 (2026-07-03): agent traffic ONLY. The raw table is dominated by UI HTTP
    -- polling (the measuring-code-run-adoption doc's own denominator warning) and a
    -- NULL spawn_id would collapse every un-attributed call into one mega-spawn via
    -- GROUP BY. Without these two filters the fleet number graded polling, not agents.
    AND transport = 'mcp'
    AND spawn_id IS NOT NULL
),
per_spawn AS (
  SELECT
    spawn_id,
    max(role) AS role,
    max(day)  AS day,
    bool_or(norm IN (${sqlNormList(PREFERRED_DOOR_NORMS)})) AS used_code_run
  FROM calls
  GROUP BY spawn_id
),
work_rows AS (
  SELECT spawn_id, tool_name, invoked_at
  FROM calls
  WHERE norm NOT IN (
    -- EXCLUDED_TOOL_NORMS — the batch/reuse surface itself, interpolated from the one shared
    -- constant rather than restated, so this predicate cannot drift from the TS set again.
    ${sqlNormList(EXCLUDED_TOOL_NORMS)},
    -- POLLER_TOOL_NORMS (P-006): machine-cadence reads are not batchable LLM decisions.
    -- Composed separately on purpose: a poller is a DIFFERENT concept from a batch door,
    -- so it must not be folded into EXCLUDED_TOOL_NORMS.
    ${sqlNormList(POLLER_TOOL_NORMS)}
  )
),
gapped AS (
  -- ms since the PREVIOUS work call in this spawn (NULL for the first) — the raw signal
  -- "turned" below thresholds against TURN_GAP_MS to find turn boundaries.
  SELECT
    spawn_id, tool_name, invoked_at,
    EXTRACT(EPOCH FROM (invoked_at - LAG(invoked_at) OVER w)) * 1000 AS gap_ms
  FROM work_rows
  WINDOW w AS (PARTITION BY spawn_id ORDER BY invoked_at, tool_name)
),
turned AS (
  SELECT
    spawn_id, tool_name,
    SUM(CASE WHEN gap_ms IS NULL OR gap_ms > ${TURN_GAP_MS} THEN 1 ELSE 0 END)
      OVER (PARTITION BY spawn_id ORDER BY invoked_at, tool_name) AS turn_id
  FROM gapped
),
tool_turn_counts AS (
  SELECT spawn_id, tool_name, count(DISTINCT turn_id) AS turns_for_tool, count(*) AS raw_calls
  FROM turned
  GROUP BY spawn_id, tool_name
),
work_agg AS (
  SELECT
    spawn_id,
    COALESCE(sum(raw_calls), 0)::int      AS work_calls,
    count(*)::int                         AS distinct_tools,
    COALESCE(max(raw_calls), 0)::int      AS max_same_tool,
    COALESCE(max(turns_for_tool), 0)::int AS max_same_tool_turns
  FROM tool_turn_counts
  GROUP BY spawn_id
),
spawn_turns AS (
  SELECT spawn_id, count(DISTINCT turn_id)::int AS distinct_turns
  FROM turned
  GROUP BY spawn_id
)
SELECT
  ps.role,
  ps.day,
  COALESCE(wa.work_calls, 0)          AS work_calls,
  COALESCE(wa.distinct_tools, 0)      AS distinct_tools,
  COALESCE(wa.max_same_tool, 0)       AS max_same_tool,
  COALESCE(wa.max_same_tool_turns, 0) AS max_same_tool_turns,
  COALESCE(st.distinct_turns, 0)      AS distinct_turns,
  ps.used_code_run
FROM per_spawn ps
LEFT JOIN work_agg wa USING (spawn_id)
LEFT JOIN spawn_turns st USING (spawn_id)
`;
}

/** The canonical live query — pre-aggregates per spawn over the last `$1` days of SUCCESSFUL calls.
 *  Runnable as-is via dev:pg_query (see agent-insights/code-run-adoption-metric) — kept
 *  parameterized for that ad-hoc/manual use. `readCodeRunAdoption` itself does NOT run this
 *  directly; it runs the bounded `buildCodeRunAdoptionQuery(...)` below (WI-3815). Mirrors the
 *  normalize() + BATCH_TOOL_NORMS / BATCH_RUNNER_NORMS sets above. */
export const CODE_RUN_ADOPTION_SQL = adoptionQueryBody("invoked_at >= now() - (($1)::int || ' days')::interval");

/**
 * WI-3815: the query `readCodeRunAdoption` ACTUALLY runs — `CODE_RUN_ADOPTION_SQL`'s body,
 * bounded three ways:
 *   1. `SET LOCAL statement_timeout` — sent as ONE multi-statement batch with the scan itself
 *      (see the `runQuery(..., [])` call below: postgres.js's `unsafe()` uses the SIMPLE query
 *      protocol — which runs multiple `;`-separated statements as a single implicit transaction —
 *      whenever the params array is EMPTY; passing `$1` bound params would force the extended
 *      protocol instead, which only ever runs one statement, so `SET LOCAL` and the scan can't
 *      share a batch that way). `SET LOCAL` scopes the timeout to just this batch — it can never
 *      leak onto the pooled connection's next, unrelated query.
 *   2. The lookback window is clamped (`clampSinceDays`) and inlined as a validated INTEGER
 *      literal (never a raw/interpolated string) — safe because it is always the output of
 *      `clampSinceDays`, never a caller-supplied string.
 *   3. A `LIMIT` bounds the worst-case row count (see CODE_RUN_ADOPTION_ROW_CAP's doc).
 *
 * `days` MUST already be `clampSinceDays()`-ed by the caller (readCodeRunAdoption does this).
 */
export function buildCodeRunAdoptionQuery(days: number): string {
  const safeDays = clampSinceDays(days);
  return `
SET LOCAL statement_timeout = '${CODE_RUN_ADOPTION_STATEMENT_TIMEOUT_MS}ms';
${adoptionQueryBody(`invoked_at >= now() - interval '${safeDays} days'`)}
LIMIT ${CODE_RUN_ADOPTION_ROW_CAP}
`;
}

// ── Thundering-herd guard (EI-6889) ──────────────────────────────────────────────────────────
// CODE_RUN_ADOPTION_SQL is a HEAVY 7-day full aggregation over harness_shared.tool_invocations
// (millions of rows; a single scan runs for minutes). Several independent operator subsystems call
// readCodeRunAdoption on their own cadences with NO coordination — system-health/compute.ts,
// overwatch/scorecard-backstop.ts, and the on-demand dev:code_run_adoption tool — so N callers each
// launch their OWN concurrent scan. That is a self-sustaining herd: on 2026-07-02 up to 18 copies ran
// at once, pegging the operator event loop (~95% CPU) and starving the org-admin PG pool (184 conns,
// ~55 stuck in ClientRead/Write) until every MCP call fleet-wide timed out.
//
// The fix keeps the pure/injected shape but stops the herd at the read boundary:
//   • SINGLE-FLIGHT — concurrent callers for the same window share ONE in-flight scan instead of each
//     starting an independent one (the 18→1 collapse).
//   • SHORT-TTL memo — a completed rollup is reused for ADOPTION_CACHE_TTL_MS, so the scan runs at most
//     once per window per few minutes, not once per call. A 7-day adoption rollup is stable well within
//     that window, so callers still see current-enough numbers.
// Keyed by sinceDays because the query is the same logical scan of the shared table regardless of which
// pool's runQuery routes it. All callers use the result read-only, so the shared reference is safe.
//
// WI-3958 (2026-07-10): this memo is IN-PROCESS (a module-level Map), so it only collapses concurrent
// calls WITHIN one operator process — it does NOT collapse calls ACROSS the several operator processes
// that are actually live at once in this environment (bg-host + release-worktree operators + staging/dev
// operators each run their own `system-health` tick — see dbos/in-process-periodic.ts's 30s
// `systemHealthCheck`, one of readCodeRunAdoption's three callers). pg_stat_statements caught this CTE at
// 1341 calls / 38.6s mean / 863M cumulative rows during the WI-3937 PG-saturation incident — consistent
// with N independent per-process 5-minute memos each re-scanning on their own clock. A cross-process
// shared cache (PG-backed) is the complete fix; short of that, a MUCH longer TTL directly cuts total scan
// volume by the same factor regardless of process count — the item's own suggested "sharply reduce
// cadence" remedy. A 7-day rolling adoption rate does not need sub-half-hour freshness for a KPI/health
// dashboard, so the default moves from 5 minutes to 30 minutes (env-overridable for ops flexibility,
// mirroring PAPERCUSP_COORD_READLINES_CACHE_TTL_MS-style knobs elsewhere in this codebase).

function readAdoptionCacheTtlMs(): number {
  const raw = process.env.PAPERCUSP_ADOPTION_CACHE_TTL_MS;
  if (!raw) return 30 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

/** How long a completed adoption rollup is reused before the next call re-scans. Was 5 minutes
 *  (EI-6889); raised to 30 minutes (WI-3958) — see the note above. Override via
 *  PAPERCUSP_ADOPTION_CACHE_TTL_MS for an ops incident response without a code change. */
export const ADOPTION_CACHE_TTL_MS = readAdoptionCacheTtlMs();

interface AdoptionCacheEntry {
  at: number;
  value: AdoptionSummary[];
}
const adoptionResultCache = new Map<number, AdoptionCacheEntry>();
const adoptionInFlight = new Map<number, Promise<AdoptionSummary[]>>();

/** TEST SEAM — clear the herd-guard memo + in-flight maps so unit tests don't leak state across cases. */
export function __resetCodeRunAdoptionCacheForTests(): void {
  adoptionResultCache.clear();
  adoptionInFlight.clear();
}

/** Read the code:run adoption rollup from PG (last `sinceDays` days, default 7) and summarize it.
 *  Guarded by a single-flight + short-TTL memo (EI-6889) so concurrent/repeated callers never launch a
 *  fresh heavy tool_invocations scan per call — see the herd-guard note above. `now` is a test-only clock seam. */
export async function readCodeRunAdoption(
  runQuery: RunQuery,
  opts: { sinceDays?: number; now?: () => number } = {},
): Promise<AdoptionSummary[]> {
  // WI-3815: clamp FIRST — every caller (including the two that bypass the dev tool's own
  // zod max(90)) funnels through this ceiling, and the cache/in-flight maps below key on the
  // CLAMPED value so a caller passing e.g. 9999 shares the memo with one passing 90 rather than
  // minting a distinct, equally-oversized cache entry.
  const sinceDays = clampSinceDays(opts.sinceDays);
  const now = opts.now ?? Date.now;

  // Fresh memo within the TTL — serve it without touching PG.
  const cached = adoptionResultCache.get(sinceDays);
  if (cached && now() - cached.at < ADOPTION_CACHE_TTL_MS) return cached.value;

  // A scan for this window is already running — JOIN it rather than starting a second one.
  const running = adoptionInFlight.get(sinceDays);
  if (running) return running;

  const scan = (async (): Promise<AdoptionSummary[]> => {
    // WI-3815: run the BOUNDED query (SET LOCAL statement_timeout + inlined clamped window +
    // LIMIT) as a single simple-protocol statement batch — an EMPTY params array is what makes
    // postgres.js use the simple protocol (see buildCodeRunAdoptionQuery's doc); a $1-bound call
    // would run only the first statement's binding and reject/ignore the SET LOCAL batching.
    const rows = await runQuery<{
      role: string;
      day: string;
      work_calls: number | string;
      distinct_tools: number | string;
      max_same_tool: number | string;
      max_same_tool_turns: number | string;
      distinct_turns: number | string;
      used_code_run: boolean;
    }>(buildCodeRunAdoptionQuery(sinceDays), []);
    const spawnRows: SpawnAdoptionRow[] = rows.map((r) => ({
      role: r.role,
      day: r.day,
      workCalls: Number(r.work_calls) || 0,
      distinctTools: Number(r.distinct_tools) || 0,
      maxSameTool: Number(r.max_same_tool) || 0,
      maxSameToolTurns: Number(r.max_same_tool_turns) || 0,
      distinctTurns: Number(r.distinct_turns) || 0,
      usedCodeRun: r.used_code_run === true,
    }));
    const summary = summarizeSpawnAdoption(spawnRows);
    // Cache only a SUCCESSFUL scan (a thrown query is never memoized — the next call retries).
    adoptionResultCache.set(sinceDays, { at: now(), value: summary });
    return summary;
  })();

  adoptionInFlight.set(sinceDays, scan);
  try {
    return await scan;
  } finally {
    // Clear the in-flight slot only if it is still ours (defensive against a concurrent replace).
    if (adoptionInFlight.get(sinceDays) === scan) adoptionInFlight.delete(sinceDays);
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// Learning-loop wiring (code-run-adoption directive 2026-06-29): roll the per-(role,day) summaries
// into ONE fleet figure and GRADE it against the pot-coordination-health `tool-utilization`
// criterion, so the metric is no longer ad-hoc SQL — it feeds the scorecard substrate the
// learning loop reads (the Overwatch scorecard-backstop + a first-class dev:code_run_adoption read).
// Pure + unit-tested; no PG here.

/** Fleet-wide adoption over the whole window (all roles/days folded). */
export interface AdoptionRollup {
  /** Total observed spawns (≥1 successful tool call) in the window. */
  spawns: number;
  /** Spawns with a batchable opportunity (same-tool ≥N or ≥M distinct tools). */
  opportunitySpawns: number;
  /** Of those, how many ALSO used code:run / recipes:run. */
  opportunitySpawnsUsingCodeRun: number;
  /** opportunitySpawnsUsingCodeRun ÷ opportunitySpawns; null when no opportunities in window. */
  adoptionRate: number | null;
  /** Spawns that used code:run at all (opportunity or not). */
  codeRunSpawns: number;
}

/** Fold per-(role,day) summaries into one fleet rollup (the headline the grader reads). */
export function rollupAdoption(summaries: AdoptionSummary[]): AdoptionRollup {
  let spawns = 0;
  let opportunitySpawns = 0;
  let opportunitySpawnsUsingCodeRun = 0;
  let codeRunSpawns = 0;
  for (const s of summaries) {
    spawns += s.spawns;
    opportunitySpawns += s.opportunitySpawns;
    opportunitySpawnsUsingCodeRun += s.opportunitySpawnsUsingCodeRun;
    codeRunSpawns += s.codeRunSpawns;
  }
  return {
    spawns,
    opportunitySpawns,
    opportunitySpawnsUsingCodeRun,
    codeRunSpawns,
    adoptionRate: opportunitySpawns > 0 ? opportunitySpawnsUsingCodeRun / opportunitySpawns : null,
  };
}

/** A pot-coordination-health rating ({ rating, evidence }) — matches the scorecard shape. */
export interface ToolUtilizationGrade {
  rating: 'healthy' | 'degraded' | 'broken' | 'unknown';
  evidence: string;
}

/** Below this many batchable opportunity-spawns the window is too small to grade — honest 'unknown'
 *  beats a noisy rating off a quiet window. */
export const ADOPTION_MIN_SAMPLE = 5;

/** Adoption-rate cutoffs for the `tool-utilization` rating. The perpetual ~2% baseline lands
 *  'broken' (the number we want the learning loop to MOVE); ≥60% of batchable spawns folded is
 *  'healthy'. Tunable here in lockstep with the nudge thresholds the opportunity-count rides. */
export const ADOPTION_HEALTHY_AT = 0.6;
export const ADOPTION_DEGRADED_AT = 0.25;

/** Map a fleet adoption rollup → the pot-coordination-health `tool-utilization` rating. PURE. */
export function gradeToolUtilization(roll: AdoptionRollup): ToolUtilizationGrade {
  if (roll.adoptionRate === null || roll.opportunitySpawns < ADOPTION_MIN_SAMPLE) {
    return {
      rating: 'unknown',
      evidence:
        `code:run adoption: only ${roll.opportunitySpawns} batchable opportunity-spawns in window ` +
        `(< ${ADOPTION_MIN_SAMPLE}) — too small a sample to grade tool-utilization`,
    };
  }
  const pct = Math.round(roll.adoptionRate * 100);
  const rating =
    roll.adoptionRate >= ADOPTION_HEALTHY_AT
      ? 'healthy'
      : roll.adoptionRate >= ADOPTION_DEGRADED_AT
        ? 'degraded'
        : 'broken';
  return {
    rating,
    evidence:
      `code:run adoption ${pct}% — ${roll.opportunitySpawnsUsingCodeRun}/${roll.opportunitySpawns} ` +
      `batchable opportunity-spawns folded a multi-call flow into one code:run/recipes:run this window ` +
      `(${roll.codeRunSpawns} spawns used code:run at all, ${roll.spawns} spawns total).`,
  };
}

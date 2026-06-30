# Measuring code:run adoption (and A/B-ing the nudge)
URL: /internal/docs/agent-insights/code-run-adoption-metric

The code:run adoption metric + the inline fan-out nudge. Why ~70% of batchable spawns went un-nudged, what the fan-out trigger fixes, and the runnable SQL to watch adoption / ablate the nudge by flag.

## Why agents weren't using `code:run`

A 2026-06-26 audit of `harness_shared.tool_invocations` found near-zero *organic*
`code:run` use. Two causes:

1. **A role gate** excluded worker-tier roles (fixed: `agentRoles: [...AGENT_ROLES]`).
2. **The structural nudge fired on the wrong pattern.** The original inline nudge
   triggered only on **same-tool ≥3×** in a session. But among multi-call SU spawns
   (≥4 calls), only \~**33% (bee) / \~28% (queen)** *have* a same-tool-≥3× pattern — the
   other \~70% are **many-distinct-tools-once fan-outs** (`get` here, `search` there,
   `list` somewhere else). The nudge was structurally **blind** to the dominant
   batchable shape. It was also **one-shot** (ignore once → never again) and gave the
   agent **no felt cost** (an LLM never experiences the token price of N round-trips).

## What changed (the inline nudge)

`code-run-batch-nudge.ts` now runs a **sliding-window** (`NUDGE_WINDOW_MS`, 90s) tracker
per session with **two triggers**:

* **same-tool** ≥ `BATCH_NUDGE_THRESHOLD` (3) in the window → a list-then-loop skeleton.
* **fan-out** ≥ `FANOUT_DISTINCT_THRESHOLD` (4) *distinct* tools in the window → a
  ready-to-paste **`Promise.all`** skeleton over the exact tools just seen.

It **re-fires on exponential backoff** (cooldown 4→8→16→32→64 calls) instead of going
permanently silent, and **leads with the running round-trip count** so the otherwise
invisible token cost is felt in-loop. Each trigger has its own flag:

* `FLAGS.CODE_RUN_BATCH_NUDGE` — the same-tool trigger.
* `FLAGS.CODE_RUN_FANOUT_NUDGE` — the new fan-out trigger (its **own** flag so it is an
  independent A/B knob).

The hot path stays a ring push; `getFlag` is consulted only when a hint actually fires.

## The adoption metric

`code-run-adoption.ts` makes "are agents batching?" a first-class read. A spawn is a
**batchable opportunity** when it fired one tool ≥3× *or* touched ≥4 distinct tools
(batch tools excluded) — the **same thresholds the nudge uses, imported**, so metric and
nudge can never drift. **adoptionRate** (per role/day) = opportunity-spawns-that-also-used-`code:run`
÷ opportunity-spawns: *of the spawns that could have batched, how many did.*

* `computeCodeRunAdoption(rows)` / `summarizeSpawnAdoption(...)` — pure, unit-tested.
* `readCodeRunAdoption(runQuery, { sinceDays })` — runs `CODE_RUN_ADOPTION_SQL`.

### Run it live (dev:pg\_query)

`CODE_RUN_ADOPTION_SQL` pre-aggregates per spawn and is runnable as-is (param `$1` =
days). To eyeball adoption per role over the last 7 days:

```sql
WITH s AS ( /* CODE_RUN_ADOPTION_SQL body, $1 = 7 */ )
SELECT role,
       count(*)                                              AS spawns,
       count(*) FILTER (WHERE max_same_tool >= 3 OR distinct_tools >= 4)               AS opportunities,
       count(*) FILTER (WHERE (max_same_tool >= 3 OR distinct_tools >= 4) AND used_code_run) AS adopted,
       round(100.0 * count(*) FILTER (WHERE (max_same_tool >= 3 OR distinct_tools >= 4) AND used_code_run)
             / NULLIF(count(*) FILTER (WHERE max_same_tool >= 3 OR distinct_tools >= 4), 0), 1) AS adoption_pct
FROM s GROUP BY role ORDER BY opportunities DESC;
```

(Prefer `readCodeRunAdoption` in code — it owns the canonical query and the reducer.)

## A/B-ing the nudge (the sanctioned rail)

The `PROMPT_ABLATION` rail ablates SU-playbook **prose** rules — it does **not** cover
this structural nudge. Ablate the nudge the project way: flip `CODE_RUN_FANOUT_NUDGE`
OFF in `/admin/features`, let it run, and compare **adoptionRate** (above) for the
fan-out-eligible population across the ON vs OFF windows. The dedicated flag exists so
that A/B is clean — toggling it does not touch the same-tool trigger.

## Gotcha — keep the metric and the nudge in lockstep

The opportunity definition lives **once**: `isBatchableSpawn` imports
`BATCH_NUDGE_THRESHOLD` / `FANOUT_DISTINCT_THRESHOLD` from the nudge module, and
`CODE_RUN_ADOPTION_SQL` mirrors the same `normalize()` + excluded-batch-tool set inline.
If you change a threshold or the excluded set in the nudge, update the SQL's literal
`IN (...)` list to match (the unit test pins the at-threshold boundary, but the SQL's
literal list is not type-checked against the TS set).

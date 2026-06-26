# Token-efficiency production scorecard (live-fleet adoption + regression tracking)
URL: /internal/docs/agent-insights/token-efficiency-production-scorecard

The three live-fleet metrics that confirm the agent-tooling-token-efficiency work (validation limits, code:run, orient dedup) moved the needle and catch regressions — repeatable SQL over harness_shared.tool_invocations, with the 2026-06-25 baseline. Complements the offline A/B doc (measuring-code-run-adoption).

The `agent-tooling-token-efficiency-2026-06-25` plan shipped three levers — (1) validation-limit
tiers that **truncate instead of reject** so a too-long arg no longer wastes a whole call, (2) the
`code:run` batch-nudge so N round-trips collapse into one inference call, and (3) the orient-dedup
nudge so agents stop re-calling what `coord:orient` already returned. This doc is the **live-fleet
scorecard** that confirms those levers actually move production behaviour and catches regressions.

It is the production counterpart to [measuring code:run adoption](/internal/docs/agent-insights/measuring-code-run-adoption):
that doc is the **offline A/B** (llm-testing variant seam, haiku bucket — does the model *reach* for
code:run under different enforcement styles); this doc is the **live read** off real agent traffic.

## The store

Every tool call lands one row in `harness_shared.tool_invocations` (`tool_name`, `transport`,
`role`, `status`, `error_code`, `error_message`, `args_json`, `metadata_json`, `invoked_at`, …).
**Always scope the rate metrics to `transport='mcp'`** — the `http` transport is dominated by the
admin-UI sync polling (`plans:list`/`plans:attention`; see WI-820), which inflates the denominator
by \~15× and is not agent tool-calling. (`in_process` is the operator-converse/oracle surface — tiny.)

## The three metrics (repeatable SQL)

Run via `dev:pg_query` (read-only). One combined query gives the whole scorecard:

```sql
SELECT
  count(*) AS total_mcp,
  -- (2) code:run share — the round-trip-collapsing lever. The headline adoption number.
  count(*) FILTER (WHERE tool_name='code:run') AS code_run,
  round(100.0*count(*) FILTER (WHERE tool_name='code:run')/nullif(count(*),0),3) AS code_run_pct,
  -- (1) validation health — overall reject rate, and the string-limit subset specifically.
  count(*) FILTER (WHERE status='invalid-input') AS invalid_input_total,
  round(100.0*count(*) FILTER (WHERE status='invalid-input')/nullif(count(*),0),3) AS invalid_input_pct,
  count(*) FILTER (WHERE status='invalid-input'
                    AND error_message LIKE '%Too big: expected string%') AS string_limit_fails,
  -- (3) orient-dedup — loose proxy (see caveat); orient calls vs the 4 tools orient already returns.
  count(*) FILTER (WHERE tool_name='coord:orient') AS orient_calls,
  count(*) FILTER (WHERE tool_name IN
    ('memory:search','coord:inbox','coord:plan-events','coord:declare-intent')) AS redundant_followups
FROM harness_shared.tool_invocations
WHERE transport='mcp' AND invoked_at > now() - interval '24 hours';
```

Per-tool drill-down for the string-limit metric (which tool/field keeps overflowing):

```sql
SELECT tool_name, left(error_message,90) AS msg, count(*) n
FROM harness_shared.tool_invocations
WHERE status='invalid-input' AND error_message LIKE '%Too big: expected string%'
  AND invoked_at > now() - interval '24 hours'
GROUP BY 1,2 ORDER BY 3 DESC;
```

## Baseline — 2026-06-25 (24h, transport=mcp)

| Metric                     | Value               | Reading                                                       |
| -------------------------- | ------------------- | ------------------------------------------------------------- |
| total mcp calls            | 63,516              | denominator                                                   |
| **code:run share**         | **0.002%** (1 call) | **≈ zero adoption** — the nudge fires but agents don't comply |
| invalid\_input rate        | 0.115% (73)         | healthy overall reject rate                                   |
| **string-limit fails**     | **17**              | 16 are `loop:arm.goal` "`<=500 chars`"                        |
| orient calls               | 77                  | —                                                             |
| redundant follow-ups (raw) | 13,406              | loose upper bound only — see caveat                           |

### What the baseline says

* **code:run adoption is the open problem — but the audience just expanded.** At 0.002% (1 call)
  the round-trip-collapsing lever was effectively unused in production even though the batch-nudge
  shipped default-ON and emitted a paste-ready skeleton.

  **Role-access context:** The 2026-06-25 baseline was taken at the moment `code:run` shifted from
  `agentRoles: [...SU_ROLES, 'bee']` to `agentRoles: [...AGENT_ROLES]` (owner directive 2026-06-25;
  `code/run.ts` + `code-run-batch-nudge.ts`). Before this, only superuser-role agents and the generic
  bee were nudged — the high-repeat-call roles (worker, validator, reviewer) that would benefit MOST
  from batch collapsing were excluded and never saw the nudge. Post-expansion, the batch-nudge fires
  for EVERY built-in role, so future baselines will reflect a much larger audience. The 0.002% figure
  describes the pre-expansion cohort (SU + bee); do NOT use it as the adoption floor for the
  post-expansion fleet.

  The underlying fix remains an **enforcement-style** change — the way to pick the wording is the
  offline A/B in [measuring code:run adoption](/internal/docs/agent-insights/measuring-code-run-adoption)
  (`su-S13/S15/S16` scenarios on haiku). Re-run this scorecard after any enforcement change to confirm
  the live number moves off the floor (and S14 stays green so single calls aren't over-wrapped). The
  first post-expansion 24h window is the new meaningful baseline.
* **string-limit fails are a deploy-lag artifact, not a code bug.** `loop:arm.goal` is already in the
  `clampText` soft-limit set (`agent-tools/loop/arm.ts` → auto-truncate, no reject), but the 16 "\<=500
  characters" rejects are agents hitting the **older hard limit still live on green `:3070`** before
  the `limits.ts` soft-clamp deploy lands. Expect `string_limit_fails` to decay to \~0 once the deploy
  promotes. If it *doesn't* decay — or a different tool/field starts dominating the drill-down — that's
  a real regression (a field that never got converted to a soft limit).
* **validation reject rate (0.115%) is healthy** — Phase 1's truncate-don't-reject is doing its job;
  the residual rejects are wrong-type / missing-required-field, which limits can't fix.

### Caveat on the redundant-bootstrap metric

The raw `redundant_followups` count (13,406) is **not** the redundant-bootstrap rate — those four
tools are called constantly in contexts that never followed a `coord:orient`. The true metric needs a
per-session correlation (a follow-up call by the **same actor within \~N seconds after** that actor's
orient). `tool_invocations` has no first-class session id (ephemeral spawns get a fresh `spawn_id`
per call), so a precise number needs either a session key threaded into `metadata_json` or a windowed
self-join on `role`+time. Until then, track the **ratio trend** (`redundant_followups / orient_calls`)
as a coarse directional signal, not an absolute rate, and treat a *downward* trend after the
`ORIENT_DEDUP_NUDGE` deploy as the win. Refining this into a real per-session metric is the one open
follow-up for this scorecard.

## Cadence

Run the combined query on a weekly cadence (or after any token-efficiency deploy) and append the row
to a tracking note. Three asserts catch the regressions that matter:

1. `code_run_pct` trending **up** off the 0.002% floor (the adoption lever working).
2. `string_limit_fails` at/near **0** after the soft-clamp deploy, with no new tool dominating the drill-down.
3. `invalid_input_pct` staying **≤ \~0.15%** (Phase 1 not regressing).

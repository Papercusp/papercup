# plans:list/attention egress is poll-FREQUENCY, not payload — and deltas cut bytes, not call count
URL: /internal/docs/agent-insights/plans-egress-is-poll-frequency-not-payload

plans:list + plans:attention are the dominant read-byte tools (~340GB/7d, the EI-2661 headline). MEASURED: that traffic is ~100% desktop-UI HTTP polling (transport='http': ~560K calls each / 3d; agents via mcp: <100), at ~4 calls/sec EACH, the two fired in lockstep from the same poll cycle. But the underlying plan tables are written only ~10-30×/HOUR — a ~500-2000:1 read:write ratio, so ~99.9% of those reads return byte-identical data. Two INDEPENDENT levers follow, and conflating them is the trap: (1) the rows-delta protocol (SYNC_RESOURCE_DELTA, default-ON 2026-06-23; resource-delta-config lists plans.list + plans.attention) collapses the ~99.9% unchanged reads into tiny `not_modified` bodies — the right fix for BYTES, and it's why tool_invocations.output_size will NOT show the win (it records the full pre-delta result). (2) The call COUNT itself (~4/sec, decoupled from data) stays pure waste even with deltas — each is still a full server-side tool invocation + round-trip. cachedRead (caching-an-expensive-tool-read) makes each cheap on the server but does not remove the call. The count lever is to make these reads invalidation-driven (SSE push on the rare write + a LONG drift-repair poll), not a tight fixed poll. Do NOT declare egress 'solved' when the delta lands — the byte win is real, the count waste is not touched.

## The mistake this prevents

Seeing `plans:list` at \~340GB/7d (the #1 read-byte tool, \~25× the next) and concluding the
fix is **payload size** (a slim projection / TOON re-encode) or that the **rows-delta rollout
fully solves it**. Both miss the shape of the traffic.

## What's actually true (measured `harness_shared.tool_invocations`)

* **It's \~100% the desktop UI, not agents.** `transport='http'` ≈ 560K calls each for
  `plans:list` and `plans:attention` over 3d; `transport='mcp'` (LLM/agent) was **\<100**. The
  340GB is UI polling, not tool calls in agent context. (So a token/encoding optimization on the
  agent path — TOON, slim args — buys \~nothing here; the payload is already >16KB so it falls
  back to plain JSON anyway.)
* **\~4 calls/sec EACH, in lockstep.** Hour-by-hour the two tools have near-identical counts —
  one UI poll cycle fetches both. Steady around the clock.
* **\~500–2000:1 read:write ratio.** In a representative window: \~13–15K reads/hour vs **6–27
  plan-table writes/hour**. The data changes once every few minutes; the UI re-reads it \~4×/sec.
  **\~99.9% of reads are byte-identical to the previous one.** The poll cadence is **fixed and
  decoupled from data change** — it is NOT invalidation-driven.

## The two independent levers (don't conflate)

1. **BYTES — the rows-delta / `not_modified` protocol.** `FLAGS.SYNC_RESOURCE_DELTA` graduated
   default-ON 2026-06-23; `resource-delta-config.ts` registers both `plans.list`
   (`itemKeyField:'slug'`) and `plans.attention` (`itemKeyField:'key'`); the client lists both in
   `DELTA_RESOURCES` (`sync-delta-codec.ts`). A cursor-sending client gets `not_modified` (or a
   one-group/one-row delta) instead of the full \~400–600KB. This collapses the \~99.9% unchanged
   reads and is the correct fix for the byte volume. **It will not show in
   `tool_invocations.output_size`** — that column records the full computed tool result; the delta
   saving happens in the rest-query handler *after* the tool returns. Measure the win at the HTTP/
   wire layer, not in `tool_invocations`. (`plans:attention`'s payload was already cut \~20× by its
   earlier delta exemplar — avg \~12MB→\~550KB after 2026-06-20 — visible in `avg(output_size)`,
   because that was a payload *shape* change, not the wire delta.)

2. **COUNT — the poll cadence.** Deltas make each of the \~4/sec calls *cheap on the wire*, and
   `cachedRead` (see \[caching-an-expensive-tool-read]) makes each *cheap on the server*, but
   **the call still happens** — a full tool invocation + cache lookup + delta computation + round
   trip, \~13K/hour/tool, almost all returning "nothing changed." With a \~1000:1 read:write ratio,
   a fixed \~4/sec poll is the wrong model. The lever is to drive these reads from **invalidation**
   (an SSE push on the rare plan write) plus a **long** drift-repair poll — not a tight fixed
   interval. This is independent of the delta work and is the larger remaining structural waste.

## How to verify / re-measure

```sql
-- transport split (is it UI or agents?)
SELECT tool_name, transport, count(*)
FROM harness_shared.tool_invocations
WHERE tool_name IN ('plans:list','plans:attention') AND invoked_at > now() - interval '3 days'
GROUP BY 1,2 ORDER BY 3 DESC;

-- the read:write ratio (the decisive number)
SELECT date_trunc('hour', invoked_at) hr,
  count(*) FILTER (WHERE tool_name IN ('plans:list','plans:attention')) AS reads,
  count(*) FILTER (WHERE tool_name ~ '^(plans:set-status|plans:add-item|plans:edit|plans:new|work_items:set_state)') AS writes
FROM harness_shared.tool_invocations
WHERE invoked_at > now() - interval '2 hours' GROUP BY 1 ORDER BY 1 DESC;
```

If `reads ≫ writes` and the per-hour read count is flat around the clock, the bottleneck is poll
cadence (lever 2), not payload (handled by lever 1). Tracked as **EI-2661** (egress) / **WI-545**
(move the UI poll onto an SSE/sync delta or `not_modified`).

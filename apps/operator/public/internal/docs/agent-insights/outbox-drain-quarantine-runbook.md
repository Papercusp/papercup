# The promised-but-missing WI-3896 quarantine runbook: manually clearing a poison outbox row (mig 645)
URL: /internal/docs/agent-insights/outbox-drain-quarantine-runbook

outbox-drain.ts's poison-row quarantine (WI-3896) was in-memory only — a restart forgot it and re-timed-out the same row every cycle, and the federation-drain-reconcile watchdog counted quarantined rows toward its stall metric forever, perpetually refiling "Federation stall" bugs for a harness that was actually healthy. Mig 645 persists quarantine + excludes it from both the drain SELECT and the reconcile metric; this is the "root-cause + manually clear via the runbook" runbook every WI-3896-era comment promised but never wrote.

## Symptom

A `federation-drain-stall` bug (title `Federation stall: <harness> outbox
undrained <N>s (<M> row(s))`, the EI-681 class) keeps getting refiled for the
SAME harness — every time a human/agent investigates, closes it as
"self-resolved" (fresh writes ARE draining within seconds), a new one appears
hours later citing an ever-larger `undrained <N>s` age. Live instance
(papercusp, 2026-07-20): the harness's `substrate_outbox` for `table_name =
'engineer_issues'` fluctuated 0 → 11,576 → 7,554 undrained rows within
minutes (proving the drain was actively working), while a handful of rows
captured **2026-07-10** (already `state='done'`) sat undrained with an age
that only ever grows.

## Root cause

Two separate, compounding gaps in `outbox-drain.ts`'s WI-3896 poison-row
quarantine:

1. **Quarantine was in-memory only.** `quarantinedIds` is a plain `Set`
   closed over inside `startOutboxDrain`. This dev box's hosts self-recycle
   every \~5-8min; every recycle forgets the quarantine and
   `drainOutboxOnce`'s `SELECT … WHERE drained_at IS NULL ORDER BY id` fetches
   the SAME poison row(s) first *again*, races them against
   `ROW_STAGE_TIMEOUT_MS` (45s) up to `ROW_QUARANTINE_THRESHOLD` (3) times
   (\~135s) before re-quarantining — repeated on every single restart, forever,
   burning drain throughput that real candidates behind it needed.
2. **The reconcile counted quarantined rows as "stalled."**
   `load-drain-stats.ts` computed `undrainedCount` / `oldestUndrainedAgeMs`
   over every `drained_at IS NULL` row, with no distinction for a row the
   quarantine mechanism had already triaged and *deliberately* left undrained
   (quarantine is "a triage decision, not a silent data drop" — see the
   WI-3896 doc-comment on `ROW_STAGE_TIMEOUT_MS`). So a single permanently
   quarantined row kept `plan-drain-reconcile.ts`'s stall detector reporting
   "unhealthy" **forever** — the age is `now - ts`, strictly increasing — even
   while the harness was, in fact, fully healthy and draining fresh writes in
   near-real-time. Every code comment near the quarantine logic promised
   "root-cause + manually clear it via the runbook" — but no such runbook
   existed until this doc.

Note: on papercusp specifically, the \~9-day-old backlog turned out to
*eventually drain on its own* (once whatever transient condition — load,
federation-topic join timing — cleared) rather than staying permanently
poison; but the quarantine-refiles-forever defect is real and independent of
whether any *given* row turns out to be truly permanent or eventually
recoverable — a row can sit quarantined for days before a retry would have
succeeded, and the metric bug means the alert never stops regardless.

## Fix (mig 645 + companion code, 2026-07-20)

* **`substrate_outbox.quarantined_at`** (nullable bigint, epoch-ms): stamped
  the moment a row crosses `ROW_QUARANTINE_THRESHOLD`.
* `startOutboxDrain` now **seeds** `quarantinedIds` from any already-persisted
  `quarantined_at` rows at boot (no re-discovery dance after a restart), and
  **persists** a new quarantine the moment it's decided (fire-and-forget,
  best-effort — an in-memory quarantine still protects the current process
  even if the persist write fails).
* `drainOutboxOnce`'s SELECT batch now excludes `quarantined_at IS NOT NULL`
  rows directly (read resiliently via `to_jsonb(...) ->> 'quarantined_at'`, so
  a pre-mig-645 outbox degrades to "nothing excluded" instead of crashing) —
  freeing full batch capacity for real candidates instead of re-fetching +
  skipping known-poison rows every pass.
* `loadSubstrateDrainStats` now excludes `quarantined_at IS NULL` from its
  undrained/oldest-age computation, so `federation-drain-reconcile` only
  alerts on the REAL, actionable backlog.

## The manual-clear runbook (the part every comment promised)

Once you've identified a row is quarantined (`SELECT id, table_name, key, ts
FROM harness_shared.substrate_outbox WHERE harness_slug = '<slug>' AND
quarantined_at IS NOT NULL`), root-cause WHY it hangs (epoch-encrypt / hive
key resolution / hypercore append — check whether the harness's federation
topic join / epoch-key state is what it should be), then:

* **(a) Accept it will never federate** (e.g. a long-superseded row, or the
  content simply doesn't matter): do nothing — it's already excluded from
  every health/backlog metric, permanently, by design.
* **(b) Retry it** (you believe the underlying condition has cleared): `UPDATE
  harness_shared.substrate_outbox SET quarantined_at = NULL WHERE id = <id>`
  — the next drain pass re-attempts it fresh from a clean slate (the
  in-memory `rowTimeoutCounts` for that id was never touched by the manual
  clear, so it gets a full new `ROW_QUARANTINE_THRESHOLD` allowance before
  being re-quarantined if it's still genuinely poison).

## The generalizable lesson

**A "leave it undrained on purpose" triage mechanism (quarantine, dead-letter,
skip-list, …) must ALSO be excluded from whatever health/alerting metric
measures "how long has this been undrained/unprocessed" — or the alert
becomes a permanent, ever-worsening false positive for exactly the condition
the triage mechanism was built to make safe to ignore.** Persisting
in-process-only mitigation state across restarts is the same lesson from the
other direction: a fix that only survives until the next restart re-pays its
own cost (here, \~135s of wasted retries) every single cycle, forever, on a
host that recycles every 5-8 minutes.

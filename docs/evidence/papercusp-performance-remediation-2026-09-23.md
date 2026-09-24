# Performance remediation evidence

Plan: `papercusp-log-performance-remediation-2026-09-23`.
Driving work: WI-10002801. Measurement/producer work: WI-10002823 (P-001).
This is current-build implementation evidence, not final shipment acceptance.

## Measurement profiles

The original [audit](../audits/application-performance-audit-2026-09-23.md)
preserves SQL counter intervals, profile paths, native run/build identities and
metric writer references. Those historical means, maxima and individual UI
interactions must not be compared with new p95 values as a speedup.

The frozen observational baseline below covers **[2026-09-23T22:00:00Z,
2026-09-23T23:00:00Z)**, workspace `papercusp-workspace`. It contains naturally
occurring requests with uncontrolled concurrency and cache state. It is useful
for prioritization and population attribution; it is not a controlled benchmark.
Do not generate production traffic merely to enlarge the sample.

Controlled comparisons for P-002 through P-008 use the existing project fixtures,
test databases, spawner seam and native WDIO suite. Before changing each path,
record its fixture/source hash, immutable subject build, host, transport and
request list. Reuse that exact corpus and list for both sides. Use:

- **normal:** concurrency 1; separate cold and warm cache windows; at least 100
  completed calls per backend workload on each side, retaining failures.
- **burst:** concurrency 8 over the same request list and corpus; record queue
  recovery, cancellations and obsolete work. Run in an isolated test instance.
- **native:** existing packaged-desktop scenario, repeated cold/warm runs;
  retain individual outcomes and missing metrics. Budgets remain popup 1500ms,
  FCP 3000ms and LCP 4000ms. Browser results cannot replace native acceptance.
- **sustained:** after integrating the source lanes, a bounded 30-minute normal
  workload plus the isolated burst. This is P-009 acceptance, still outstanding.

Changing fixture population, transport or cache policy creates a new profile,
not a comparable second window. No controlled speedup is claimed here.

## Frozen tool observations

Milliseconds from `tool_invocations.duration_ms`. The writer is
`packages/operator-core/lib/projected-tool-deps.ts`: dispatch duration is supplied
by the caller and `invoked_at` records settlement before buffered persistence.
Errors use the existing rollup definition `status NOT IN ('ok','refused')`.
The following selected groups share serving host `port-3070`, build
`80521d598f`; transport is MCP except memory search (`in_process`).

| Tool | Completed | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| activity:report | 1209 | 1152 | 113.0 | 239.0 |
| work_items:get | 147 | 0 | 202.0 | 6985.3 |
| sessions:search | 27 | 0 | 1089.0 | 7032.3 |
| plans:get | 24 | 0 | 184.0 | 439.1 |
| coord:orient | 19 | 0 | 9741.0 | 17891.9 |
| memory:search | 10 | 0 | 2136.5 | 5650.2 |

Groups below 100 observations are exploratory. The fast activity-report numbers
mostly measure rejected calls, not successful useful work. Background-host groups
were returned separately under builds `509f7b0b56`, `d1605eb516`, and `42936cb124`;
they are not pooled with these request-host measurements. The query returned the
12 largest groups, so this table is a named subset, not a complete tool census.

Reproduction SQL (read-only, bounded):

```sql
SELECT tool_name, transport, serving_host, serving_build_sha,
       count(*)::int AS n,
       count(*) FILTER (WHERE status NOT IN ('ok','refused'))::int AS errors,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM harness_shared.tool_invocations
WHERE workspace_id = 'papercusp-workspace'
  AND invoked_at >= '2026-09-23T22:00:00Z'
  AND invoked_at < '2026-09-23T23:00:00Z'
  AND tool_name IN ('coord:orient','memory:search','sessions:search',
                    'work_items:get','plans:get','activity:report')
GROUP BY tool_name, transport, serving_host, serving_build_sha
ORDER BY n DESC LIMIT 12;
```

The selected names are logical calls, not dispatch-wrapper names. For a broader
census, reuse `dispatchWrapperExclusionPredicate` from the existing rollup.

## Frozen route and query observations

Same fixed window/workspace, grouped by route template and semantic status `ok`:

| Route | Recorded calls | p50 ms | p95 ms |
|---|---:|---:|---:|
| /agent-mcp/console/bootstrap-su/heartbeat | 8664 | 6.0 | 337.9 |
| /:transport | 7026 | 3.0 | 5.0 |
| /agent-mcp/mid-turn-context | 2182 | 7.0 | 5010.0 |
| /desktop/version | 390 | 0.0 | 1.0 |
| /ui/presence | 270 | 3.0 | 13.6 |
| /health | 232 | 0.0 | 1.0 |

Writer: `packages/operator-core/lib/endpoint-route/telemetry.ts`, elapsed wall
time from route start to completion. Definitions may sample or disable recording;
these are recorded executions, not guaranteed total traffic. This ledger does
not identify build/host, so cross-build route comparisons remain unqualified.
Read query: the same time/workspace predicates above against `route_invocations`,
group by `path,status`, order by count descending, limit 6. Other routes and
statuses are outside this bounded result.

The audit's fixed **22:04:51–22:05:06Z** database interval remains the SQL baseline:
session-search statement `3939267458425839640`, 4 calls, 19899.153ms total,
4974.788ms mean. Memory lexical statement `3802103855579733629`, 5 calls,
3265.271ms total, 653.054ms mean. These are overlapping database execution costs,
not CPU shares or p95. Recheck actual statements/plans and the same fixtures in
their owning lanes before optimizing. Loop profile-trigger p95 951.1ms is a
selected saturated window, not a normal-workload distribution.

Native baseline remains the audit's identified packaged runs: `fd4e0ee48511`
at 2026-09-23T06:43:44Z (popup 4364ms, FCP 3026ms, LCP 4565ms), and
`2633f4772ec2` at 14:43:45Z (popup 1798ms; an expected Web Vitals metric missing).
No missing metric is zero or a pass.

## P-001 producer and detector

Root cause: the performance history's only producer was the improvement watchdog,
which was owner-paused on August 24. Its last tick and last backend snapshot align
at 2026-08-24T16:46:53.652Z, while system-health ticks continued. The performance
flag was enabled in the checked processes. The watchdog pause is preserved.

The existing active system-health sweep now calls the existing collector only
when its latest persisted row is at least 15 minutes old, then checks whether
persistence advanced. It does not dispatch the learning watchdog's findings.
Warnings are rate-limited, including read failures. No new routine, flag, table
or manual production sample was introduced.

The Infra panel independently reads the existing snapshot series. At two missed
intervals it reports `warn` and the last persisted timestamp even if the producer
never runs. Missing history warns; unreadable or future timestamps are unknown;
the explicit performance-rig kill switch remains distinguishable as disabled.
The status and metric use the existing Health/Overwatch model.

Natural backend samples observed during this work:

| Persisted timestamp (UTC) | Loop p95 ms | PG connection saturation % |
|---|---:|---:|
| 2026-09-23 23:46:25.936220 | 21.3 | 40.8 |
| 2026-09-24 00:02:54.917852 | 89.2 | 44.9 |

Read directly from `perf_regression_snapshots`, scoped by workspace and ordered
by `captured_at`. The loop metric is the collector process's current histogram;
PG saturation is the existing `pgHealth()` measure. Null orphan rate with zero
dispatch samples remains unknown. These two samples establish resumed
persistence; they do not establish a general latency improvement.

The active `papercusp-bg-host.service` was inspected at 00:05Z: PID 2790598,
started 23:44:07Z, working directory canonical `papercusp/apps/operator`, bundled
Node entry `dist-host/hono-host.mjs`, port 3271. That bundle contains the new due
collector path. This background/current-build plane is distinct from deployed
green request host :3070. The later Infra surface addition still needs serving
runtime readback; no final deployment is claimed.

## Verification and remaining acceptance

The project's `npm run test:file -- ...` router selected four unit files plus
the integration config for `perf-regression-producer.integration.test.ts`:
**407 unit tests + 6 integration tests passed, zero skipped**, finishing
2026-09-24T00:15:30Z at HEAD `8dc662ace4b400befaed20cd54e33873f49bda24` with local
changes. The integration test uses an injected timestamp store and clock, calls
the real producer/independent reader/Infra status and summary, and does not mutate
production data. Its durable test run is **19210434**, bound to `PERF-P-001@1`
by evidence row **10747**. The changed source files pass scoped semantic
typechecking; 24 import-graph diagnostics remain outside the requested files.
This is not a whole-tree typecheck or a release-gate verdict.

Remaining for P-001: read back the new Infra metric on the current running build,
bind operational evidence to `AUTO-BAR-R-1-P-001@1`, then close with evidence.
P-002..P-009, controlled before/after workloads, independent final acceptance,
the sustained observation and final shipment remain open.

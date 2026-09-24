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

At 2026-09-24T06:16:20Z, a read-only call to the existing
`readSharedSnapshot('system.health', 'papercusp-workspace', 1, 3600000)`
returned a snapshot computed at **06:15:18.879Z**, evaluated at
**06:15:10.308Z**, with `panels.infra.data.performanceHistory` equal to
`{ status: 'ok', lastCapturedAt: '2026-09-24T06:04:16.218Z', ageMs: 659225,
note: 'lastCapturedAt=2026-09-24T06:04:16.218Z' }`. The shared snapshot was
about 62 seconds old when read. This verifies the new field on the current
background-host snapshot and a naturally persisted recent sample; it is one
runtime read, not a duration or availability distribution. The pipeline-position
read for `system-health/compute.ts` identified the current background-host build
as `ff35678573` and staging operator build as `8702d166fa`, both containing the
field. The green release operator at `80521d598f` did not yet contain that code,
so final deployed-plane verification remains open.

The `PERF-P-001@1` integration test binding is current. An operational binding
for `AUTO-BAR-R-1-P-001@1` records the current-build readback above; its source
measurement includes this report, so it must be remeasured when this paragraph
changes. The rubric itself is still awaiting independent vetting.

For the P-001 intent-tested coverage census, the real project integration suite
`perf-regression-producer.integration.test.ts` exercises six distinct outcomes:
two missed intervals produce an Infra warning with the last timestamp without
calling the producer; a failed insert remains overdue until a later persisted
sample; no series warns with `lastCapturedAt=never`; unreadable storage stays
unknown; a future timestamp stays unknown; and the explicit kill switch stays
disabled without querying storage. The first two cases are counterexamples to
an assumed healthy producer and would fail their assertions if the alarm or
persistence check were removed. The suite passed all six cases in recorded run
**19210434**, with zero skipped. This covers the clause's producer, persistence,
reader and Infra presentation path at the intent-tested L3 rung. It does not
claim a mutation probe was run.

P-001 item closure remains gated on the plan's spec-adequacy certification.
P-002..P-009, controlled before/after workloads, independent final acceptance,
the sustained observation and final shipment remain open.

## P-002 current-build compatibility verification

The existing fixes in EI-24045346484356708 (search) and EI-24022555028936462
(hook schema) were reused. No replacement search or reporting implementation
was added. At HEAD `8dc662ace4`, the named schema-contract and search integration
files were clean before/after the real test router: **6 + 53 tests passed**, zero
skipped. Durable runs: **19214023**, **19214026**. The wider shared tree was dirty.

One additional regression in the existing `activity/activity.integration.test.ts`
parses a generation-bearing `glance_stale` payload, invokes the real report
handler against isolated Postgres, verifies its stored activity row and checks
the payload forwarded to the mocked bundle builder. The suite's **21 tests
passed** at `a9e70782dc445de8678ce6d6440b509edcd7d0a3`, named file clean, durable
run **19214046**. This extends the earlier schema-only guard through the write
and bundle-dispatch path.

The actual staging serving tool accepted both a glance-only payload and one
with the returned generation plus `glance_stale:true`. The latter returned
`ok:true`, activity id `6229328`; tool invocation **29298348** records
`port-3170`, build `8dc662ace4`, status `ok`, duration 34ms. This is a single
compatibility result, not a latency percentile. The installed hook source's
generation/glance-stale construction was read directly.

**The green release runtime remains different:** contemporaneous installed
hook invocations **29298345** and **29298520** on `port-3070`, build
`80521d598f`, still report `invalid-input`. P-002 must not claim deployed hook
compatibility until the corrected build reaches that serving plane.

Staging session search returned two results for `performance audit` (invocation
**29298514**, `port-3170`, `8dc662ace4`, 3100ms). Its bundle contains the bounded
50,000-row compact-token fill. An equivalent index-only primary query for the
same dictionary terms selected **Bitmap Index Scan: session_turns_tsv_idx**.
The existing integration tests cover primary/fill separation, literal-token
recall, full primary result sets, and coverage-graded behavior.

A second bounded diagnostic around a scoped `performance producer overdue`
search observed highlighted index-only statement **-5382584474920240673**
advance once (31.117ms accumulated execution delta), along with other shared
traffic. Its recorded SQL ends with `AND text_tsv @@ q.andq` and has no
substring OR arm. The old statement **3939267458425839640** also advanced in
these windows; the ledger is shared across hosts, so its increment cannot be
attributed to this staging call. This confirms coexistence, not elimination of
the old deployed query. Final serving-runtime evidence remains required.

## Acceptance contract repair

The plan's generated acceptance rubric lacked METHOD and structured checks for
all nine criteria. A concrete amendment is saved on **WI-10002801,
thread-post:1142917**, with exact apply payload and preview approval JSON.
It preserves the original outcomes, falsifiers, scope and evidence planes,
adds runnable checks and pins the existing clause proof layers. The preview
confirms no transition to manual-only proof. A live, eligible independent
reviewer was asked to countersign the full method text as well as the hashes;
the amendment is not yet applied. Source completion is not final certification.

## P-003 cancellation substrate progress

After the desktop-terminal interruption, the predecessor's last calls were
read-only investigation; no edit or test was in flight. Work resumed on
WI-10002825. The generic `process:exec` handler now reuses the sidecar's
`spawn:cancel` channel, scopes request IDs per connection, and aborts a
connection's processes when it disconnects. Cancellation acknowledgements mean
the signal was requested; the original execution result waits for child close.

The process runner accepts local control callbacks, prevents spawning after an
abort during admission, and no longer fabricates completion after a fixed
20-second timeout. Kill timers are removed at child close before asynchronous
admission settlement. Observer callback failures cannot own the child lifetime.
The IPC client's explicit close rejects its pending calls through its existing
teardown path.

Six real-process/Unix-socket integration cases cover graceful cleanup before
settlement, two clients sharing a numeric request ID, disconnect cleanup,
admission cancellation, escalation when SIGTERM is ignored, and observer failure.
They pass along with the existing IPC and Git-sidecar suites. Durable runs:
**19218407**, **19218405**, **19218406**, at
`ce8c9311f7ecd58cb1ba1bf92cf62edfdc6344a3` with local changes. Final scoped semantic
typechecking of all four changed source/test files passes; 24 diagnostics remain
outside that requested set. `git diff --check` passes.

**This is preparation, not the P-003 performance result.** Signal-bearing
`runGitBounded` calls still take the local path. Before routing them through the
sidecar, transport loss must not cause an unsafe local retry or premature
repository-lock release while the remote child may still run. Descendant
termination, profiler overhead and comparable launch/loop benchmarks also remain
open. No speedup or final P-003 acceptance is claimed.

## P-005 resumable-session reads

`listResumableSessions` filtered candidates by converting each complete
`adv_sessions` row to JSON to read optional `port_status`. That conversion also
serialized the launch payload. The scored/ranked stages then carried full
metadata and converted the row again to recover the optional harness scope.

The existing query now checks `pg_attribute` once per call, uses the direct
status column when present, and accepts legacy rows when the column is absent.
Absence is not cached, so a completed rollout is observed on the next call.
Ranking carries only identity, backend and activity; metadata is hydrated after
selection. No table, index, feature flag or parallel cache was added.

Bounded read-only live probes on September 24 separated these costs:

| Probe | Observed execution time |
|---|---:|
| Recent-300 filter using whole-row JSON | 2275.154, 1830.139 ms |
| Equivalent direct-column filter, interleaved | 16.263, 15.200, 14.832 ms |
| Full original listing | 2918.519 ms |
| Direct filtering with metadata still before ranking | 1194.302, 938.348 ms |
| Direct filtering with metadata after selection | 79.435 ms |

These are exploratory `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` executions on a
changing live population, not paired production percentiles. A separate
single-statement snapshot compared the complete original and revised results
with `EXCEPT ALL` in both directions: 37 rows each, zero differing rows.
The broad picker scope is deliberately cross-workspace.

The existing database integration suite now exercises pending/failed ports in
every candidate arm, cross-workspace results, a genuinely absent port column
followed by its return, exact-id recovery, activity ordering and per-backend
floors. An eight-reader burst returns the same fixture rows. The retained
1000-row fixture has 16384 payload characters per row; 100 alternating calls
per filter measured p50 13.490 ms (legacy) and 0.803 ms (direct) in the final
run. That benchmark isolates candidate filtering, not the complete HTTP route.

At 07:59:28Z, all 75 tests across the four focused `adv-sessions` suites passed,
zero skipped, at `30b6cf0d98` with local changes. Scoped typechecking found no
diagnostics in the changed files; 26 diagnostics remained elsewhere in the
import graph. `git diff --check` passed. An earlier new benchmark fixture failed
because a JSON constructor needed an explicit text cast; it was fixed before
the final run.

P-005 remains open for coordination/orientation and Learning/roster stage
profiling, complete current-build acceptance, and the plan's controlled full
workload evidence. No shipment or whole-plan completion is asserted here.

## P-005 orientation core-read overlap

Existing invocation `29360561` completed at 2026-09-24T07:44:47.458Z with
`duration_ms=7295`, serving build `d06ec6cafb`. The same owner's preceding
`in_process` rows were assignments `29360536` (2355ms), list `29360544`
(1480ms), inbox `29360545` (373ms), and observe `29360550` (497ms).
`recordInvocationImpl` stamps completion time; these timestamps and the source
confirm sequential execution in this one request. They do not establish a
production latency distribution or a controlled before/after comparison.

`composeOrient` now starts its existing bounded assignments promise after fleet
scope recovery and joins it at result assembly. The independent backlog, inbox
and eligibility reads proceed while it is in flight. The assignments promise
still publishes the early aggregate-fallback snapshot on settlement. Existing
scope recovery, claim filtering, deadline, failure and delta semantics remain
covered by the orientation suite; no cache or durable surface was introduced.

The new regression failed before the change: only `fleet:assignments` had
started while the backlog should have been in flight. The final test exercises
one and eight concurrent readers with deterministic leg delays (100ms
assignments, 80ms list, 30ms inbox, 20ms observe) and asserts complete result
parity at 130ms, including exclusion of an unavailable item. This is a simulated
dependency schedule, not a measured production speedup.

Verification at HEAD `431b0e2a22` plus local source/test edits:

- `orient.test.ts`: final 215 passed, zero skipped, 08:27:26Z.
- `orient-obligations.integration.test.ts`: 7 passed, zero skipped, 08:26:14Z.
- Scoped typecheck: zero diagnostics in the two changed files; 23 diagnostics
  elsewhere in the loaded import graph. No whole-project typecheck claim.

Learning/roster stage measurements and complete current-build acceptance remain
open on WI-10002827.

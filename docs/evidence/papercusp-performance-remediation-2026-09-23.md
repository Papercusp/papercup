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

## P-005 Learning observations

Historical `sync-slow` logs identify `learning.observations.summary` with empty
query/filters (2177–2951ms examples on 2026-09-23) and paged observations.
The writer `sync-resolver/resolve-observability.ts` logs elapsed resolver wall
time above 2000ms, with a per-query 60-second suppression window. These selected
warnings are neither complete traffic counts nor latency percentiles.

The shared `observationScopedCte` materialized every scoped observation's body,
title, id, timestamp and expanded refs, even when the summary consumed only
kind/scope/role/confidence facets. Default page reads also materialized the whole
corpus before sorting/limiting their display rows. The existing CTE now projects
only fields required by a summary predicate, retaining text and refs for search
and refs for plan filters. Pages allow CTE inlining so the database can push down
filters/cursors and defer display projection until after the limit. Summary
facet scans still share one materialization. No cache, schema or flag was added.

Read-only live EXPLAIN observations on 2026-09-24:

| Query | Existing | Revised | Temporary blocks written |
|---|---:|---:|---|
| Default summary, interleaved probes | 1783.348 / 2200.304ms | 683.561 / 447.872ms | 8557 → 0 |
| Default 201-row page | 1413.162ms | 384.441ms | 8556 → 0 |

The summary probes each scoped 138,260 rows. A single-statement `EXCEPT ALL`
comparison returned 35 summary rows per version with zero differences; a
separate snapshot returned 201 page rows per version with zero differences.
These changing-live-data probes isolate the projection cost, not production
percentiles. An initial exploratory query used `id` instead of the view's
`issue_id` and failed; the table above includes only corrected successful runs.

Permanent real-Postgres guards in
`learning-observations-query.integration.test.ts` capture the production query
and inspect its executed plan. The summary guard failed before the fix with
50,205 unnecessary reference expansions; it now observes zero for an unfiltered
summary while confirming reference search still expands refs. The page guard
bounds expansion to the 200 display rows plus the next-page sentinel. Other
cases preserve body/ref/plan search, cross-facet predicates, exact totals, zero
matches and cursor termination; eight simultaneous summaries return equal data.

The same test reintroduces only the legacy unused columns into the captured
default-summary query and alternates 100 calls per version on the same 50,205-row
fixture. Every complete result equals the reference. Final warm SQL measurements
at stable HEAD `bb78d46e51`, 2026-09-24T08:42–08:43Z:

| Variant | p50 ms | p95 ms |
|---|---:|---:|
| Legacy projection | 215.711 | 335.447 |
| Revised projection | 95.487 | 104.106 |

This is a warm, isolated SQL fixture benchmark. Cold route latency, transport,
queue recovery and sustained production workload are not measured by it.

Final three-suite run: 23 passed, zero skipped, clean named paths and stable
HEAD `bb78d46e51`, completed 08:43:30Z. An earlier passing run crossed an
auto-commit and was repeated to obtain this stable provenance. Scoped typecheck
reported zero diagnostics in the two changed files and 23 elsewhere in their
import graph. Roster source-stage profiling and complete current-build acceptance
remain open; this is not a shipment claim.

## P-005 roster and served-read observations

The existing roster already batches source joins and enrichment joins, resolves
transcript freshness concurrently, and shares reads through a 2s fresh/15s stale
cache. A fresh diagnostic process with the runtime flag override store installed
measured the existing source joins concurrently at 100–134ms. Complete merge
samples with and without transcript decoration were 127ms and 192ms respectively;
their order/cache state differs, so subtraction would not isolate decoration cost.
The existing roster cache measured 108.7ms for its first read, 0.025ms for a fresh
hit, and 110.7ms for eight concurrent readers after clearing only this diagnostic
process's cache. All eight shared the identical result object, with 73 active
rows and no degraded fields. Log: `.papercusp/scratch/bash-7d7bb319-406.log`.
An earlier probe omitted runtime flag setup; it is not the basis for these values.
No roster source change was justified by these probes, and they do not explain
the historical primary-active-leg six-second timeouts under other conditions.

The existing REST audit harness was then used against `:3170`, whose `/api/health`
reported `sha=0f1d0bd04e`, `bundleStale=null`. Two sequential observed passes:

| Query | First HTTP ms | Second HTTP ms | UTF-8 response bytes, second pass |
|---|---:|---:|---:|
| advRoster.list | 1120 | 7 | 264540 |
| plans.attentionCounts | 5 | 2 | 232 |
| plans.attentionRefs | 261 | 24 | 196613 |
| learning.observations.summary | 347 | 339 | 1767 |
| learning.observations | 9 | 8 | 121228 |

These are HTTP wall times from two requests per query, not percentiles or proven
cold/warm worker states. The generic audit still flags roster bytes above 250KB
and Learning summary wall time above 150ms. This is backend read evidence, not
a completed desktop user journey. Log: `.papercusp/scratch/bash-4b6546bd-dbe.log`.
The initial diagnostic mistakenly requested `/health` and received HTML; it
aborted before the query audit. The corrected probe uses `/api/health`.

### Measurement repair

While reusing that harness, EI-24132496490732089 corrected two defects: REST and
in-process audits counted UTF-16 string units as bytes, and the in-process model
omitted the route's timing envelope. Guards compare against actual
`Response.arrayBuffer()` bytes and the real REST handler under a fixed clock.
Before repair, a 375049-byte response was reported as 125049 and missed its
budget violation; after that correction, route calibration caught 112 omitted
timing bytes. Final tests 19266588/19266589: 24 passed, zero skipped, at
`86bf19b66e` plus local source edits. Scoped typecheck: zero diagnostics in three
changed files, 23 elsewhere. The item is recorded done with proposed completion
authority until git-sync commits its exact source blob; the settlement reconciler
owns that promotion. No deployed-fix claim is made here.

A subsequent read found the exact verified source blob committed at
`bf59109b709c0da8033899ba6cc4de0107b89380`; all three declared working-tree blobs
matched their committed counterparts. The completion record still retained its
older proposed stamp at that read, so automatic settlement remains unverified.

### Exact warm-count clause

PERF-P-005@1 requires p95 ≤250ms across 100 completed warm reads. The existing
attention fixture now reports and asserts that percentile. Run 19267334 passed
14 tests at `4fe29369c7` plus the local test change: frozen profile
`attention-1000-items-2000-ascii-body-v1`, workspace `ws-attn`, concurrency one,
100 calls per mode, counts p95 0.176041ms, cold count construction 6.762740ms.

A permanent counterexample injects a 275ms wait at the real handler's metadata
callback in six of 100 completed warm reads. It independently counts the six
over-budget observations and confirms the same budget assertion rejects them
(observed p95 275.197474ms), while the source is still read only once. This is a
passing negative-scenario test, not a mutation-probe process; no production
source was mutated and the clock was real. Bindings 11236/11237 attach the run
and counterexample to PERF-P-005@1. The evaluator passed and emitted card
EI-24133989725260512; independent grading audit remains pending. This does not
close P-005 or establish shipment.

### Fresh-client and concurrent SQL verification

Run 19270264 added a separate real-Postgres case to the existing Learning
integration suite. It captures the current production summary query and restores
only the legacy unused projection for comparison. Both variants read the same
50,205-row fixture. Four rounds alternate variant order; each creates a new
eight-connection pool, measures its first request, then starts eight simultaneous
requests. Every complete result equals the current-query reference.

| Variant | First request on a fresh pool, range ms | Eight-reader completion, range ms |
|---|---:|---:|
| Legacy projection | 215.8–246.3 | 239.5–255.9 |
| Current projection | 103.4–129.7 | 131.2–151.1 |

The database and OS caches are warmed; only the client pool starts fresh. This
does not measure a cold database, HTTP transport, production p95 or desktop
rendering. The focused invocation passed the new case, with the seven unchanged
cases excluded by `-t`; their earlier proof remains separately recorded above.
Provenance: stable HEAD `2bf2467436` plus the local test addition, finished
2026-09-24T09:36:25Z. No application source changed in this verification step.

The warm-count card EI-24133989725260512 now has a passed independent audit,
EI-24134111853441553, stamped 2026-09-24T09:21:22Z. P-001's separate card
EI-24123000311780258 failed its independent audit EI-24133643922268786: replay
changed freshness from pass to fail and reported evaluator-build drift. That
failure remains unresolved and must not be described as pending or passed.

### P-001 evidence-scope correction

The failed audit correctly detected two stale bindings. Their measured moved
path was this whole-plan report; the implementation and test hashes had not
changed. Bindings 11264/11265 replace the counterexample/census bindings with
the complete implementation set already tracked by test binding 10747. The
six-outcome census is preserved in the immutable binding details. Run 19210434
remains the executed proof; it was not rerun. The old failure stays in history.

The corrected unscoped evaluator passes PERF-P-001, and certification under
the plan's governing `plan-class-bugfix` filed EI-24135395646362393. Its fresh
independent audit subsequently passed at 09:46:47.402Z via
EI-24135710606333042 (re-read at 09:56Z). This
supersedes the earlier card, not its historical failed audit.

A fresh bounded read of the existing shared Health row returned snapshot
`computed_at=1790242945921`, `evaluatedAt=1790242938485`, producer version 1,
and performance history `{status:'ok', lastCapturedAt:'2026-09-24T09:38:26.971Z',
ageMs:233293}`. The operational binding persists these values and its query
directly, with implementation-only source dependencies, replacing binding
11011. This is current-build shared-snapshot evidence, not final shipment.

The new Learning concurrency test also passed the scoped TypeScript gate
(`LINT_TSC_RESULT`, exit 0, HEAD `2bf2467436`). The full compiler reported
diagnostics elsewhere; this does not claim a clean whole-project typecheck.

## P-003 descendant cancellation

EI-24136230241945593 measured another cancellation gap in `process:exec`.
`sidecar-exec-process.ts` signalled only the direct child. A command that spawned
a helper could exit on SIGTERM while the helper retained its output pipes;
the original request then never completed. The new real-process regression
failed against the old implementation at its 90-second integration timeout
(run 19273899); teardown explicitly killed the recorded helper PID.

The existing execution seam now creates a referenced POSIX process group, using
the same group-signal pattern already used by capability/bash. Abort, idle and
hard-deadline termination signal that group. Escalation stays armed after the
parent exits, and admission settlement waits until the group is gone. A failed
group-liveness probe stays unverified and cannot fabricate an exit receipt.
Windows retains direct-child behavior; this evidence was collected on Linux.

Two permanent cases launch a helper that ignores SIGTERM, with inherited or
independent stdio. Both assert the helper is dead at admission settlement and
before the caller receives its result. This covers both a helper retaining the
output pipe and one outliving a parent whose pipes have already closed.

The full cancellation/Git group passed **28 tests, zero skipped** at stable
HEAD `5623ff3768` plus the local fix (runs 19273906/19273907/19273908). After
adding the settlement-time observation, both new cases passed at stable HEAD
`48ca7f163b` with clean named paths (19273911); the other nine integration cases
were deliberately filtered on that focused rerun. A preceding focused run
crossed an auto-commit and is not the final provenance reference. Scoped
TypeScript checking of the two edited paths passed; unrelated diagnostics
remain elsewhere. `git diff --check` passed.

The older intermittent progress test passed its targeted recheck and this full
run, but its historical failure cause is still unmeasured. No flake-resolution
claim is made. Mutating Git remains on the local path: the separate transport-loss
exit fence, profiler-start overhead and full multi-repository performance proof
are still P-003 work. This is source/current-build verification, not shipment.

### Normal parent exit must also wait for helpers

EI-24137289590776306 extends the same exit-proof invariant to a parent that
exits normally. The previous implementation waited for the process group only
when `terminating` was true, and ignored later cancellation once `childClosed`
was true. A helper with independent stdio could therefore remain alive after
admission settlement and the caller's result.

Three real-process regressions failed against that implementation (run
19273936): each observed `settled` where the helper was alive and the call
needed to remain `pending`. The cases cover eventual normal helper completion,
caller abort after the parent exits, and the absolute deadline after parent
exit. The same existing group-exit check now runs on every close; cancellation
and timeout guards remain active until the group is confirmed gone. No new
registry, tool or persistence surface was introduced.

The full lifecycle suite passed 14 tests, zero skipped (19273939), and the
Git-sidecar suite passed 16 tests, zero skipped. Both ran at HEAD `53172e7894`
with the local implementation change; the integration test was also locally
modified. Each new case observes helper death both at admission settlement and
at caller completion. This is Linux process evidence; Windows still uses the
direct-child contract. It does not establish transport-loss recovery or shipment.

### Shutdown waits for active requests to finish

EI-24137972449455522 found a distinct lifetime boundary in the server shutdown
handler. It aborted request controllers and destroyed sockets, then invoked
`process.exit(0)` from `server.close()` without waiting for those requests.
Closing network sockets does not establish command termination or admission
settlement. A regression using real IPC and a real child failed on the old
server (19273997): the intercepted exit call occurred while execution was still
pending. Only `process.exit` was intercepted, to keep the test runner alive.

Shutdown now reuses the active controller set as the drain condition and exits
after both socket closure and request completion. Signal handlers remain
installed while draining so a repeated SIGTERM does not bypass cleanup. The
full lifecycle suite passed 15 tests, zero skipped (19274002), at HEAD
`53172e7894` plus local source/test changes. Scoped typechecking of the server
and test passed; diagnostics outside these files remain. This verifies the
server's exit decision and real child cleanup, not recovery from SIGKILL or a
lost transport response. Those failure modes remain P-003 work.

The final suite adds an idle-shutdown liveness check and asserts repeated
shutdown retains the signal handler until settlement, then removes it. It
passed **16 tests, zero skipped** (19274010) at stable `cb4aa8932b`, with the
named test path clean after the background commit. The prior 15-test run and
scoped typecheck above remain the source-change validation; this final run
strengthens lifecycle coverage without changing the server implementation.

### Profiler investigation: preserve V8 state with bounded overlapping recordings

This is an exploratory mechanism result, **not an implemented monitor fix**.
The prior probes (native transcript `01a0d245-47d2-7e13-9365-3a1b016fbac2`)
established that reusing an inspector Session, or switching to Node's direct
`v8.startCpuProfile()`, still paid substantial startup cost. On the same
25,000-function fixture, reused Session starts took 83–95 ms; the direct API
took 90–97 ms. Those probes did not retain an active native profile between
captures.

Node v25.9.0's bundled V8 source explains the distinction:
`deps/v8/src/inspector/v8-profiler-agent-impl.cc`, `startProfiling` constructs
`CpuProfiler::New` when `m_startedProfilesCount` is zero; `stopProfiling`
disposes it when the last recording stops. `Profiler.enable` alone retains no
native profiler. Source read:
https://raw.githubusercontent.com/nodejs/node/v25.9.0/deps/v8/src/inspector/v8-profiler-agent-impl.cc

At approximately 10:38Z, a fresh Node v25.9.0 process retained 25,000 distinct
`new Function` instances. It used one enabled inspector Session and captured
100 ms windows in order: ordinary, three overlapping, ordinary. A named
`console.profile` anchor remained active during the middle captures and was
ended before the final control. Ordinary `Profiler.start` calls took
142.04/143.96 ms and stops took 31.59/31.46 ms. Overlapping starts took
0.443/0.055/0.058 ms and stops 0.240/0.242/0.606 ms. First-sample deltas tracked
the ordinary startup cost, while overlapping deltas were 0.008–0.011 ms.
These five observations are a mechanism probe, not a production p95 claim.

A separate 12-round probe used 50 ms foreground captures and rotated the
anchor by starting its successor before ending its predecessor. The initial
anchor cost 108.04 ms; later foreground starts took 0.032–0.113 ms and complete
anchor rotations took 0.137–0.289 ms. At most two anchors overlapped, 13 ended,
and none remained after shutdown. The largest ended anchor had 49 samples and
2,021 serialized JSON bytes. After disconnect and explicit GC, heapUsed was
1,745,608 bytes above the pre-start measurement; this single delta is **not** a
leak test or a steady-state memory bound. Both probes ran in their own Node
process, with no profiling or configuration changes to a serving host.

Next: prove rotation, cleanup, capture fidelity, flag/safety-cap behavior,
failure cleanup and sustained memory/CPU cost in the project test framework.
If viable, extend the existing monitor's tick and capture seam rather than
adding a separate profiler service or timer. Continuous sampling overhead and
rotation delayed by a wedged loop remain explicit risks. No production code
has been changed for this candidate, and P-003 remains open.

### Project profiler experiment and cancellation repair (10:55Z)

The mechanism is now exercised by the canonical integration suite in
`packages/operator-core/lib/event-loop-profiler-overlap.integration.test.ts`.
It spawns an isolated Node v25.9.0 process retaining 25,000 functions, records
48 overlapping 60 ms work/idle windows between two ordinary controls, and
rotates the anchor after each window. Run **19278072 passed 2 tests, zero
skipped**, at `db87ad0325` with the new test uncommitted. Every capture contained
multiple samples of fixture work. All 49 anchors ended, with at most two live
at once. Ordinary starts took 103.03/81.36 ms; the median overlapping start
was 0.043 ms and median rotation 0.214 ms. The largest anchor held 84 samples
and 4,018 serialized bytes. Across four GC observations, heap varied by
12,712 bytes and RSS stayed at 109,133,824 bytes. This short fixture is not a
long-duration leak test or a bound during arbitrary main-thread stalls.

The initial fidelity assertion failed in runs 19278066/19278069 because V8
inlined `profilerFixtureWork` into `capture`: the actual missing-name profiles
contained sampled `capture`/`now` frames. The corrected assertion requires
multiple work-loop samples, including its sampled `performance.now` calls,
rather than insisting on an uninlined function name. No product regression
was inferred from those fixture failures.

The separate idle-cost experiment alternates five unprofiled and four active
500 ms windows, excluding profiler construction/destruction from CPU timing.
Active sampling consumed about 20 ms CPU per window versus 0.15–0.41 ms in
controls: approximately **4 percentage points of one core** additional CPU.
This explains why fast warm starts alone are insufficient acceptance evidence.
Continuous overlap has **not** been integrated into the serving monitor; its
steady cost, delayed rotation, dynamic gate and saturation safety still need
a satisfactory design and verification.

Review also exposed **EI-24139818636862387**: monitor stop did not cancel CPU
work. A pending async gate could resolve true after shutdown and start a new
capture; an active capture retained its duration timer and native sampler.
Two canonical counterexamples failed against old source in **19278080**:
shutdown still created the output directory, and cancellation was still
recording after 500 ms. The fix gives the monitor an AbortController, checks
shutdown after the gate, passes its signal through capture setup and sampling,
clears the duration timer on abort, disconnects in `finally`, and removes
cancelled partial writes before publication. It reuses the existing monitor
and capture function without adding a service, flag or recurring timer.

Verification: **54 lag-monitor tests (19278088) plus 9 profiler-safety tests
(19278087) passed, zero skipped**, at `db87ad0325` with local source/test changes.
Coverage includes a pending gate, active direct capture, active monitor
capture and pre-aborted capture, alongside existing dynamic-gate, safety-cap
and retention cases. Scoped typechecking of monitor, unit test and overlap
integration test passed with zero requested or imported diagnostics; diff
whitespace checks passed. The new EI's claim was admission-pending, so this
repair was implemented under the already-held WI-10002825/P-003 lane. Source
verification is not independent acceptance or shipment. Transport-loss fencing,
profiler startup remediation and the remaining P-003 performance proof stay open.

The lifecycle repair's completion subsequently succeeded with state **done**
and **committed** completion authority. This does not promote P-003 as a whole.

A follow-up parameterized experiment, **19280662**, passed **4 tests, zero
skipped**, at `befef09f6b` plus the edited integration test. Sampling intervals
were set explicitly through `Profiler.setSamplingInterval` before recording.
At 1 ms / 10 ms intervals respectively, median overlapping starts were
0.052 / 0.044 ms and median rotations were 0.244 / 0.191 ms; both versions
produced 50 useful captures and ended their 49 anchors. The 10 ms fidelity
fixture deliberately uses a 100 ms work interval (versus 30 ms at 1 ms) to
provide enough samples; these are not comparable throughput measurements.
The **idle CPU comparison does use identical 500 ms windows**: added median
CPU fractions were 0.0391 and 0.00808, or about 3.91% and 0.81% of one core.
The coarser sampler is promising but does not resolve the remaining lifecycle,
dynamic gate, saturation and long-duration recording-policy questions. It has
not been integrated. Scoped typechecking of the updated integration test passed.

### Loaded profiler comparison and delayed rotation (11:13Z)

The full isolated profiler suite now passes **5 tests, zero skipped** in
**19281929** (`befef09f6b` plus the edited integration test). Its additional
100 Hz fixture runs the same fixed arithmetic workload before, during and
after recording, verifies identical checksums, and rejects controls whose
median CPU times differ by more than 15%. The first attempted workload called
25,000 generated functions and kept optimizing between controls (349.77 ms
before versus 94.58 ms after); that comparison is **invalid for overhead** and
is not performance evidence. The stable replacement measured median CPU times
of 26.42 ms before, 27.93 ms active and 27.17 ms after, about 5.4% higher active
than the combined control median in this run. This is a controlled observation,
not a production throughput claim or a confidence interval.

The test deliberately prevents rotation for at least one second. That recording
grew to 1,134,358 microseconds and 104 samples; rotation is therefore **not a
hard duration bound while the main thread is blocked**. All 25 anchors ended.
RSS changed from 81,739,776 bytes before profiling to 101,720,064 bytes at the
first in-recording observation and stayed there through the remaining checks
and disconnect. Observed JS heap during recording ranged from 32,777,576 to
32,831,792 bytes. These short measurements do not establish long-term retention.
Continuous profiling remains unintegrated pending an acceptable recording
policy and its dynamic-gate, saturation and retention tests.

### Queued output is progress: idle checks must let the pipe drain (11:31Z)

**EI-24124212290448236** now has a deterministic reproduced mechanism. The
sidecar and local Git tests wait for a real Node child to report readiness,
block the parent's CHECK phase for 450 ms, and record timestamped child writes
every 40 ms during the block. They require at least three writes inside that
interval. With a 150 ms idle deadline, old source committed its idle verdict
before the next POLL delivered those already-written bytes. The sidecar returned
-1; the local runner also appended a false idle-timeout diagnostic. The original
historical runs 19248786/19248790 lacked the reason text, so those two instances
cannot individually be attributed from their saved output alone.

Old-source controls: **19283365** failed the real sidecar queued-output case,
**19285491** failed the corresponding local case, and **19285506** failed the
action-level pending-progress case. In both real-process files, a separate
continuously-writing child still hit the absolute hard deadline. The action
test pins the same pending-progress interval with fake time; the OS-pipe phase
ordering is established by the real-process cases.

The fix extends the existing idle guards in `sidecar-exec-process.ts`,
`run-git-sync.ts` and `git-sync-action.ts`. An expired idle timer schedules its
verdict with `setImmediate`, allowing POLL to deliver pending output first.
Progress cancels that pending verdict and renews the existing idle timer.
Termination and settlement clear the pending check. Absolute hard deadlines
are unchanged. No timeout budget was widened and no periodic timer was added.

Verification: **36 tests, zero skipped**, across sidecar routing/progress
(19285494), local progress (19285493), and process cancellation/lifecycle
(19285495), at `edf012976b` plus local source/test changes. The full action and
signal-routing suites subsequently passed **144 tests, zero skipped**
(19285510/19285509). The latter runner began at `edf012976b` and its ledger
recorded `fb6b5c136c` after background git-sync committed during the run; its
aggregate provenance stamp is unknown, so it is current-tree evidence, not a
claim of an immutable single-SHA execution. Scoped typechecking of the seven
changed source/test files found zero requested-file diagnostics and 29 other
loaded-graph diagnostics. Diff whitespace checks passed.

This review also found a **separate, still-open** P-003 lifetime gap, recorded
as **EI-24141765530574665** (detail post 1143263): local Git only signals its
direct child, leaves escalation timers armed, and can force settlement after
20 seconds; the outer action also starts lease cleanup immediately after abort
without waiting for child exit. Its existing mock rejects synchronously on
abort, so it cannot detect that release interval. The next acceptance guard
must delay actual child settlement and assert repository leases stay held.
The idle-race repair does not resolve that gap or prove PERF-P-003 complete.

## P-003 local command lifetime and repository leases (2026-09-24 11:54Z)

The gap above is now repaired in the current source under WI-10002825 and
EI-24141765530574665. Two independent boundaries needed changes:

- The local Git runner signalled only its direct child and could resolve after
  parent close while an ignored-stdio helper was alive. It also fabricated
  completion after 20 seconds and left its SIGKILL timer armed after settlement.
- The action guard rejected its pipeline promise immediately on abort, then
  stopped the repository lease heartbeat and released leases while the actual
  Git execution was still pending. The old test's child mock rejected immediately
  on abort, so it never exercised that interval.

Local Git now owns a referenced POSIX process group and uses the same exit fence
as the sidecar. The existing sidecar signal/probe code was extracted into
`fleet/process-group-lifetime.ts`; this keeps local Git independent of sidecar
admission imports and prevents a second implementation of that lifetime rule.
Only successful exit proof permits completion; failed probes remain pending.
The existing 10-second escalation is cleared on settlement. Pre-aborted requests
return without spawning. Windows retains direct-child behavior; helper-group
coverage here is POSIX-only.

The action reuses `RunGitSyncOpts.runGit` to track real Git promises separately
from the cancellation race. Cleanup waits for these promises before starting its
15-second DB-cleanup budget or stopping the heartbeat. Setup and metadata awaits
retain their existing liveness deadlines, and no new Git call starts after abort.

Counterexamples: old-source run **19288100** failed both delayed settlement
variants (resolve/reject); old-source **19289497** failed all three local cases
(pre-aborted spawn, cancelled helper, successful parent with a live helper).
The full action/local/IPC lifecycle run passed via detached recovery
**05f155f3-0ad2-416a-91a1-87bc7b41bb27**, rows **19289816**, **19289815**,
**19289818**, at HEAD `9449244055` with local source edits. The action regression
was then strengthened to keep the child pending for 20.1 seconds of fake time,
past both deadlines and the cleanup budget: **19289822**, 2 passed, 141 unrelated
cases filtered. It confirms lease renewal during cancellation and release only
after settlement for both fulfillment and rejection.

Scoped typecheck passed all six changed TypeScript source/test paths with no
requested-file diagnostics; 23 other import-graph diagnostics remain. The spawn
lint initially flagged the already-governed, awaited sidecar group; the existing
documented awaited-group exemption now covers both runners (EI-24143584172308161).
`git diff --check` and the spawn lint pass. This is source/current-build proof,
not deployment proof or P-003 completion. IPC transport-loss exit fencing,
profiler policy and comparable multi-repository performance remain open.

Final compatibility results: **19289825–19289827** passed 41 routing,
cancellation and spawn-guard cases with no skips; **19289828** passed 18
Git-sidecar cases with no skips; the full `run-git-sync.test.ts` suite passed
as **19289841**, detached run **ce8ba1a3-33dc-4c77-b40a-a17aadc41edc**.
The background routine committed the named source/test paths at `a131b1bcb6`;
their working-tree state was clean when checked. EI-24141765530574665 closed
with **committed** completion authority. The minor lint-exemption item
EI-24143584172308161 was closed with proposed authority before that sweep;
its recorded content manifest awaits automatic settlement. Neither result
claims deployed behavior or completion of the whole performance plan.

## P-003 file-output progress and idle-check liveness (2026-09-24 12:16Z)

EI-24142656580054437 is reproduced and repaired. `stdoutPath` sends stdout
straight to a file descriptor, so it emits no pipe data events. The idle guard
previously observed stderr alone and killed a healthy file-only writer.
Old-source run **19289858** failed the binary streaming and hard-deadline
controls; the silent-after-one-write control passed.

The existing idle-deadline callback now samples the already-open output handle's
size. It never reads/copies the file contents into JavaScript and adds no polling
timer, watcher or config key. Size changes renew the idle deadline and report
observed output activity. This conservative sampled observation can add up to
one idle interval after the last write; the independent absolute deadline is
unchanged. A generation check invalidates pending stats after pipe progress,
cancellation or child exit. A failed size probe terminates with an explicit
verification-failure diagnostic rather than inventing output progress.

The new cases also isolated EI-24144921179345016. With the size-probe change
alone, **19289859** still failed: the unreferenced one-shot `setImmediate`
could wait for child close or the hard deadline when no pipe traffic woke POLL.
Removing only `idleCheck.unref` made the three file-output cases pass in
**19289860**. The same correction is applied to the local Git and action guards;
their existing cancellation paths still clear the one-shot handle.

Final verification: **19289865** passed all 17 fd-handoff cases, including byte
fidelity, streaming, stopped output, hard timeout, and delayed-stat races with
stderr progress, abort and the hard deadline. **19289864** passed 18 existing
sidecar cases; **19289868** passed 5 local lifecycle/progress cases;
**19289869** passed 143 action cases; **19289870** passed 16 real IPC lifecycle
cases. All 199 passed with zero skips. Scoped typecheck passed the four changed
TypeScript source/test paths, with 23 other import-graph diagnostics; diff
whitespace checks passed. This proves current source behavior, not deployment,
transport-loss exit recovery, a profiler-overhead remedy or P-003 completion.

### P-003 prerequisite: failed SIGKILL escalation is not successful delivery

EI-24146077216039124 was found while evaluating the existing task-manager
containment surface for transport-loss recovery. Both `killTask` and
`killScopeUnit` ignored the result of the escalated `systemctl kill` command,
then reported successful pending termination even if that command failed.
They now propagate `command_failed` and retain the original command error.

The initial interpretation that any successful pending response was itself a
bug was withdrawn after reading EI-20130774106283501. That behavior deliberately
avoids retry advice after accepted SIGKILL delivery while reaping is pending.
It is preserved. A successful kill response therefore still is **not** proof
that every process has exited; a future transport fence needs separate proof.

The permanent test holds the cgroup populated, accepts SIGTERM, and rejects
only SIGKILL with a bus-disconnect error. Old source failed both task and scope
cases in **19289906**, reporting `ok:true` and `no retry is required`. Fixed
source passed all 53 control cases in **19289907**, including accepted-delivery
and delayed-reaping controls. The accompanying processes/kill suite passed
10 cases: 63 tests total, zero skips, at HEAD `2cc99b2e34` plus the local source
and test changes. Scoped typecheck found zero diagnostics in the two changed
files (25 other import-graph diagnostics); `git diff --check` passed. This is
source verification only. The overall P-003 transport fence remains open.

### P-003 live-server connection drain (server-death recovery still open)

Plan decision D-001 preserves other users of the shared sidecar. The existing
`spawn:cancel` capability response now includes random server and connection
generations. `process:exec` can require that identity before admission; a
reconnected socket cannot silently run a request bound to its predecessor.
The new IPC `process:drain` operation runs on another connection, revokes the
original socket before any await, aborts its existing controllers, and joins
the original exec promise. Closed connections retain only their unfinished
requests. Completed responses are not cached: a missing result is returned as
`null`, meaning unknown outcome with confirmed exit, never permission to replay.
This extends the existing IPC and controller maps without a table or timer.

The project integration suite covers disconnection while the child is alive,
delayed admission before any PID, stale connection and server generations,
same-connection refusal, isolation from another client's live command, and
repeated drain after one completed file mutation. The old-source run
**19289919** failed all five new cases on the absent capability; cleanup also
reported three secondary rejected promises, subsequently handled in the test
helper. Fixed **19289921** passed all 21 real-process cases; the IPC client
suite passed 11 cases. Total: 32 passed, zero skipped, at HEAD `2cc99b2e34` plus
local source/test changes. The three changed TypeScript paths pass scoped
typecheck with zero requested errors and 23 other import-graph diagnostics.

This verifies the **live-server half only**. No Git caller uses the new fence
yet, and signal-bearing mutations remain local. Next: bind the handshake to
kernel process/cgroup identity, prove recovery when that exact server dies,
then integrate the caller without retrying an ambiguous mutation or releasing
its repository lease early. Do not use `killScopeUnit.ok` as an exit verdict,
nor destroy a live shared sidecar after a single client's connection fault.

### P-003 kernel containment and cancellable caller recovery (13:09Z)

`sidecar-exec-lifetime.ts` now supplies strict exit observations using the
existing process-identity parsers, task-manager scope names and scope-control
operation. The spawner mints the managed task ID before launch and passes its
expected scope to the server. The capability response advertises containment
only when the kernel confirms that exact scope, so an unconfined fallback
cannot accidentally authorize killing the caller's inherited scope. The
snapshot binds PID, boot/start identity, cgroup path and mount/scope inode
identities. Read errors, malformed data and changed mount/scope identities
remain unknown. A dead/recycled/zombie server permits cleanup of its original
scope; only `cgroup.events populated=0` or confirmed removal of that previously
observed scope establishes exit. A signal receipt does not.

Signal-bearing `runCommandViaSpawnerSidecar` calls now use a separate connection,
verify containment before dispatch and send the preflight connection fence.
On transport loss they revoke/drain that connection through the existing
`process:drain` protocol, or reap the confirmed-dead server's original scope.
Failed observations keep the promise pending, preserving the caller's lease.
A lost result resolves as an unknown outcome after exit is proven; it neither
throws into local fallback nor uses the infrastructure-fault prefix. Other
calls on the shared host connection remain independent.

Verification at HEAD `bbdf4f8d19` plus local changes: **59 unit tests** across
the lifetime, caller cancellation, spawner launch/confinement and IPC suites
passed. The updated process integration suite passed **22 cases**, including
the actual caller losing a reply after a real file mutation: one mutation,
child exit before resolution, and a second client's command still alive.
That in-process test substitutes the containment handshake; the separate
Linux integration test uses real managed systemd scopes and kernel reads. It
kills the test server while its helper survives, observes the populated scope,
then verifies cleanup and preservation of a separate live scope. It passed
with zero skips. Its first run (19293964) failed only on the expected orphan
warning from deliberate fixture teardown; marking the managed fixture's
teardown explicitly corrected that test setup. The seven initial changed
TypeScript paths passed scoped checking (23 other import-graph diagnostics).
The added Linux test subsequently needed its required `TaskSpec.argv` field;
the final test/typecheck result is recorded on WI-10002825.

The joined proof subsequently passed in **19294001** at `c3df817a17` plus local
changes: all **three** Linux integration cases, zero skipped. Two cases launch
the actual IPC server and exec implementation in separate managed scopes,
substituting only admission persistence with a fixture receipt/barrier. The
actual caller's containment handshake and recovery are unmocked. Killing the
server after a file mutation confirms scope exit and exactly one mutation;
killing it while admission waits confirms exit with no child/mutation ever
created. The server accepts an optional exec dependency for this fixture; its
default remains the production implementation. The parameterized fixture's
Vitest context typing was then corrected without changing these assertions.

With that proof in place, `runGitBounded` now allows signal-bearing mutations
through the same cancellable sidecar path. Optional Git locks are disabled only
for the read-only command set. Routing regressions distinguish safe preflight
fallback from a post-dispatch unknown outcome, which must not replay locally.
The final routing/test/typecheck results are on WI-10002825. Profiler policy,
comparable multi-repository measurements, independent acceptance and shipment
remain open; these are source verification results, not a deployed-runtime
claim. Prior tests 19293953–19293958 cover the first 59 unit/21 integration
matrix; 19293980 adds the full-caller live-server case (22 passed). The later
13:11 run crossed an automatic commit and is not used as settled-source proof.

Final changed integration/routing verification at settled `c3df817a17` plus
local changes: **19294006** (22 real IPC/process cases), **19294007** (3 actual
Linux scope and separate-server cases), **19294008** (5 Git routing/fallback
cases) all passed, zero skipped. Together with the unchanged 59-case unit
matrix this source unit has 89 passing cases. Scoped typechecks cover the
changed source/tests with zero requested diagnostics; the last four-file
compile reports 24 other import-graph diagnostics, not a globally clean build.
`git diff --check` is clean. The final subsequent edits only rename the read-only
set and correct lifecycle documentation. No shipped-runtime claim is made.

### P-003 warm recorder source unit (2026-09-24 13:37Z)

Decision D-002 selects a 100 Hz recorder owned by the existing lag monitor.
`event-loop-cpu-recorder.ts` retains V8's code map using overlapping named
anchors, rotates on the existing monitor tick, and supplies foreground profiles
through the existing `captureCpuProfile` artifact/retention seam. There is no
new service, timer, flag or persistence table. The existing opt-in gate controls
the whole recorder. Gate OFF/error, unsafe p95, delayed rotation and shutdown
disconnect it and cancel active capture. A gate read spanning a tick revokes
sampling; its stale result cannot restart it. Startup/slow rotation and
foreground start/stop costs are logged explicitly as observer cost.

This is a **soft** rotation bound. Native recording continues while JS cannot
run. On the next overdue tick, disconnect discards the old profiles rather than
serializing them. Node v25.9.0's bundled `v8-profiler-agent-impl.cc` corroborates
that path: `disable()` calls `stopProfiling(..., false)` for console recordings
and `stop(nullptr)` for the foreground; only `serialize=true` builds the
protocol profile. The public `v8.startCpuProfile()` API has no sample-limit
argument. No hard duration/memory bound or production overhead SLO is claimed.

Canonical verification on `a0d29c3d57` plus local changes:

- Recorder lifecycle unit run **19294029**: 10 passed, zero skipped; overlapping
  anchors, one initialization across captures, disabled/unsafe/overdue/stop
  revocation, pending setup, failure recovery, cancellation and single-flight.
- Real isolated Node integration **19294031**: one passed, zero skipped. Forty
  captures all contained multiple workload samples on a 25,000-function fixture.
  Initial warmup cost 123.35 ms; foreground starts ranged 0.039–0.155 ms.
  The deliberate overdue tick discarded the recorder, capture while unavailable
  rejected, and a safe reinitialization cost 96.07 ms. Largest foreground was
  18 samples / 2,790 bytes. Eight explicit-GC observations had constant RSS
  166,952,960 bytes and heapUsed 49,930,656–50,033,336 bytes. This is a short
  retention check, not a long-lived leak proof. Idle sampling used 4.102 ms CPU
  over 499.47 ms; after disable, 0.204 ms over 502.69 ms. The earlier baseline
  had 8.096 ms CPU, so it is **not** used to infer incremental overhead here.
- Final monitor run **19294033**: 57 passed, zero skipped, including new quiet
  prewarming, gate-OFF-during-capture and slow/stale gate cases. Safety-posture
  run **19294032**: 9 passed, zero skipped. Five-file scoped typecheck passed
  with zero requested or imported diagnostics.

The first unit run failed one monitor case because the Vitest global console
does not provide the native profiling behavior. The adapter now imports Node's
native `profile/profileEnd` functions; the full monitor suite then passed. The
real integration already uses Node's actual inspector. Existing experimental
idle/loaded overhead results above remain relevant, but multi-repository Git
measurement, sustained profiler acceptance and independent audits remain open.

### P-003 comparable multi-repository transport proof (13:46Z)

Run **19294494** passed the new canonical Git benchmark, zero skips. The full
method and final table are in `papercusp-p003-git-sidecar-benchmark-2026-09-24.md`.
Four temporary repositories, five read/write commands, 100 calls per block,
local/sidecar/sidecar/local order, pre-populated indexes and identical result
checks yielded zero fallbacks. Signal-bearing caller entry p50 was
29.24/0.54/0.45/26.59 ms; loop-delay p95 was 36.21/11.10/10.66/31.16 ms.
The real IPC/Git/kernel path uses fixture admission, so production DB/queue
latency and a full scheduled git-sync action are explicitly outside this proof.
No new production p95 or universal speedup claim follows. Source is
`a0d29c3d57` plus local edits; scoped test typecheck has zero requested and
23 other import-graph diagnostics. P-003 still needs sustained observer-cost
acceptance and independent verification; whole-plan acceptance/shipment remains
open.

## P-003 exact cancellation-clause proof (2026-09-24 14:02Z)

PERF-P-003@1 now has bindings **11508–11511**. Current-source action run
**19295455** passes the two delayed-child lease cases (141 unrelated cases
filtered); historical red **19288100** supplies the caught counterexample.
Real IPC/process runs **19294007/19294006** supply the separately bounded
integration layer. This composes the action's awaited promise with the child-exit
boundary; it does not claim a production-DB end-to-end action. The revision-2
adequacy evaluator passed and emitted **EI-24151782242112283**, pending independent
audit when filed. P-003's sustained profiler acceptance is still open.

## P-004 lineage projection (2026-09-24 14:15Z)

The live source query for ten frozen recent candidate/parent identities took
**2266.560 ms** under bounded `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
Its `adv_sessions` edge scan took **2148.190 ms** and 82,632 buffer hits.
An isolated launch-parent extraction measured **2402.494 ms**, 4,511 edges from
30,026 scanned rows. A narrow owner-only scan, returning more rows, took
**10.321 ms**, 2,218 hits. The expensive operation is repeatedly extracting the
parent from prompt-bearing launch JSON, not recursive traversal alone. These
are individual live measurements, not production p95 or CPU shares.

Migration **1217-adv-session-launch-parent-projection.sql** extends the existing
session table with a stored generated `launch_parent_owner`. PostgreSQL derives
it from `NULLIF(launch_spec->>'launchedBy', '')` for old and new application
writers. No new edge table, cache, service, or timer is introduced. The shared
`identityEdges` query reads this scalar, preserving the existing directed graph
and workspace predicate. The additive migration uses a five-second lock timeout;
deployment must apply it before running the changed query.

The new project integration suite reconstructs the pre-migration table shape,
seeds 4,000 sessions with 16 KiB launch documents, applies the migration twice,
and verifies backfill and subsequent parent/blank/null/absent updates. It tests
cycles, the 64-edge bound, consult ancestry, sibling eligibility and foreign
workspace exclusion against both query variants. Both variants execute the
production query; only the legacy arm replaces the scalar with JSON extraction.

| Frozen fixture measurement | Legacy JSON | Stored projection |
|---|---:|---:|
| Counterbalanced lookup median (10 calls each) | 42.119 ms | 10.782 ms |
| EXPLAIN execution | 40.961 ms | 11.434 ms |
| Shared buffer hits | 25,084 | 84 |

The eight-candidate acceptance workload completed **100 calls**, identical
grouping each time, with **12.252 ms p95**. This is an isolated fixture, not the
live ten-candidate population. The test asserts the 500 ms bar, lower median
cost, and fewer buffer accesses as a mechanism guard. Ledger runs **19295800**
and **19295801** pass all **14 tests, zero skips**, at `76b15a89a4` plus local
changes. Scoped typecheck passes both source/test paths and their import graph.
Raw test output is `/tmp/p004-lineage-tests-20260924.log`.

The absolute-path migration dry run succeeded; no live SQL apply or shipment is
claimed. The relative-path dry run incorrectly selected the detached
`papercusp-staging` checkout (tracked under **EI-24070880772695626**); Git confirms
the actual main checkout remains `papercusp`, branch `staging`. Memory lexical
profiling, independent acceptance and whole-plan shipment remain open.

## P-004 lexical field normalization (2026-09-24 14:28Z)

Frozen query: `papercusp memory lexical retrieval ranking scope deterministic
query performance timeout lineage candidate exclusion active history search`
(16 tokens), `user_id=harness:papercusp`, top-K 10, memory kind, active/current
rows. Bounded live EXPLAIN of the source query measured 595.992 ms. Moving its
match predicate before the projection fence measured 449.177 ms but increased
buffer hits from 20,675 to 69,580; that variant was not selected.

The selected change keeps the existing query structure, scope/validity guards,
admission, weights and rank-before-limit. PostgreSQL `lower()` normalizes each
field once behind the existing `OFFSET 0` fence; already-lowercase query tokens
then use `LIKE`. This removes repeated case conversion for each token in both
filtering and scoring. Counterbalanced live source-query EXPLAIN runs measured
580.770/206.182/216.389/602.697 ms (legacy/current/current/legacy), with comparable
buffer counts. These are four controlled statement executions, not service p95.

The real-PG suite compares the production query to its ILIKE predecessor across
mixed case, Unicode, JSON null/numeric/array fields, escaped compound identifiers,
memory/entity separation, archive status, foreign scope and validity windows.
Repeated results and complete result payloads/scores agree. Its 2,000-row frozen
wide-text benchmark uses counterbalanced five-call blocks, ten calls per arm:

| Measurement | Legacy ILIKE | Normalize once |
|---|---:|---:|
| Median caller time | 718.137 ms | 179.363 ms |
| EXPLAIN execution | 935.211 ms | 259.254 ms |
| Shared buffer hits | 119 | 119 |

Ledger **19295840** passes all seven PG cases, zero skips. **19295830** passes
96 memory-store unit cases. Scoped typecheck passes the three changed paths and
their import graph. Raw final test output is
`/tmp/p004-lexical-final-20260924.log`; source is `f6cdc8cbe2` plus local edits.
The first PG attempt exposed a stale fixture missing the now-required storage
profile; the next exposed an untyped polymorphic JSON parameter. Both fixture
faults were corrected before the successful run; neither was a passing test.

P-004 lineage binding **11537** passes traceability, layer, oracle, execution and
freshness checks. Adequacy remains **unknown** for falsifiability and the L4
floor: a targeted counterexample is still required. Broader independent
acceptance and shipment remain open. P-003's cancellation scorecard now has a
passed independent audit, **EI-24151960564427869** (2026-09-24 14:05Z).

## P-004 latency falsifier (2026-09-24 14:37Z)

The preceding adequacy gap is now cleared for **PERF-P-004@1**. The sanctioned
copy-out mutation tool inserted an awaited 600 ms delay in a temporary copy of
`lineagePartyKeys`. Original baseline **19295851** and unmodified relocated
baseline **19296562** passed (100-call p95 17.292 and 12.727 ms). Mutant
**19297277** completed its 100 calls and failed specifically at the 500 ms p95
assertion, measuring **619.196 ms**. Two unrelated cases were filtered in each
probe run. The script returned `verdict=caught`, `baseline_exit=0`, `guard_exit=1`.
Its TS syntax checker reported `mutant_parse=unchecked`; the actual Vitest run
loaded the module, ran the benchmark and failed the named numeric assertion.
This is not an import failure. The shared source was unchanged by the probe.

Bindings **11546/11547** supersede the earlier test recipe and add the targeted
mutation. The revision-2 adequacy evaluator passes with no blocking criteria;
scorecard **EI-24154001676167368** is filed for the automatic independent audit.
The broad P-004 acceptance and shipment are still open. Logs and frozen mutant
are at `/tmp/p004-lineage-mutation-20260924.log` and
`/tmp/mutation-probe.TneDEs/`; the canonical scorecard retains its replay recipe.

## P-004 independent lineage audit (2026-09-24 14:41Z)

Scorecard **EI-24154001676167368** now records a passed independent audit via
**EI-24154238373657663**, auditor `role-063527fe-25e9-444c-90b5-ee7a8b184221`.
This covers the exact lineage clause, not broader P-004 acceptance or shipment.

## P-006 memory cancellation source unit (2026-09-24 15:10Z)

Work item **WI-10002828**. The two-second contract is the existing cold prompt
cache deadline (`MEMORY_BLOCK_COLD_DEADLINE_MS`); the five-second value is an
individual background injection phase limit (`MEMORY_INJECT_TIMEOUT_MS`). They
measure different waits. Neither limit was changed by this source unit.

The cancellation gap originates between the memory query and its embedder:
`embedWithinBudget` rejected only its own timer, `mem0-client` passed text alone,
and `embed-coalesce` had no consumer lifetime. The sidecar client already
accepted a signal, but this path never delivered one. The existing coalescer,
backend options, client seam and deadline wrapper were extended; there is no
new scheduler, admission store, service or flag.

Each coalesced consumer now carries an optional signal. Cancelling one leaves
live siblings intact; the last cancellation aborts upstream. An abandoned
generation cannot populate the vector cache or remove a replacement flight.
Raw promises still settle only when upstream settles: abort is not proof that
native inference exited. The existing tracked deadline/admission mechanism
therefore retains its host lease while non-cooperative work drains. The
injection search phase forwards its existing timeout through this path.
Cancelled query embeds throw instead of returning null, preventing per-scope
legacy re-embedding after cancellation. A cancelled local model initialization
does not proceed into inference.

The original coalescer failed five newly added guards (eight existing cases
passed). The final focused project runs are:

| Suite | Ledger run | Passed |
|---|---:|---:|
| Coalescer cancellation, cache and generation safety | 19303705 | 13 |
| Actual loopback HTTP sidecar and local startup | 19303706 | 18 |
| Memory backend scope, budget and cancellation | 19303378 | 72 |
| Existing client compatibility | 19302433 | 7 |
| Existing hybrid ranking contract | 19302434 | 60 |
| Deadline and raw-work tracking | 19303379 | 27 |
| Injection wiring and existing recall semantics | 19303424 | 83 |
| Cross-worker admission including cancelled native work | 19303707 | 7 |

These runs had zero failures and zero skips. Two exact-shape injection fixtures
initially failed because they lacked the added signal field; they now assert
that field explicitly. A test-mock type error was also corrected. The generic
memory package typecheck passed; the four changed injection/deadline paths
passed scoped operator typecheck (`/tmp/p006-operator-tsc.log`). This does not
assert that the whole operator tree typechecks.

The HTTP tests observe actual request closure after query-budget expiry, one
request and no legacy/retry amplification, and successful delivery to a sibling
with a longer budget. The admission test verifies that a second worker remains
at capacity until a cancelled but non-cooperative embed completes. Those tests
protect transport and resource lifetime; they do not measure production recall
quality. Single-scope legacy mem0 search and already-running native/SQL work
are not claimed physically cancellable.

Still open: end-to-end phase attribution and budget allocation, missing-table
admission diagnosis, the frozen 100-call normal and concurrency-8 delivery
workloads, broader acceptance, and shipment. No 95% within-two-seconds recall
claim is made from these source tests.

## P-006 rendered-delivery measurement (2026-09-24)

`packages/operator-core/lib/memory/bench/prompt-delivery.integration.test.ts`
extends the existing corpus/gold-set/seed and bench-host seams. It runs the
actual hybrid backend, injection renderer and bounded rendered-block cache.
Memory, feedback, surfaced-memory ledgers and recall telemetry all use a migrated
throwaway org database. The separate prose-corpus leg is explicitly disabled,
and advisory feature flags are pinned false. This profile therefore measures
the memory leg in isolation; it cannot establish combined prose delivery or
deployed-runtime acceptance.

The request list is the complete frozen gold set. Eligibility is fixed from
nonempty `expected` keys before searching; failures and empty results remain in
the denominator. A useful delivery must contain a rendered memory ID mapped to
one of those expected keys, with a `ready` caller result within the unchanged
2000ms deadline. Any-context delivery is reported separately. The normal cold
query, normal immediately primed query, and concurrency-eight cold query windows
use the same corpus and ordered requests. Every measured turn has an independent
session and cold rendered-block cache. The client is recreated before each
window; this does not mean the native model or PostgreSQL caches are cold.

Per-call records retain caller/build/availability/search/embed timings, hybrid
leg statistics, retrieved and delivered keys, errors and deadlines. Late builds
are joined after recording the caller outcome, so late delivery cannot be
credited within deadline. Source/corpus/request hashes and resolved embedder
profile are emitted with the measurement.

The first invocation (`/tmp/p006-prompt-delivery.log`) seeded successfully but
failed before measurement because source fingerprint paths assumed the repo
root while `test:file` runs from the package directory. Module-relative path
resolution fixes that instrument error. No delivery result is inferred from
that invocation. The corrected invocation is recorded separately.

The original `agent-obligations:waiting-on` missing-table error is already
corrected in `agent-obligation-reader.ts`: it bootstraps and reads through the
lock package's transaction pool instead of the org pool. The real PostgreSQL
guard `agent-obligation-waiting-on.integration.test.ts` has historical local
failure/pass receipts 19149327/19149335. This is existing source/test evidence,
not a fresh production observation or a new fix in this continuation.

Corrected measurement receipt **19307105** passed both integration tests with
zero skips, on `fc794d786897159f742fe4981242689d54fa1e75` plus local test changes.
The raw per-call records, source/fixture hashes, model profile and units are in
[`tests/evidence/p006-prompt-delivery-2026-09-24.json`](../../tests/evidence/p006-prompt-delivery-2026-09-24.json).
The corpus has 114 entries; each measured window runs all 150 gold queries, of
which 120 have expected relevant keys. Warm priming calls are setup, excluded
from the measured population. Resolved model: Harrier OSS 0.6b, native 1024;
live push contract: cosine 0.58, lexical 0.4, cosine-gated fusion.

| Profile | Calls | Eligible | Useful by 2000ms | Caller p50 / p95 | Search p95 | Post-search p95 |
|---|---:|---:|---:|---:|---:|---:|
| Normal cold query | 150 | 120 | 114 (95%) | 240.14 / 318.36ms | 311.93ms | 8.17ms |
| Normal immediately primed query | 150 | 120 | 114 (95%) | 54.48 / 106.24ms | 62.68ms | 42.17ms |
| Eight-reader cold-query burst | 150 | 120 | 114 (95%) | 240.89 / 469.33ms | 168.86ms | 324.88ms |

Each window had zero caller deadlines and zero recorded errors. Each retained
the same six gold misses (`lg-015`, `lg-030`, `lg-033`, `ei-003`, `ei-016`,
`ss-043`). The expected keys were absent from retrieval on those calls;
`ei-003` delivered a different key. Thus these six misses cannot be attributed
to deadline expiry or renderer removal. Any-context delivery was 115/120,
which is deliberately not substituted for the useful-delivery numerator.

`embedMs` in the raw readings sums individual embed-call durations, which can
overlap; it is work-duration attribution, not wall-clock critical-path latency.
The table's post-search metric is `max(0, buildMs - availableMs - searchMs)`;
it includes remaining rendering/hygiene/composition work, not pure CPU render
time. The burst's larger post-search time is a finding requiring attribution,
not evidence by itself of a CPU or resource bottleneck.

This establishes the 95% clause on the named isolated profile only. The broader
P-006 end-to-end budget/allocation and combined prose path, independent evidence
audit, sustained acceptance and final shipment remain open. No baseline speedup
or production percentile is claimed.

### Falsifiability and exact-clause adequacy

The existing `injection-block-cache.test.ts` guards were run through
`scripts/mutation-probe.sh` with a verified `mutation probe` file lock. Baseline
19307551 passed all eight tests; mutation 19307552 replaced only the delivered
ready block with `null` and failed five delivery assertions. The script recorded
`verdict=caught` and verified byte-identical restoration; the lock was released.
This is a transport/delivery counterexample, while 19307105 supplies the real
corpus quality and timing measurement. No failed mutant remains in the tree.

Bindings 11632 (measurement) and 11630 (caught mutation) target PERF-P-006@1.
The evaluator passed this exact clause and filed card
**EI-24158413223694826**. Independent audit was not yet verified at this write.
Binding 11632 supersedes 11626 to distinguish the active frozen-workload clause
from the broader plan residue; the combined prose path and shipment limitations
remain explicitly recorded above and in the binding. This does not close P-006.

The final benchmark file passes Prettier and `git diff --check`. Scoped
`build:typecheck` reports zero diagnostics in this file with a complete scoped
verdict (15.6 seconds); 23 import-graph diagnostics outside it remain. The full
operator compiler also completed with errors outside this file, and no diagnostic
in this file (`/tmp/p006-bench-tsc.log`). Neither result establishes a clean whole
operator build. A later scorecard read confirmed the independent audit was
pending with a dispatch reservation; no audit PASS is claimed here.

## P-007 native baseline and phase diagnostics — 2026-09-24 16:12Z

WI-10002829 owns this work. The first native run used the existing packaged
release shell selected by WDIO at
`/mnt/data/cargo-target/release/bundle/deb/Papercusp GUI_0.0.20_amd64/data/usr/bin/papercusp-desktop`
(binary timestamp September 16). This is an old-package baseline, not a staging
acceptance result. `DISPLAY` was removed from the runner environment so its
existing driver wrapper provided a private Xvfb display.

Command: from `tools/perf-test/wdio`,
`env -u DISPLAY PAPERCUSP_PERF_RUN_ID=p007-baseline-20260924T1559 npm run test:wdio -- --spec ./specs/plan-popup-open.perf.spec.ts --spec ./specs/smoke.spec.ts`.
Log: `/tmp/p007-native-baseline-20260924.log`; persisted desktop receipt
`perfrun-1790265553071-rrdf99`. Popup **1507ms** exceeded the unchanged **1500ms**
budget. Web Vitals smoke passed with FCP **2457ms**, LCP **3558ms**, and no missing
expected metric. This run does not explain the earlier missing-metric incident.
The sidebar's first candidate was `papercusp/su-agent-behavior`.

Extended the existing User Timing seam and shared `PlanDocumentView` callback:
`content-ready` is cumulative click-to-data-and-React-mount; `renderer-ready`
follows CSS/JS loading; `preview-rendered` follows the awaited Vditor preview.
The original total still ends after shared plan decoration, at `onParsed`.
Phase diagnostics are first-observation-only, bounded to the current interaction,
and do not change the total endpoint or budget. WDIO retains these diagnostics,
the opened plan identity, and resource durations (paths only, no query strings).
`PAPERCUSP_PERF_PLAN_SLUG` can freeze the selected visible sidebar plan; it cannot
silently fall back to a different plan when the requested row is absent.

Source verification: `npm run test:file -- apps/operator/app/_components/perf/perf-marks.test.ts apps/operator/app/admin/plans/PlanEditor.test.tsx libs/generic/ui-primitives/src/PlanDocumentView.test.tsx`
passed **32 tests, zero skipped**, receipts **19311377/19311378/19311379**.
Log `/tmp/p007-phase-tests-20260924.log`: superproject `c36a6834a5` plus local
edits; ui-primitives `287d95c71a` plus local edits. Delayed-render and cancelled
render cases distinguish preparation from actual completion. Scoped app source
typecheck passed with zero requested-file or import-graph diagnostics.

The runner's own typecheck was blocked before checking source by its retired
`moduleResolution=node10` under installed TypeScript 7 (TS5108 reproduced in
`/tmp/p007-wdio-tsc-original-20260924.log`). NodeNext matches the current Node/tsx
runtime and exposed one unsafe optional row lookup, now guarded. `npm test` now
runs typechecking first; `npm run typecheck` and all four existing runner unit
tests pass. The scoped tool's relocated configuration separately failed to find
runner-local ambient types; the successful runner-local check is authoritative
for this project. No pure typecheck is presented as a behavior test.

Remaining: build and exercise the instrumented current UI in the native shell,
attribute and fix the measured latency, investigate any reproduced missing
metric, and retain ten named-build native results plus cold/warm coverage.
The isolated Vite build is queued through the existing heavy-work admission and
singleflight wrappers, output root `/tmp/p007-current-20260924`, log
`/tmp/p007-current-build-20260924.log`. No P-007 acceptance or shipment claim.

### P-007 finer attribution and body-read optimization — 16:30Z

Frozen current UI snapshot `/tmp/p007-native-current-20260924` used the unchanged
native shell SHA256 `ebdba9181122d5da2d5446efd4aebae2f714cd122111845ec96b6ccbb6082a34`.
Its SPA index hash was `7540a6b3723732bd233c425985fbf5330f67ed97d2cfe0911c8de2c7fff1ea06`;
the complete `spa-sha256.json` manifest hashes to
`3e7669728cfaf4252d529c3b6e5cfaf3bde8f76cfb42cac8e1d8d855ed29d719`.
The entry dependency graph reaches the new phase instrumentation. Native result
`perfrun-1790266630922-9f0vyh` was **2630ms**: content-ready2576,
renderer-ready2584, preview-rendered2629. FCP2494/LCP3692 passed. Raw resource
timing was empty, so it supplies no network attribution in this custom protocol.

A second snapshot `/tmp/p007-native-detail-20260924` (SPA index
`ac646930a9dd7d34e63f091f6612eccfc27ea42d7a08a4f2097edc270e80939c`)
adds detail-mounted/data-ready marks. Native receipt
`perfrun-1790266932270-f8qluy` failed at **4081ms**: detail-mounted209,
data-ready3194, content-ready3989, renderer-ready4003, preview-rendered4080.
Thus this run's largest interval is the detail's wait for data; renderer prep and
preview are small. These are diagnostic runs on different snapshots, not a
controlled speedup comparison. Logs are `/tmp/p007-native-current-20260924.log`
and `/tmp/p007-native-detail-20260924.log`. The narrower PlanDetail instrumentation
passes 14 existing tests (19314246); its scoped typecheck is clean in that file,
with 86 diagnostics elsewhere in the loaded graph.

The full plan read unconditionally loads fresh descendant execution history
outside the document cache. The popup does not consume this history. Extended
the existing `plans:get` option set with `includeHistory` (default remains true),
and the existing UI read-dispatch seam supplies false for body reads. Explicit
History headings and prior-attempt references still retrieve history. This
removes proven unused work; its share of the native latency is not yet measured.
No second reader/service/cache was introduced. Tests compare the complete result
apart from history, preserve raw bytes/version, and alternate UI/agent reads
through the same cache to guard against contamination.

`get.cache.test.ts` + `read-dispatch.test.ts`: **39 pass, zero skipped**,
receipts **19314960/19314959**, source `eaa65935fc` plus local edits. Scoped
typecheck: four requested files clean, 23 other graph diagnostics. Logs:
`/tmp/p007-plan-read-tests-20260924.log`. Native improvement remains unverified:
both MCP and explicit :3170 reads still rejected the new option on running
build `c36a6834a5` at 16:30Z. Do not confuse source proof with runtime activation.

Correction to the earlier build note: the command completed successfully, but
the requested `VITE_BUILD_OUT_ROOT` path was absent; the completed build appeared
in the regular dist. The reason is unverified. Both test snapshots were copied
under the existing dist build lock, leaving the native binary unchanged. No
process was killed: cancellation guards refused to signal an unmatched process,
and the original queued command completed normally. No commands remain running.

### P-007 staging activation and native isolation repair — follow-up

The plan-read changes are committed in the canonical tree at `abab84b83d` and
are now active on :3170: an authenticated `plans:get` with `includeHistory:false`
returned `su-agent-behavior` version89 without history. The automatic staging
sync performed the activation; no manual restart was needed. The obsolete
git-sync await196699 was already settled/not found when cancellation was tried;
that call did not itself cancel anything.

A bounded paired diagnostic used the same full/raw plan and warm document cache,
alternating only `includeHistory`, via the existing `code:run` tool after a recipe
search returned no match. Version89/content hash
`042f83e599a6f2bbee674297754fe0cbc5539050efd2ec077f6bc3de168f5750`
stayed identical. Server tool-wall samples in order:

| includeHistory | milliseconds |
| --- | ---: |
| true | 34 |
| false | 176 |
| false | 8 |
| true | 18 |
| true | 206 |
| false | 8 |

This small diagnostic establishes neither a native speedup nor history loading
as the cause of the older multi-second popup delay. Native backend selection
and client-side/transport timing still need the controlled comparison.

**EI-24161953656319715:** the server's established `PAPERCUSP_HOME` override was
honored by `serve.ts` and the JS host-platform reader, but native Rust HTTP and
IPC discovery joined the default workspace home. A real Cargo regression used
two temporary discovery roots and ran each environment case in its own child
test process. The original production reader returned port40001 instead of the
explicit isolated port40002 (receipts19318917/19318918). This is a measured
discovery mismatch, not evidence that an actual user operation crossed instances.

The existing native discovery path now shares `native_papercusp_dir`: HTTP,
raw/validated IPC, the recovery reader and debug IPC initialization honor the
override; unset/empty preserves the default, and a missing explicit directory
does not adopt another instance. Existing WSL/default-discovery tests also run
their environment cases in isolated child processes to avoid parallel-test races.
Final `main.rs` SHA256:
`0471cbdbc9857987a28e545e8c4ea8180ce44fdbf5edeb3eab703cf7ec2738d9`.

Project command:
`env PC_HEAVY_COALESCE=0 scripts/pc-heavy.sh node scripts/report-cargo-tests.mjs --manifest-path papercusp-desktop/src-tauri/Cargo.toml -- discovery --nocapture`.
**64 tests passed, zero failed/ignored**; final regression receipt19318988
(earlier isolated pass19318923). Logs are
`/tmp/p007-native-discovery-control-20260924.log` and
`/tmp/p007-native-discovery-suite-20260924.log`. A post-edit attempt without the
coalescing opt-out replayed the old failure instead of executing new source;
that result is explicitly not new test evidence (EI-24162290157408503).

The fresh release-shell build is still queued through `pc-heavy`; log
`/tmp/p007-native-release-build-20260924.log`. Its artifact will use the frozen
current SPA and a private `PAPERCUSP_HOME` containing the fresh :3170 discovery
advertisement, preserving the real user's home/preferences. Full GUI validation
of the discovery fix and P-007's ten-run native acceptance remain open. No
shipment claim; the discovery work-item remains owned until runtime proof.
### P-007 fresh release GUI on staging — further evidence

The release binary built from the repaired native source is
`e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`.
Its build completed through `pc-heavy` (`/tmp/p007-native-release-build-20260924.log`).
The complete private test artifact at `/tmp/p007-staging-native-v2-20260924`
paired that shell with staging UI index
`1ba14a354070f1d517bbdfe58b281fc750f4e3e58ca4e6de8156a31b3d303611`.
The private `PAPERCUSP_HOME` contained an operator.json derived from a
PID/port-verified live :3170 IPC advertisement; that PID answered `/api/health`.
The existing WDIO runner used private Xvfb, its documented stage report URL,
and `PAPERCUSP_DEV_API_TARGET=3170` to prevent a persisted environment choice.
The user's real desktop preference file had the same digest before and after
both native runs. The release GUI mounted the stage Plans view and rendered a
real plan, completing runtime verification for the discovery fix
**EI-24161953656319715** (resolved). Cargo proof above remains its recurrence
guard; macOS/Windows packaged runtime was not exercised.

The first attempted frozen slug `su-agent-behavior` was not visible in this
sidebar and correctly produced an **UNMEASURABLE** run with zero candidate
rows (`/tmp/p007-native-v2-staging-20260924.log`); it is not a speed result.
Using the same artifact and the visible
`papercusp/goal-agent-behavior-feedback-2026-09-06` plan:

| run | popup ms | detail mounted | data ready | content ready | renderer ready | preview rendered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| first | 5767 | 1853 | 4994 | 5583 | 5592 | 5760 |
| repeated, slug pinned | 2457 | 408 | 1722 | 2275 | 2284 | 2450 |

Both runs exceed the unchanged **1500ms** popup budget and were recorded by
staging as `perfrun-1790269938151-rn3167` and
`perfrun-1790270296139-s9vrqe`. Logs are
`/tmp/p007-native-v2-discover-20260924.log` and
`/tmp/p007-native-v2-pinned-second-20260924.log`. These two valid timings
falsify acceptance for this build/profile; do not fill a ten-run success card.
The request/response split and its code-change effect were not present in that
served UI, so the data-ready interval is not yet attributable to backend,
transport, or React work. The resource timeline remained empty.

To resolve that attribution, the existing `fetchPlan` path now marks request
start and parsed response, suppressing a response mark after cancellation.
`plans-api-result.test.ts` passes **17 tests** including a delayed cancelled
response; its two changed TypeScript files have a clean scoped typecheck.
Log `/tmp/p007-request-phase-tests-20260924.log`. Staging source now contains
these marks and its newer UI bundle index hashes to
`6a2421698ff114c5da0b20afa4905200065664aca7f56fad0e80d3c472413c58`;
the maintained staging sync was activating at this write. The next native
measurement must pin the same visible plan and record that served build identity.
P-007 and overall shipment remain open.

### P-007 request/response split on the served staging UI

The maintained staging sync completed and `/api/health` returned 200. The
served staging UI index hashed to
`6a2421698ff114c5da0b20afa4905200065664aca7f56fad0e80d3c472413c58`
and its compiled assets contain the new `request-started` / `response-ready`
marks. The release GUI artifact remained binary
`e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`;
its private `PAPERCUSP_HOME` was refreshed from the new live :3170 discovery
advertisement (PID2063159, health200). The real desktop preference digest
remained unchanged.

For the same visible `papercusp/goal-agent-behavior-feedback-2026-09-06`
plan, the official packaged WDIO popup spec measured **2919ms** against
**1500ms**, staging receipt `perfrun-1790271276438-mkc1da`, log
`/tmp/p007-native-v2-request-response-20260924.log`:

| cumulative click-to-phase | milliseconds |
| --- | ---: |
| detail mounted | 449 |
| plan request started | 635 |
| response JSON ready | 2082 |
| data state ready | 2106 |
| content ready | 2743 |
| renderer ready | 2750 |
| preview rendered | 2913 |

The request through parsed JSON took **1447ms**; React data state followed
24ms later. Content readiness added 637ms after data state, and preview
rendering added roughly 170ms. Resource-timing entries were absent under the
native custom protocol. Three later direct loopback GETs for the same plan,
`mode=full`, returned HTTP200 with 194163 bytes each; their tool-wall times
were **765/245/409ms**. They were sequential warm reads through a different
transport and do not by themselves assign the native delay to backend or IPC.
The popup remains over budget; a ten-run PASS is unsupported.

The staging sync needed roughly eleven minutes before the API bound :3170:
unit start13:22:04 EDT, health200 by13:33:18. Its PID stayed stable and a
ten-second sample advanced **9.97 CPU seconds** while process state was R.
This measures CPU-active startup but not which code path consumed it; no
generic host-load cause is claimed. The service eventually recovered.
**EI-24165259633128552** is assigned for root-cause profiling and a startup
regression guard; P-007 work could proceed once the API was healthy.

### P-007 REST reader coverage correction — 2026-09-24

The previous `includeHistory:false` optimization covered `callPlansReadRaw`,
the live-query reader. The actual popup uses `fetchPlan` → REST `dispatchRead`
in `endpoint-route/routes/admin/plans.ts`, which independently prepared the
tool request and still requested descendant history. The earlier claim that
the popup's body-read optimization was active was therefore incomplete.
The running REST endpoint returned a `history` field (10553 serialized chars)
for `goal-agent-behavior-feedback-2026-09-06`, version75, content hash
`b93fd310da29722b856fb4f7281e866af7fc0fbf94722ee0e74bca4c563cfbb0`.

The existing REST reader now defaults `includeHistory` to false for `get`,
preserving full payloads, raw bytes and explicit opt-ins. The existing query
boolean allowlist now converts `includeHistory=true/false` to booleans.
Explicit History headings remain forwarded (the real tool's existing cache
tests cover their precedence). Other read verbs are unchanged.

Before the fix, the new REST route tests failed three cases: missing default
omission, explicit true, and explicit false. Control log:
`/tmp/p007-rest-history-control-20260924.log`. After the fix, REST route,
live reader and real tool cache suites passed 47 tests. The combined run also
caught the existing coercion allowlist expectation, which needed the newly
supported key; after updating that expectation, its 9 tests passed. Zero
skipped across these 56 cases. Logs:
`/tmp/p007-rest-history-tests-20260924.log` and
`/tmp/p007-rest-history-coercion-tests-20260924.log`. The four changed source/test
files passed scoped typecheck (`/tmp/p007-rest-history-tsc-20260924.log`) on
`6325d8e8b7` plus local edits. This guards the actual popup route, which the
earlier live-reader-only test missed.

A small paired tool-wall check on the same version/hash returned milliseconds
`true:851, false:190, false:32, true:133`. Both false reads omitted history;
both true reads retained it. This is a warm server diagnostic, not a native
latency acceptance result. Staging still served the pre-fix REST reader at
the time of this check; native performance remains open.

### P-007 active REST fix and visual preparation experiment

Git-sync committed the REST fix in `a48f6294fb`. The maintained staging sync
waited for its active-client deferral ceiling, then built and restarted :3170.
Before the next native run, health reported that exact source and REST omitted
history. The pinned plan stayed at version75 with the hash recorded above.
The same release shell and private discovery root attached to PID1321809.

The native popup still failed: **2330ms / 1500ms**, receipt
`perfrun-1790273512555-7dpmg5`, log
`/tmp/p007-native-rest-history-20260924.log`. Cumulative phases were
mounted374, request544, response1535, data1555, content2124, renderer2133,
preview2321. The request interval was991ms; data-to-preview-preparation added
569ms. The real desktop preference digest and the plan revision/hash were
unchanged before/after. One before/after sample does not establish a speedup
distribution; this result still falsifies acceptance.

The next source experiment starts the shared `PlanDocumentView` visual
preparation in a layout effect rather than a passive effect. This starts asset
preparation before the initial empty-preview paint; it preserves asynchronous
asset loading, real render completion, cancellation, and the existing timer
end. The hypothesis is that this removes part of the measured post-commit gap;
native impact is not yet verified.

The new React lifecycle guard observed false before the source change: the host
finished its visual commit before preview preparation began. Its first fixture
also unmounted before the asynchronous preview drained, disturbing the next
test; the fixture now awaits completion before cleanup. Final shared suite:
14 pass, including render completion and cancellation, log
`/tmp/p007-layout-final-tests-20260924.log`. Operator PlanEditor/PlanDetail:
19 pass, log `/tmp/p007-layout-tests-20260924.log` (that earlier combined run
also records the fixture failure). Zero skipped. Full ui-primitives typecheck
passed, log `/tmp/p007-layout-typecheck-20260924.log`. Source is superproject
`a48f6294fb`, ui-primitives `8713ca5d25` plus the two local file edits.
The next native run must verify that the served SPA includes this experiment.

#### Layout experiment activated and measured — 18:29Z

The layout edit committed as ui-primitives `4bfdeb7`, included in superproject
`bd4a524d6e`. Maintained staging sync completed at 18:28:37Z with that exact
health SHA. The disk SPA index SHA256 is
`4e6c749f0bec1b86a1c34509af0ab150e323bc44bb2c0fee2db15d3d00fe5f58`.
An initial byte-equality preflight failed: `host-spa.ts` injects bootstrap
globals into served HTML (49,935 bytes versus the 38,729-byte disk file).
Both reference `index-f6e25fef.js`; the served `src-3571ba8d.js` is byte-identical
to the built asset and contains the layout-effect implementation.

The same release shell and pinned plan version75/hash above measured
**3112ms / 1500ms**, receipt `perfrun-1790274593311-ntni06`, log
`/tmp/p007-native-layout-20260924.log`. Phases: mounted429, request637,
response2276, content2294, data2295, renderer2948, preview3106. The user's
desktop preference digest remained unchanged. Preparation now begins before
the parent data-ready mark, but async renderer readiness still adds654ms.
The request interval was1639ms. This is a failed experiment for total latency,
not evidence of a speedup. A new `styles-ready` phase separates the CSS await
from the JS import; acceptance and the total timing endpoint remain unchanged.

#### Browser queue attribution — 18:39–18:43Z

These are Chromium diagnostics on staging `bd4a524d6e`, not native acceptance.
A fresh browser must open `/adv?opcv=plans&ws=papercusp-workspace`: visiting
`/?opcv=plans` first redirects and drops the sidebar parameter. That initial
attempt timed out without a profile; the corrected route opened the pinned plan.

The first CPU/trace capture measured3117ms. `request-started` preceded
`ResourceSendRequest` by1189.54ms; HTTP headers then arrived1215.43ms after
network request start. Files: `/tmp/p007-chromium-20260924.cpuprofile`,
`/tmp/p007-chromium-20260924.trace.json`, and the distilled
`/tmp/p007-chromium-profile-20260924.log`. Profiling startup itself took524ms
before the click; this run is diagnostic and does not establish a distribution.

The existing `installOriginSchedulerFetch` wraps plan GETs. A second diagnostic
wrapped its existing scheduler's `run` callback to timestamp queue admission
without changing the scheduler policy. Its before-click snapshot reported
browser-http, limit2, inFlight2, queued7 (six foreground, one background).
The plan GET waited307ms before its callback began and took26ms inside the
callback; total popup1025ms. Log `/tmp/p007-origin-queue-20260924.log` contains
the snapshot, per-request timestamps and phases. This directly measures a queue
contribution in the browser. It does not establish the native IPC profile or
justify changing concurrency limits. Next native diagnostics should include
the existing scheduler snapshot alongside the CSS/JS split.

#### Native scheduler counterevidence — 18:46–18:48Z

The existing WDIO spec now logs the public `window.__sync_metrics__.snapshot()`
scheduler before clicking and after rendering, plus phases/scheduler on an
unfinished attempt. No scheduler setting or timing budget changes. The first
native attempt timed out without a measure; `/tmp/p007-native-scheduler-20260924.log`
is **UNMEASURABLE**, with no timing receipt. Before-click limit24, queued0 and
inFlight2 were observed; that alone cannot attribute the later timeout.

The next run exercised the completed diagnostics and measured **2482ms / 1500ms**,
receipt `perfrun-1790275714275-dq4kyx`, log
`/tmp/p007-native-scheduler-timeout-20260924.log`. Before/after snapshots both
had limit24, queued0, inFlight0. Foreground `waitMsTotal` grew13852→13853ms
across ten admissions, so the origin scheduler's foreground queue cannot
account for the roughly1100ms request interval in this run. The snapshot's
`profile` string still says browser-http despite limit24; the numeric limit is
the actual configured cap, not an inference from that label.

Cumulative phases: mounted386, request568, response1667, content1684,
data1685, renderer2305, preview2475. Renderer readiness added621ms. Staging
still served `bd4a524d6e`, before the CSS phase diagnostic. Native IPC queueing,
server work, and webview readiness remain to be distinguished; browser queue
findings must not be generalized to these native runs.

The server ledger supplies a further boundary: invocation29449924 at
18:48:32.050Z is the matching `plans:get` for the pinned slug, modefull,
client`pc-admin-plans-ui`, serving build`bd4a524d6e`; duration850ms, statusok.
The 18:47 timeout attempt's matching invocation29449772 completed in1189ms.
`dispatch-stack.ts` creates `startedAt` before dispatch gates/handler and records
`Date.now()-startedAt` before awaiting the invocation sink. These are dispatch
durations, not database-only or handler-only timings. The850ms accounts for a
substantial part of the successful native attempt's1099ms request interval;
it does not yet identify the expensive server stage.

### P-007 continuation: fixture corrections and main-thread attribution

On 2026-09-24 at 19:31–19:33Z, the current native fixture finally emitted
the required request, response and styles phases. The unchanged release shell
is `e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`;
the private packaged SPA was refreshed from staging and its index hashes to
`0827ecc7a9deb38bae87fd90a4c6f4a9c185e5785382315a24e6d658831ed3c5`.
The plan remains `goal-agent-behavior-feedback-2026-09-06`, version75,
content hash `b93fd310da29722b856fb4f7281e866af7fc0fbf94722ee0e74bca4c563cfbb0`.
Staging API `b8d4fc9b8b` was PID2562881.

Several intervening attempts were invalid setup evidence, not latency results.
The native client reads the private **default** `endpoint-ipc.json`; refreshing
only `endpoint-ipc.3170.json` left it pointed at a dead process. A maintained
WDIO preflight now checks the default record's live PID, matching port and Unix
socket. Five runner unit tests pass, including a real socket fixture with stale,
wrong-port and dead-PID counterexamples; runner typecheck passes. The initial
`.pc-opchat` diagnostic was also wrong: the actual selector is `.op-chat-sidebar`.
Finally, a copied packaged SPA has no HTTP bootstrap workspace injection. The
runner now accepts an explicit workspace before document mount and searches
for its pinned row through the existing `plq` control. The apparent seven-row
plans-list defect was retracted: explicit workspace requests return the pinned
plan. `EI-24172206815197035` is dropped; it is not cache-corruption evidence.

`/tmp/p007-native-styles-current-20260924.log` measured2720ms but lacked the
new phases because the packaged SPA was still the older snapshot. It does not
measure the CSS diagnostic. Expected phases can now be required before the
runner records or publishes a timing.

The valid scoped run measured **3220ms**, receipt
`perfrun-1790278279684-g52hre`, in
`/tmp/p007-native-styles-scoped-20260924.log`. Content-ready2461ms preceded
styles-ready3044ms; JS-ready followed at3045ms. A second, optional microtask
diagnostic distinguishes CSS transfer from synchronous main-thread delay:
content-ready1170ms, queued microtask1757ms, styles1758ms, renderer1759ms,
preview1936ms, total **1944ms**. Receipt `perfrun-1790278412546-bgcamk`, log
`/tmp/p007-native-styles-microtask-20260924.log`. The queued microtask itself
waited587ms, so calling this delay a CSS download would be wrong. It is main-thread
work after the layout effect starts; the expensive commit/layout operation is
still unidentified. Request-start561ms to response1150ms remains a separate589ms.
No 1500ms acceptance or shipment claim is supported.

The next native probe identifies the effect: the actual production React
`usePlanDocumentTheme` callback took **672ms** within a685ms content-to-microtask
interval. Its registration stack maps to `ct` in `src-5132942f.js`, line2,
column21154, which is that hook. Log
`/tmp/p007-native-react-effects-20260924.log`, receipt
`perfrun-1790278862635-q7hxdv` (2313ms total). The hook resolves computed root
styles in its initial state initializer, then calls `sync()` again from its
mount effect, forcing a second style read after the plan DOM is committed.
A separate Presence effect took143ms. A prior DOM-method probe found no
individual wrapped operation over10ms; it did not cover computed-style access.

The source fix preserves theme resolution and live-change listeners. It saves
the cheap theme attribute, inline-style and media inputs at the initial read,
then skips the second read only when those inputs remain unchanged after
subscriptions attach. The same duplicate-read pattern in MarkdownEditor is
fixed. A new project regression failed before the fix (two root computed-style
reads versus one expected) and passed after it. Another test changes the theme
between render and the subscription effect and still observes the new theme.
Shared reader16 tests, PlanEditor5 tests and MarkdownEditor17 tests pass, zero
skipped; shared-library typecheck passes. Logs:
`/tmp/p007-theme-control-tests-20260924.log`,
`/tmp/p007-theme-final-tests-20260924.log`, and
`/tmp/p007-markdown-theme-tests-20260924.log`.
After the owner lifted the pause, the private source build was verified as
SPA index `938a51916940a30806f1947fc96b4331bf005496d9d9099df67d77e28b6e8f9a`,
theme bundle `src-7b77f707.js`, with the same native shell and pinned plan.
API source had advanced to `0c6826c5e6`, PID2690831. The native run at20:36Z
completed: content-ready1804ms, queued microtask1814ms, styles1814ms,
renderer1815ms and preview1977ms. The former roughly600ms theme delay is
now10ms in this sample. Total **1983ms** still fails1500ms; request-start286ms
to response1783ms is now the largest measured interval (1497ms). This is
phase-level source-fix verification, not whole-P007 acceptance or a controlled
distributional comparison of total latency across API builds.
Log `/tmp/p007-native-theme-resume-20260924.log`. Its report upload returned
HTTP408 (`route exceeded 30s`), so there is no accepted publish receipt.
The local timing remains evidence; persistence requires separate reconciliation.

At20:43–20:45Z that reconciliation found the row: **`perfrun-1790282211518-bjovxk`**,
workspace `default`, status `fail`,16 measures, source
`0c6826c5e63cd3c1aad720c2da2b5d11da1e3307`. The stored1983ms total and phase
values match the local run. The runner does not send its UI workspace to this
publisher, so the earlier `papercusp-workspace` filter also missed known-positive
receipts; it could not establish absence. No upload retry was made. HTTP408
described the response failure, not absence of the durable write.

Server invocation **29459524**, `plans:get`, started20:36:49.446Z and took1446ms
inside the1497ms native request interval. Its arguments name the pinned plan,
`mode:full`, `includeRaw:true`, `includeHistory:false`, and the
`pc-admin-plans-ui` client. Dispatch duration includes middleware, handler and
result processing; it is not DB-only time. The foreground scheduler wait total
did not rise during this popup. This isolates substantial cost to the server
dispatch, without yet identifying a handler substage.

The current source extends existing invocation metadata with `plansGetRead`:
per-slug cache wait and wall times between source, issue-block, linked-feature,
coverage, liveness, lifecycle, rubric/audit, stale-path and shaping stages.
It snapshots each call outside the cached payload; a cache hit cannot inherit
an earlier build's measurements. Nine project tests passed in
`/tmp/p007-request-stage-tests-20260924.log`, including controlled75ms source
and125ms audit costs followed by a zero-build cache hit. That initial run was
unscoped; a final harness-scoped verification is still required after the last
source adjustment. The instrumentation is not yet runtime attribution.

Separately, upload regression test19345699 held the optional trend notification
after resolving the durable insert. The handler withheld its response:7 tests
passed and the new case failed as expected. The source now acknowledges the
committed row without awaiting that notification, using the existing polling
fallback. This proves and fixes the acknowledgement dependency; the historical
408's exact substage remains unknown. Final post-fix tests were refused before
execution while WI-10002932's separate in-tree mutation probe was active.
EI-24176734149355374 remains open pending verification; P-007 acceptance and
shipment remain open.

After that probe restored, run `21113ae7-964b-4d52-9750-2b8f9e158772`
passed17 tests with zero skips: ingest8 (`19348261`) and plan-read9
(`19348262`). Scoped typecheck caught a test-only `Response | Promise<Response>`
union; the test now normalizes it with `Promise.resolve`. The follow-up
typecheck reports zero errors in the four edited files, with23 other
import-graph diagnostics. The final ingest-test rerun after that typing
correction was fenced before execution by a newer, separate read-merge mutation
probe. Existing git-sync is active and reporting progress; neither those
source checks nor the acknowledgement fix establishes a native latency pass.
Current `PERF-P-007@1` requires ten valid native runs, each at most1500ms,
on the accepted build and frozen measurement profile.

The staging sync incident is separately fixed under `EI-24170757950252845`:
launcher stderr no longer contaminates its JSON receipt, and scheduled but
unobserved restarts enter the existing bounded wait, requiring a new PID and
exact source before success. The project Vitest suite passes65 tests, zero
skipped, including actual shell-fragment tests for mixed streams and pending
success/old-PID/wrong-source/refusal cases. Log
`/tmp/p007-staging-pending-final-tests-20260924.log`. Completion was recorded
as proposed pending commit identity settlement, not shipment.

### P-006 exact-clause audit follow-up

The old audit `EI-24158603642923031` reported a risk-floor replay disagreement
across evaluator builds. Current evaluator `6325d8e8b7` remeasured the unchanged
bindings11632/11630 and passed their exact-clause adequacy. New card
`EI-24166847672168490` received independent **PASS** via
`EI-24167243921891262`, auditor `role-7c9f52e2-d775-4696-a737-1b6d8723b182`,
at2026-09-24T18:07:59.863Z. Historical failed records remain intact. This is
exact `PERF-P-006@1` test adequacy; combined prose/budget/sustained acceptance
and whole-P-006 closure remain open.

### P-007 source and lifecycle timing boundaries — 2026-09-24 22:03Z

The native 21:46 run remains a failure at 1709ms. Its matching dispatch
29467611 measured source483.036ms and lifecycle288.304ms, but those totals
cannot distinguish pool setup from the query, parsing, or module loading.
The separate admin EXPLAIN is not evidence of the native app-role query time.

The existing `plansGetRead` invocation metadata now includes request-local
`detailMs`: source scope resolution, acquisition plus BEGIN/workspace setup,
query, transaction finalization, row conversion, and plan parsing; lifecycle
reader import, acquisition/setup, query, and finalization. These are wall
intervals, including event-loop scheduling; `query` is not PostgreSQL CPU time.
No query or RLS behavior changed. Cached responses carry no previous timing
sample, and timing data stays outside the plan payload.

Run `4fbb96db-8a8c-46c3-bb42-054be542dc9a` passed36 tests with zero skips:
read-timing19358076, lifecycle19358075, get-lifecycle-scope19358077, and
get-ship-readiness19358078. The clock-controlled attribution guard distinguishes
7ms from250ms queries while keeping100ms setup,3ms finalization, and11ms parse
separate. Scoped typecheck found zero diagnostics in the five changed source
and test files, with23 other import-graph diagnostics. Native measurement on
the activated diagnostic build is still required; these checks establish the
measurement boundaries, not an improved popup latency or acceptance pass.

The diagnostic source landed through5c78c636e3 andc1e041d09f (the latter
contains the former). Native run `/tmp/p007-native-detail-stages-20260924-2230.log`
used APIc1e041d09f/PID3465319 with the unchanged e41628 shell and938a5191 SPA.
It failed at1938ms and acknowledged16 measures as
`perfrun-1790289058794-3onqcz`. Matching invocation29474293 took1067ms,
including900.429ms in the plan handler. Source took312.950ms:42.793ms
acquisition/setup,82.922ms query,186.332ms finalization,0.102ms row conversion,
and0.733ms parsing. Lifecycle took425.918ms:413.049ms acquisition/setup,
10.395ms query and1.945ms finalization. This sample isolates the expensive
intervals; it does not establish a database-only cause for their wall time.

The next source change embeds the existing active-acceptance statement in the
plan's existing app-role SELECT, then uses lifecycle's existing pre-resolved
signal input. It preserves the shared SQL predicate and workspace filtering;
the separate admin rubric-summary reader has different failure/scope semantics
and is not substituted. Optional enrichment failure falls back to an ordinary
source read with an undefined signal, leaving the existing guarded lifecycle
lookup to distinguish unknown from measured absence.

Runf426c78e-9082-422f-a791-fe6419c5b231 passed the real PostgreSQL prefetch
suite and four existing unit files. The PG cases compare both workspace
results with the standalone reader, exclude inactive/archived/instance rubrics,
assert one source transaction, and exercise measured absence and failure
fallback. Final getter wiring test19358223 passed5 cases, zero skipped.
The scoped six-file typecheck is clean, with23 other import-graph diagnostics.
This optimization still requires commit, staging activation and native proof.

### Staging cutover safeguards discovered during P-007

EI-24180022773715880 now prepares the pinned target schema before stopping the
ready API, reusing `applyPendingMigrationsNow` and its backup rendezvous,
reservation, compatibility and snapshot guards (planD-003). Existing boot logic
can then handle a backup starting after preparation because the target has no
pending migration. Real-PG test19358159 passed, including that late-backup case;
final shell test19358229 passed71 cases, zero skipped. A real invocation logged
`target schema prepared: {"applied":0,"failed":[]}` before its restart request
at22:28:48Z. The stale engineering runbook was corrected through docs:author
and independently read back. This complements da314's migration-lint preflight.

EI-24183493174271355 arose when editing the long-running sync script shifted
the bytes Bash had not parsed yet. Both file versions passed `bash -n` while
the running process failed at a later offset. The existing script-snapshot
launcher now wraps the staging systemd entry and its mutable setup helper.
A deterministic FIFO regression rewrites the paused source: the raw launch
loses its original tail, while the snapshot preserves it. All9 launcher tests
passed (19358162). The tracked drop-in matches the installed file byte-for-byte,
systemd reports the wrapper in ExecStart, and the subsequent configured sync
completed successfully. These fixes and their source proof do not constitute
popup acceptance or final promotion.

### P-007 native prefetch result and independent enrichment reads

At23:32Z the unchanged native shell e41628 and SPA938a5191 against staging
19d7b93dda measured2013ms, failing the1500ms budget. Both private IPC
descriptors were refreshed against PID4048595 before the run. Log:
`/tmp/p007-native-prefetch-20260924-2332.log`; acknowledged16-measure result:
`perfrun-1790292738503-hir31n`. Cumulative request-start was343ms,
response1657ms, content1702ms, styles1716ms and preview1999ms.

Matching server invocation29485066 took1085ms, with1060.250ms in the plan
read. Source was76.741ms and lifecycle0.288ms, confirming the pre-resolved
lifecycle path was used. Issue blocks took319.679ms and test coverage553.648ms;
linked features19.047ms, rubric/audit46.231ms and stale paths44.243ms. These
are wall times. Earlier post-carry invocations29479951 and29480469 also had
source near25ms and lifecycle below1ms, with different slow enrichment stages.
This proves the extra lifecycle transaction is removed; it does not prove
native acceptance or a controlled distributional speedup.

The existing getter now overlaps the independent issue-block, linked-feature,
coverage and Now reads, joins their results before lifecycle, and overlaps
rubric/audit with stale-path inspection. Query predicates, cache identity,
selection and advisory failure behavior remain the same. Timing metadata says
`wall-time-per-stage-overlapping`: stage durations are no longer additive.
The new controlled rendezvous test holds issue blocks pending and requires
features/coverage to start before release, then checks returned badges and
lifecycle freshness. A second case verifies failed badge reads preserve the
plan and issue blocks. Final lifecycle suite19368600 passed7/0skipped; existing
shape, item, heading and ship-readiness suites19368590/91/93/94 passed43/0skipped.
An earlier new-test failure19368592 exposed a partial mock missing the real
timestamp normalizer; it was corrected before the final pass.

Both staging incidents are now closed with committed completion authority:
EI-24180022773715880 and EI-24183493174271355. After the initial snapshot
integration, setup required an adjacent `dependency-generation.sh`; the
existing snapshot launcher now copies adjacent shell helpers too. Final suite
19358689 passed10/0skipped, including mutation of that helper while paused.
Configured staging sync completed0 at23:28:11Z and `/api/health` returned
HTTP200/19d7b93dda at23:30:24Z. These are staging observations, not shipment.

### P-007 resumed native runs and response attribution — 2026-09-26

The owner explicitly resumed this lane. The frozen packaged GUI still has shell
SHA256 `e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`
and SPA index SHA256 `938a51916940a30806f1947fc96b4331bf005496d9d9099df67d77e28b6e8f9a`.
The pinned scenario remains `goal-agent-behavior-feedback-2026-09-06` in
`papercusp-workspace`, with both private IPC descriptors refreshed from the
live staging process before valid attempts.

| Staging API | Native log | Popup | Receipt | Verdict |
| --- | --- | ---: | --- | --- |
| `e44f174741` | `/tmp/p007-native-parallel-20260925.log` | 1010ms | `perfrun-1790380359573-8qzzkp` | pass |
| `e44f174741` | `/tmp/p007-native-parallel-20260925-run2.log` | 3591ms | `perfrun-1790380454630-bikpyk` | fail |
| `4c847070f7` | `/tmp/p007-native-parallel-20260925-newapi.log` | 3068ms | `perfrun-1790380776510-7bygjw` | fail |

Each valid receipt contains 16 persisted measures. The 3591ms run's request
interval was 317–3404ms; matching `plans:get` invocation29618758 spent
1010ms in the server, including a 761ms plan read. The 3068ms run's request
interval was 823–2783ms; invocation29619811 spent1441ms, including a
1391ms plan read and an 833ms rubric/audit stage. The unmeasured difference
between browser request interval and handler duration must not be called
database time. The current UI code now marks response headers separately from
parsed body so the next activated SPA can distinguish transport from JSON
processing. Its result test passed17 cases and scoped typecheck was clean.

In the existing server getter, rubric/audit depended only on the plan row but
started after issue, feature and coverage enrichment. It now starts with those
reads on full/sections requests; meta, heading and decision-narrow requests
still skip it. The new rendezvous guard requires rubric and audit to begin
before held issue-block work can finish, and narrow-request cases assert the
reads are skipped. Project run `03ee341e-2833-47ff-9627-f2eba1b43fd9` passed
39 tests with zero skips across four getter suites; scoped two-file typecheck
and diff check passed. This is source proof only: the overlap edit was still
uncommitted and had no native result at this write.

The WDIO publisher used the UI scenario workspace for selection but omitted
it from the ingest payload. A same-instrument positive-control database read
found the three receipts under `workspace_id=default`, not
`papercusp-workspace`; the publisher also stamped checkout HEAD as `git_sha`,
which does not identify this frozen GUI or its staging API. The publisher now
passes the selected workspace through the ingest route's existing
`workspaceId` field. Its Node suite passed9 tests and typecheck passed; a
new published receipt must verify the fix after activation. The checkout SHA
remains only a checkout correlation; the shell, SPA and API identities above
are the measured build profile. A separate native WebDriver mount termination
produced no popup timing and is excluded from the valid-run set.

`PERF-P-007@1` still requires ten valid native runs on one accepted build,
every popup at most1500ms. These results falsify acceptance on the measured
builds. FCP/LCP, independent acceptance, D-003 semantic activation audit and
final shipment remain open.

### P-007 response-header run and acquisition split — 2026-09-26

The live Git worktree registry places branch `staging` in the primary
`papercusp` checkout; the similarly named
`papercusp-staging` checkout is detached. The live staging systemd unit's
`WorkingDirectory` is `apps/operator` in that primary checkout, so the
detached checkout is not evidence of which source the running API loaded.
The private packaged fixture was copied to
`$HOME/.papercusp/perf/p007-native-current` so manual file locks
could cover fixture edits. Its shell SHA256 remains `e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`.
The refreshed SPA index SHA256 is
`e054e7cbac4e5eba6119adcc42d1f74ecbbeca00ca0c27519a61bce782327c41`;
its assets contain the new `response-headers` mark. Both private IPC descriptors
were copied from the PID/socket-verified live port3170 advertisement. The API
health endpoint reported build `64c532cb38` before the run.

The required-phase packaged WDIO run
`p007-64c532-e054-20260926-r01` measured **4817ms**, failing the1500ms budget.
Its click-to-phase readings were request-start336ms, response-headers4503ms,
response-ready4516ms, and preview-rendered4809ms. The browser request to
headers interval was4167ms; JSON parsing contributed13ms. The UI scheduler's
foreground-read queue-wait total rose only1ms across the popup, so its own
queue is not the observed multi-second interval. Log:
`$HOME/.papercusp/perf/p007-native-current/run-001.log`.
The publisher wrote16 measures as receipt `perfrun-1790383531556-u5sub5` with
`workspace_id=papercusp-workspace`, confirming the workspace payload fix at
runtime. Its `git_sha=5c56b715cb4ed6e0d5f0d702048d51267ae15f1d` identifies
the WDIO checkout, not the shell, SPA or staging API.

Matching `plans:get` invocation29625800 on API build64c532 took2801ms.
The plan-source read took1964ms, including1913ms before the source query;
the query itself took46ms. Rubric/audit took519ms and stale paths428ms,
with those enrichment stages overlapping. `source.acquireAndSetup` currently
combines pool wait, connection/BEGIN and transaction-local workspace setup;
this run does not identify which subphase caused the1913ms. Earlier valid
failures' matching invocations29618758 and29619811 spent9ms and7ms there,
respectively, so the cost is variable. The browser-to-server residual is also
unattributed; no database-only claim is supported by the4167ms interval.

A same-build second attempt, `p007-64c532-e054-20260926-r02`, lost its
WebDriver session while waiting for app mount. It produced no popup measure or
receipt and is excluded from acceptance. Log:
`$HOME/.papercusp/perf/p007-native-current/run-002.log`;
the existing mount-termination issue is EI-24280898105217857.

The existing `withWorkspace` options now offer a diagnostic `begin` / `ready`
callback, and the plan-source timing adds `source.waitForBegin` (pool wait,
connection and BEGIN combined) plus `source.workspaceSetup` while retaining
`source.acquireAndSetup`. The real wrapper ordering test passed10/10; the
plan-source attribution suite passed3/3. DB-org and operator-core package
typechecks and `git diff --check` passed. This instrumentation is source proof
only: it had not been committed, activated on :3170, or remeasured natively
at this write. P-007 remains open.

### P-007 packaged runner recovery and named receipt — 2026-09-26

The repeated mount failure was a fixture navigation race. In invalid run
`run-002.log`, WebDriver was still at `about:blank` when the popup spec read
`location.href`; changing its pathname and query yielded
`about:blank?ws=papercusp-workspace&opcv=plans`, which the spec navigated to.
The earlier valid run had produced
`papercusp://localhost/adv?ws=papercusp-workspace&opcv=plans` at the same site.
The spec now waits for a host-bearing packaged document URL before applying
the workspace query, and URL discovery plus app mount share the original mount
timeout. The runner's real Node suite passed10/10, including an `about:blank`
counterexample, and its typecheck passed. This fixes the test's invalid
navigation path; the WebKit page-crash message itself remains a downstream
symptom, not a proven WebKit defect.

The same existing publisher payload builder now sets `gitSha:null` for a
named `PAPERCUSP_PERF_RUN_ID`, because the checkout HEAD is not the frozen
shell/SPA/live API build. Unnamed runs retain checkout correlation. The
runner README describes the profile convention; its10-test suite and typecheck
passed. No new ingest field or table was added.

A new real packaged run used shell `e41628e0`, SPA index `e054e7cb`, and
staging API `e97031f294`; the private IPC files were refreshed to live PID
1570985. The log at
`$HOME/.papercusp/perf/p007-native-current/run-003.log`
shows navigation to `papercusp://localhost/adv?ws=papercusp-workspace&opcv=plans`
and a rendered pinned plan. Its **1825ms** popup still exceeded1500ms.
Request-start was329ms, response-headers1592ms, response-ready1604ms, and
preview-rendered1818ms. Receipt `perfrun-1790384860776-t03lf7` persisted16
real measures with `workspace_id=papercusp-workspace`, `git_sha=NULL`, and
`run_id=p007-e41628-e054e7-e97031-20260926-r03`. Matching `plans:get`
invocation29628521 took1218ms (source acquisition/setup273ms, query11ms,
rubric/audit356ms) on API build e97031f294.

This run verifies both harness fixes at runtime but falsifies P-007 latency
acceptance on this profile. The new source acquisition split was still dirty
and absent from the e97031f294 API at this write; the next valid run must
verify its deployed stage fields before attributing the variable wait.

### P-007 packaged Web Vitals smoke on the same frozen shell and SPA — 2026-09-26

The packaged `smoke.spec.ts` instrument reported `ready` with **FCP 2972ms**
and **LCP 4441ms** on shell SHA256 `e41628e0`, SPA index SHA256 `e054e7cb`,
and staging API `e97031f294`. FCP met its 3000ms budget; LCP exceeded its
4000ms budget. INP, CLS and TTFB retained their documented environmental
classifications. The native smoke spec passed its instrument assertions, and
publisher receipt `perfrun-1790385620425-7ttznj` stored ten measures under
`papercusp-workspace` with one over budget and status `fail`. The raw log is
`$HOME/.papercusp/perf/p007-native-current/run-004-smoke.log`.
This is one cold packaged sample on that build profile, not a distributional
latency or P-007 acceptance result. No cause is assigned to the LCP value.

### P-007 activated timing split and variable native popup — 2026-09-26

Git-sync commit `da16252fd3` contains the source acquisition split, the
`libs/papercusp` DB wrapper pin, and the packaged runner mount guard. The
isolated staging sync completed at 01:28:39Z; `/api/health` reported
`da16252fd3`, and both private IPC descriptors were refreshed to the live
PID 3923358 and its socket. Shell `e41628e0` and SPA index `e054e7cb`
remained frozen.

Named packaged run `p007-e41628-e054e7-da1625-20260926-r05` measured
**2919ms**, failing the 1500ms popup budget. Request-started was 662ms,
response-headers 2545ms, response-ready 2584ms, and preview-rendered
2911ms. The publisher stored 17 measures as
`perfrun-1790386201980-pii25e` with status `fail`. In the same short window,
the single recorded full `plans:get` for the pinned slug was invocation
29630889 on build `da16252fd3`; its 1316ms dispatch duration included a
1199.6ms cold read with `source.waitForBegin` 39.8ms,
`source.workspaceSetup` 571.5ms, `source.query` 66.1ms, and
`stalePaths` 385.5ms. These are overlapping wall intervals, not DB CPU.
The browser click's absolute timestamp was not logged, so temporal pairing
is a scoped correlation, not proof that the full browser request interval
equals this dispatch span.

Named run `p007-e41628-e054e7-da1625-20260926-r06` measured **918ms**
and published 17 passing measures as `perfrun-1790386294000-uc3l70`.
Its recorded `plans:get` invocation29631091 took 22ms, while
`plansGetRead.buildState=running` and `waitMs=0.216ms` show the cached read
returned as a background refresh ran. This warm result does not clear the
failed cold result. Raw logs are `run-005-popup.log` and `run-006-popup.log`
under `$HOME/.papercusp/perf/p007-native-current/`.

Correction to the initial analysis: `tool_invocations.invoked_at` is stamped
at dispatch settlement in `projected-tool-deps.ts`, not request start. A
browser-to-server residual derived by treating it as a start timestamp was
wrong and is retracted; this evidence assigns no number to that residual.
The server stage values and browser phase values above remain observed.

The shared workspace transaction wrapper currently awaits separate
transaction-local `search_path` and `app.workspace_id` setup statements on
pooled app connections. The canonical source now combines those independent
settings in one SQL round trip, with unit proof (11/11), real-Postgres
integration proof (8/8), DB package typecheck, and diff check passing. This
source change is still uncommitted/unactivated at this write. The measured
571.5ms was the prior **combined setup interval**; no per-statement cost or
native improvement is claimed yet.

### P-007 same-build repeats and hot-path attribution — 2026-09-26

Staging API build `bcf4dbf223` contains the combined transaction-local
workspace setup and the `stalePaths.resolveRoot` / `stalePaths.scan`
diagnostics. The frozen shell and SPA remain `e41628e0` / `e054e7cb`.
Packaged popup run r14 measured **1405ms** (receipt
`perfrun-1790388457077-4u4vzh`, pass). Its same-window full
`plans:get` invocation29635511 took624ms: cold read600.9ms,
`source.workspaceSetup`176.9ms, `stalePaths.resolveRoot`51.1ms and
`stalePaths.scan`0.14ms. This one sample cannot isolate the saved time
from the combined SQL statement because its predecessor ran under different
conditions. The r14 start-wall log was missing: the test had read the
`:start` mark AFTER `endInteraction` consumes that mark. The runner now
derives absolute start from the completed measure's `startTime` and fails
an unmeasurable sample if that value is absent.

Run r17 verified the corrected timestamp path in the real packaged suite:
absolute start `2026-09-26T02:13:15.028Z`, popup **1003ms**, receipt
`perfrun-1790388799207-u3pyzp` pass. Its request-start phase was372ms,
response headers715ms, preview997ms. Full `plans:get` invocation29636225
settled at02:13:15.730Z after104ms; the unique pinned slug, build and
timestamp establish this run's correlation. Its `buildState=running` and
`waitMs=0.278ms` mean the cached response returned while refresh ran, so
r17 is warm evidence.

With the existing page event-loop probe enabled, r18 measured **1713ms**
and failed the1500ms budget (receipt `perfrun-1790388911717-6qgo1i`).
Absolute start was02:15:07.681Z; request-start615ms, headers1499ms,
response-ready1510ms and preview1707ms. The matching
`plans:get` invocation29636459 took746ms, with a cold read729.3ms:
`source.workspaceSetup`40.4ms, `source.finishTransaction`354.5ms,
`stalePaths.resolveRoot`255.7ms and `stalePaths.scan`0.10ms. The
page probe observed event-loop gaps of255ms and370ms in this interval;
its DOM layout hook reported no >=10ms layout operation. The root lookup
was issuing `git rev-parse --show-toplevel` even when the caller supplied
the known worktree root. Current source now checks that root's `.git`
entry first and reserves Git for nested/unknown paths. A real throwaway
repo test removes Git from PATH and still resolves cited paths at the
explicit root; the focused suite passed30/30 and diff check passed.
This new source fix is uncommitted/unactivated at this write; no native
latency improvement is claimed.

Web Vitals remain variable on the same frozen shell/SPA: smoke r08 recorded
FCP10092/LCP11233 (fail), r09 2347/3428 (pass), r10 4291/5582 (fail),
r11 2697/3722 (pass), r12 2213/3311 (pass), and r15 2392/3363
(pass). All named receipts are in the corresponding `run-NNN-smoke.log`
files under the private fixture directory. The r10/r11 page traces showed
cumulative foreground scheduler wait of14855ms versus2323ms across69
requests, but that SUM is not a first-paint critical path. CPU PSI was
not higher in the slow sample (start 0.62% vs0.96%, end0% vs2.92%).
A corrected bounded query-ring probe now separates requests completed
before FCP from requests merely started before it. In r15, zero recorded
queries completed before FCP and eight started before FCP but completed
later; its FCP2392ms passed. An r12 snapshot showed 16 queued foreground
requests and several later 20s queue timeouts despite FCP2213ms passing.
This separate unconfirmed post-paint queue defect is tracked as
WI-10003191. These observations do not establish a cause for the FCP/LCP
variance or a ten-run P-007 acceptance result.

Smoke r19 used the same frozen shell and SPA with API build `ac0cb93e81`.
The packaged instrument reported FCP **2383ms** and LCP **3456ms**, both
within budget, and published ten measures as
`perfrun-1790390021053-v1gwnn` (pass). Its bounded query-ring probe found
zero queries completed before FCP; eight started before FCP and completed
later. This one passing sample does not identify the cause of the earlier
slow paints. Raw log:
`$HOME/.papercusp/perf/p007-native-current/run-019-smoke.log`.

### P-007 active enrichment timing and body-first follow-up — 2026-09-26

The known-root stale-path fix reached staging API `aa7c7a1e93`: native r21
still failed at **1870ms**, while its matching cold `plans:get` took697ms.
`stalePaths.resolveRoot` had fallen to0.03ms; the remaining long stages were
overlapping enrichment reads. On API `835b4d17a8`, smoke r24 measured
FCP2945/LCP4325 (LCP fail), while r25 measured FCP2406/LCP3502 (pass).
The r25 LCP entry was a text `DIV` with `loadMs=0`; no image-load cause is
inferred. Both profiles used the same frozen shell and SPA described above.

After the per-enrichment timing split committed, staging API `104948524e`
served two guarded native cold popups. r26 measured **2225ms** (receipt
`perfrun-1790394892683-vp338e`); r27 measured **1502ms** (receipt
`perfrun-1790395123191-yo6d58`). Both exceed the1500ms budget. Their
private IPC descriptors matched live PID3974231 at start and end, and their
foreground/interactive scheduler snapshots had queue0 and timeout0. Logs:
`$HOME/.papercusp/perf/p007-native-current/run-026-popup-enrichments.log`
and `run-027-popup-warm.log` beside it.

The matching `plans:get` invocations `29648251` and `29648585` measured
wait872ms and474ms. Source read was76ms and74ms. The first invocation's
overlapping optional reads included test coverage794ms, linked features794ms,
rubric/audit642ms and issue blocks354ms; the second's longest optional reads
were about399ms. Transaction-local workspace setup accounted for561ms and
376ms within the feature/test reads. The server also logged event-loop lag
in each native interval, so these measurements identify the **body's wait on
optional enrichments**, not the underlying cause of each stall.

Current source therefore returns the full plan body with
`includeEnrichments:false` on the popup's first REST read. A separate one-shot
read hydrates live badges, test coverage and issue status after the document
paints; edit/status actions stay disabled until it finishes. The lightweight
and full cache keys are separate. Five focused project test files passed
**75/75**, scoped formatting and diff checks passed, and operator-core
typecheck was baseline-clean. Operator UI typecheck reports no new error in
these paths; it remains red on three TS7006 diagnostics in the unrelated
`verify-identities-r4.test.ts`. This body-first change is **source-verified
only** at this write: its nine paths await git-sync and active staging native
remeasurement. Ten valid same-build popup runs, paint variance, independent
acceptance and shipment remain open. The separate restart-overlap/fixture
issue `WI-10003191` was completed with stable native runs and a changing
live-socket counterexample; no steady-state scheduler queue defect was
reproduced.

### P-007 body-first activated; host main-thread saturation — 2026-09-26 15:25Z

The body-first source (`get.ts` 450e7f2165, `plans-api.ts` /
`_plans-args.ts` 8d58bce7aa) is in staging API `65060e4abc`: blobs for all
three paths equal `staging`. The frozen fixture SPA `e054e7cb` did **not**
contain the client half (0 asset files match `includeEnrichments`, positive
control `response-headers` 1), so a run on it could never exercise the fix.
The fixture SPA was replaced by the canonical `apps/operator-vite/dist` built
15:18:54Z (index SHA256 `61b3e23247c8…`, 1 asset file with the new call);
the previous SPA is kept beside it as `sidecar/spa.e054e7cb`. Both private
IPC descriptors were refreshed to live PID 2214020 (started 15:08:48Z).

Named run `p007-e41628-61b3e2-65060e-20260926-r28` measured **2296ms**
(FAIL, receipt `perfrun-1790436350495-en13hp`, log
`$HOME/.papercusp/perf/p007-native-current/run-028-popup-bodyfirst.log`):
request-started 305, response-headers 2048, preview-rendered 2289. Its first
`plans:get` (invocation 29694809) carried `includeEnrichments:false` and
recorded **no** enrichment stages; dispatch took 544ms (`waitMs` 360,
`source.waitForBegin` 281). The later hydration read (29694820, 687ms)
carried the enrichments. So the fix works as designed, and the remaining
wait is outside the handler: dispatch began ≈1445ms after the click
(settle time minus duration; `invoked_at` is stamped at settlement), about
1140ms after the browser's request-started mark.

The staging host was CPU-bound on its main thread in that window: its lag
monitor logged p95 297ms / p99 518ms / max 944ms for the 10s ending
15:25:44.885Z, beside `plans.attentionCounts` 4222ms and `plans.list`
3519ms sync reads. Between 15:10 and 15:27Z the single :3170 process served
1,524 MCP-transport tool calls from ~18 agent sessions, versus ~800 across
:3070's six cluster workers. psu sessions launched from the staging desktop
inherit `PAPERCUSP_OPERATOR_URL`/`PAPERCUSP_API_BASE` = `:3170`
(`console-launcher.ts` / `spawn-config.ts` derive it from the launching
request), so their hook traffic lands on the process serving the UI;
`:3170` runs without `PAPERCUSP_CLUSTER_WORKERS`. The popup budget is
therefore currently measured against fleet load, not only plan-read code.

Loop-saturation profiles of that process
(`~/.papercusp/loop-profiles/loop-saturation-1790435495838-pid2214020-p95_160ms.cpuprofile`
and `…1790436378631-…p95_42ms`) attribute self time to `spawn` (14.2% /
11.9%), `fnv1a64` (10.1% / 6.1%) plus its registry/delta callers, and plan
parsing (`maskFences`, `parseItemLine`, `splitSections`, a `[a-z]\n[a-z]`
regex). `fnv1a64` did a BigInt XOR and multiply per code unit; WI-10003260
replaces both tooldef FNV loops with a bit-exact 16-bit-limb version
(102 tests pass, including a BigInt reference kept as control; same output,
11.5× faster on a 224,671-char body). Its effect on the staging main thread is
not yet measured. P-007 acceptance remains open.

### P-007 ten-run set after the fnv1a64 + agent-config fixes — 2026-09-26 16:32Z

Staging API `7d787f2c51` carries both fixes: agent-config route blob
`f09e3dfa13` (WI-10003266) and tooldef gitlink `43bb505` (WI-10003260).
staging-sync advanced to it from the local committed `staging`. All runs below
used one process (PID 2509156, started 16:14:39Z), frozen shell `e41628`,
fixture SPA `61b3e2`, and plan `goal-agent-behavior-feedback-2026-09-06`.
Runner: `~/.papercusp/perf/p007-native-current/run-native-popup-batch.sh`
(pins the PID and stops on a restart).

| run | popup ms | request-started | response-headers | preview-rendered | receipt |
| --- | ---: | ---: | ---: | ---: | --- |
| r31 | 856 | 321 | 520 | 847 | perfrun-1790439427667-tj3rz8 |
| r32 | 1212 | | | | perfrun-1790439529371-6bsk1i |
| r33 | **>8000** | 301 | 422 | (response-ready 28298) | none |
| r34 | 1378 | | | | perfrun-1790439610521-lvyl46 |
| r35 | 1179 | | | | perfrun-1790439632679-zco33k |
| r36 | **>8000** | 369 | none in 8s | — | none |
| r37 | 1083 | | | | perfrun-1790439701674-m7e207 |
| r38 | 1440 | | | | perfrun-1790439743838-0cqdc1 |
| r39 | 788 | | | | perfrun-1790439783997-fc3liu |
| r40 | **>8000** | 1947 | 8071 | — | none |

**Verdict: 7/10 within 1500ms, 3/10 over 8000ms. Ten-run acceptance FAILS on
tail latency.** The median improved sharply (r28 was 2296ms before the fixes).

**Instrument defect.** The harness reported r33/r36/r40 as `UNMEASURABLE: no
dashboard plan opened`. Each of those clicks did happen: the popup stayed on
`Loading goal-agent-behavior-feedback…` past the 8s `MEASURE_WAIT_MS`.
`plan-popup-open.perf.spec.ts` maps a post-click measure timeout (`.catch(() =>
"timeout")`) to "row not opened", so slow popups are dropped from the verdict
and no receipt is published. Left uncorrected, this biases every ten-run set
toward a pass.

**Tail cause (partial).** The three slow runs coincide with :3170 main-thread
stalls from its lag monitor: maxMs 5104 (16:20:49Z), 3737 (16:21:00Z),
**20669** (16:21:27Z), and 3565 (16:23:32Z). The saturation profile from that
window (`loop-saturation-1790439654103-pid2509156-p95_666ms`, 97.8% busy)
attributes about 13% of self time to the task-manager live scan's synchronous
`/proc/<pid>/exe` + `/proc/<pid>/environ` reads (`runLiveScan` →
`projectLiveProcess` → `readProcessMetadata`), filed as EI-24342043796392664.
GC takes 16% and tool-catalog projection about 7%. Profiles show the old BigInt
`fnv1a64` gone (the fast version is 2.3%) and `spawn` down from 12–14% to 1–4%.

## P-008 secondary-lead evidence — 2026-10-01

**P-008 remains open.** These receipts advance F11/F12 attribution; they do
not establish universal R-8 acceptance or final shipment. WI-10002830 owns
the remaining local investigation. Portal remains the separately owned
EI-24354725412855158, assigned to fleet leader su-0da9d55e; its failed
systemd-notify barrier is a measured precursor, with root cause unconfirmed.

| Lead | Evidence and disposition | Remaining limit |
|---|---|---|
| Gateway local admission 429 | An unmarked local 429 was classified as `upstream-429` despite zero upstream attempts. The existing `shed` bit now marks all-throttled, metered-never and admission-timeout exits. Actual HTTP regression cases distinguish local shedding from a real upstream 429. The saved 01:29Z canonical matrix passed 268 tests across three files, exit 0, with no skips. | Saved source snapshot at `244f7d127c` plus local tests; no live gateway adoption or current universal acceptance claim. Exact fingerprints and command remain on WI-10002830. |
| Proxy paired reset messages | `recordInboundClientError` calls `recordInboundSocketReset` and then logs the client error. One socket error therefore produces both categories; a WeakSet deduplicates the reset counter per socket. At source `2dc4a60da4`, the canonical `proxy.test.ts` case `records clientError/socket-reset` passed, exit 0: one client error and one reset, not two independent user failures. | One selected test passed; 322 other cases were excluded and provide no evidence in this run. Existing journal categories cannot identify every failed user action or distinguish every cancellation from an upstream fault. |
| Migration-readiness/ref-announcement failures | WI-10002822 records the one-shot boot gate as the origin: failure returned before substrate boot, while the once-per-process migration helper could not retry. Its maintained retry path uses `applyPendingMigrationsNow`, preserves the backup boundary, and alarms after prolonged withholding. Stored comment WI-10002822#comment:1143176 reports recovery within three seconds of migration application on September 24. | This reuses a dated, authoritative recovery receipt; no P2P operation or fresh induced outage was performed. Upstream migration-reservation failures and current loaded-build adoption are separate questions. |
| Ingestion scan/cost | `session-ingest.ts` increments `filesScanned` before the unchanged-byte-offset skip. It counts candidate visits, not files decoded or fully re-read. A fresh chronological sample below confirms useful incremental ingestion alongside long wall times. | The cost remains unresolved. Candidate-count semantics do not explain the long passes, and successful ingestion does not establish acceptable cost. |
| Historical account polling | A bounded September 23 ledger read identifies the high-volume caller as `pui-2057122`, `spawn_id=palette`, on staging builds, with the last retained high-volume group ending at 19:19:10Z. The separate saved current-hour read contains 60 calls from `loopback/pui-2221762`, also `palette`, on release build `29bf735091`. | This identifies the consumer class, not the exact polling component or a causal contribution to app latency. The historical and current windows differ; they are not a before/after performance comparison. |
| Broad forensic DO scan | The prior same-database/current-backend positive-control query found no matching active DO scan. The supported `dev:pg_query` surface bounds acquisition and statement execution and accepts a positive control for absence claims. | Absence of that active query does not measure all diagnostic demand or prove the historical scan caused app slowdown. |
| In-process embedding warning | `ensureEmbedSidecar` emits this warning once per process when no sidecar is configured; the source explicitly supports that configuration. The warning alone is not evidence of resource pressure. | Historical hosted-process configuration and request impact remain unverified. P-006/WI-10002828 retains its own strict memory evidence and contract blocker. |
| Loop lag / routine shedding | The audit counts remain retained warning-line categories, not independent incidents or a quantified app slowdown. | Current causal disposition still belongs in this investigation; no blanket non-defect claim. |

### Chronological ingestion observation

At 01:49:39Z, a bounded journal read of the actual
`papercusp-bg-host.service` covered 00:49:39Z onward, with a 200-record cap.
It returned 26 matching records and parsed 26 ingestion passes. The service
reported active, PID 697212, start time 01:20:09Z, and canonical working
directory `papercusp/apps/operator`. The pass records were sorted by timestamp
before selecting the latest observations. This supersedes the earlier
reverse-time sample selection in `/tmp/p008-ingest-evidence.json`.

| Pass completed (UTC) | New turns | Decoded files | Candidate visits | Wall ms | Reported errors |
|---|---:|---:|---:|---:|---:|
| 01:32:44 | 64 | 77 | 4742 | 11770 | 0 |
| 01:34:43 | 76 | 86 | 4753 | 4544 | 0 |
| 01:36:53 | 75 | 85 | 4760 | 13461 | 0 |
| 01:39:44 | 57 | 70 | 4766 | 69520 | 0 |
| 01:42:13 | 47 | 78 | 4768 | 76653 | 0 |
| 01:42:47 | 31 | 74 | 4773 | 8508 | 0 |
| 01:45:59 | 103 | 81 | 4777 | 84986 | 0 |
| 01:46:54 | 37 | 79 | 4781 | 14335 | 0 |

The 26 observed passes range from 2993 to 131882ms. These are retrospective
wall times on changing workloads. Loaded-source identity and a representative
workload were not frozen, so this is neither a p95 acceptance measurement nor
evidence for a CPU, memory or candidate-walk cause. Next, attribute discovery,
metadata reads, offset checks, decoding and database insertion in the existing
ingestion path before choosing a fix.

Evidence: `/tmp/p008-ingest-sorted-20261001.json`, completed task
`0muovmcndw26eg4wh5j`; `/tmp/p008-proxy-pair-20261001.log`, canonical test
receipt at 01:51:51Z; gateway receipts and fingerprints on WI-10002830.
`tool_invocations.output_size` is conservatively reported as serialized result
units: its dispatch fallback is `JSON.stringify(r.content).length`, not a
measured UTF-8 byte count. No resource-pressure cause is inferred from it.

### Ingestion phase attribution instrumentation — 02:19Z

The existing `runSessionIngestOnce` stats now carry exclusive monotonic wall-time
buckets for setup, historical backfills, discovery/stat, state loading, candidate
metadata, decoding, per-file writes, metadata repair, chats, and other bookkeeping.
These include awaited and scheduling time; they are not CPU or connection-acquisition
measurements. Failed async operations retain their elapsed time. The existing
periodic-workflow log includes the bounded phase object and reports completed
no-progress sweeps lasting at least five seconds, closing the prior detector gap
where slow unchanged-file work could be invisible. Skipped sweeps remain suppressed.

The canonical five-file run at local source HEAD `37bc2d4c32` plus these edits passed
57 tests, with no skips, exit 0. It covers phase partitioning with deterministic
filesystem/query costs, unchanged-byte skips with metadata repair, failed-write
timing without offset advancement, sweep-latch release, slow-empty logging,
faithful-parts-only logging, and the existing parser/metadata/walker/yield guards.
This is source correctness evidence, not a production latency result.

Command: `PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-phases.test.ts packages/operator-core/lib/search/session-ingest.test.ts packages/operator-core/lib/search/session-ingest-adv-metadata.test.ts packages/operator-core/lib/search/session-ingest-walker.test.ts packages/operator-core/lib/search/session-ingest-yield.test.ts`.
Receipt: `/tmp/p008-ingest-phase-matrix-20261001.log`, started 02:18:35.867Z.
Source SHA-256: `session-ingest.ts` =
`a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`;
test = `37a5bedc387b77b6b201a076f8ffcb5e348eee7725ddbd0a3f9073af6694839d`;
`periodic-workflows.ts` = `832d8450193ba0b3c48576319091996f536747da8c5392dc5010b005abe69854`.
Scoped diff-check passed. The separate `npm run lint:tsc` failed on seven regressed
files outside these edited paths; its receipt is
`/tmp/p008-ingest-phase-typecheck-20261001.log`. No whole-tree typecheck pass is claimed.

The current-build route read names an isolated bg-host assertion via
`node scripts/with-test-pg.mjs --isolated-runtime -- <current-build background assertion>`:
disposable migrated DB, HOME/keychain/workspace/ports, stripped runtime credentials,
private-state-write and teardown proof. It still requires a concrete background
assertion. The same read reports bg-host build `244f7d127c` from runtime-vintage,
with `containsChange:false`; the observed PID remains 697212. The new phase data has
not been measured on a loaded runtime. No shared-host restart or live adoption is claimed.

A bounded 01:45:08–02:10:08Z preflight retained 67 matching journal records (cap 160)
from that service. Its 02:09:18Z pass ingested 57 turns and 655 parts from 84 decoded
files after 4846 candidate visits, taking 28810ms with zero reported errors.
The existing profile `loop-saturation-1790820554533-pid697212-p95_52ms.cpuprofile`
overlaps that pass: 301 samples cover 2984.296ms, with 30.316ms of sample weight
having a `runSessionIngestOnce` ancestor in the loaded `dist-host/hono-host.mjs`.
Async continuations and unsampled periods are not attributed by that ancestry test;
this is neither an upper bound on ingestion CPU nor an explanation of the full
pass duration. The retained window also contains acquire-plus-SELECT1 shed messages
and delayed-recorder-rotation messages. Those labels do not establish database,
memory, CPU, or ingestion causality.

Evidence: `/tmp/p008-ingest-phase-preflight-20261001.json` (task
`0muowcorpcbsv2fcmr0`, completed exit 0),
`/tmp/p008-ingest-profile-attribution-20261001.json`, and the profile path above.
**P-008 remains open and unaccepted.** Next: exercise the maintained isolated
background route with a pinned workload and explicit cleanup, then compare its
phase costs before choosing a performance fix.

### Isolated ingestion execution and phase receipt — 02:46Z

The new project integration fixture
`packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`
uses the maintained `with-test-pg.mjs --isolated-runtime` route. A fresh Node/tsx
child executes the real `runSessionIngestOnce`, adapters, filesystem, clock,
flags and database. Its preflight verifies private HOME/workspace, the wrapper's
loopback PG port, stripped agent credentials/IPC, background environment and
disabled global routines. Source SHA-256 is checked before and after execution.
The fixture invokes background ingestion directly; shared bg-host adoption and
the complete DBOS host lifecycle remain unmeasured by this fixture.

Workload `synthetic-offset-tail-v1` fixes 320 managed Codex homes with 15 rollouts
each: 4,800 candidate files and 80 changed tails per useful pass. Each useful pass
adds exactly 64 text turns and 640 faithful parts. A nonempty metadata prefix and
its saved offset model unchanged files; offsets on the 80 private files are reset
between three repetitions while their turn/part indices keep increasing. The
final unchanged pass must perform zero decoding/writes and insert no duplicates.
This deliberately small synthetic content matches the observed candidate/tail
scale; live transcript contents, backlog, concurrent requests and pool contention
are outside its measured scope. These repetitions are descriptive phase receipts,
not paired control/candidate windows or a production p95 acceptance result.

| Fixed pass | Total wall ms | Discovery ms | State ms | Metadata ms | Decode ms | Writes ms |
|---|---:|---:|---:|---:|---:|---:|
| Initial unchanged | 720 | 396.0 | 17.4 | 275.1 | 0 | 0 |
| New tail 1 | 2105 | 418.9 | 16.4 | 287.8 | 976.2 | 379.8 |
| New tail 2 | 2265 | 418.3 | 17.3 | 293.7 | 1071.0 | 435.6 |
| New tail 3 | 2042 | 372.9 | 12.3 | 265.4 | 961.0 | 408.4 |
| Final unchanged | 585 | 322.9 | 15.3 | 222.8 | 0 | 0 |

The other exclusive phase buckets remain in the full log receipt; the test checks
their sum against total wall time, finite nonnegative durations, no errors or
historical backfill, exact useful outputs, and byte offsets equal to file sizes.
It read back 192 private turns and 1,920 private parts. After the child exited,
the test confirmed removal of its HOME and PG data directory and an
`ECONNREFUSED` probe on the private database port. In this fixture, decode is the
largest useful-pass bucket; discovery and metadata dominate the unchanged pass.
Await/scheduling time is included, so these buckets do not establish CPU cost or
the mechanism behind the previously observed live 69–85-second passes.

Canonical command: `PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`.
One integration test passed, zero skipped, native command exit 0, at 02:46Z.
Receipt: `/tmp/p008-ingest-runtime-20261001-r4.log`; loaded child HEAD
`eef7edb49fe872a03813f14c40145604b88ed8d8` plus the local untracked test.
Source SHA-256: `a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`;
test: `34ae4ca795bce991ef39a8b2570173303d200b4745b43b199674654fad4dea14`;
workload descriptor: `417b4388c355a7f415df05df56d3904a314be517ced4ec6bf61fe0c222249421`.
The source fingerprint matches the prior five-file 57-test regression receipt;
those proofs were reused without a reconstruction rerun.

The first three attempt logs remain separate. They failed respectively on nested
SQL template syntax, an overly specific loopback hostname assertion, and empty
seed files excluded by the real candidate filter. Before the successful attempt,
the harness gained a child syntax preflight, bound SQL parameters, accepted
loopback spellings with exact wrapper-port checks, nonempty prefix/offset seeds,
production-walker layout preflight, and cleanup assertions on failing children.
Their failed outcomes are not performance samples and were not replaced in an
acceptance matrix. No whole-tree typecheck, shared-runtime adoption, shipment,
live latency improvement, or R-8 acceptance is claimed. **P-008 remains open.**

### Frozen mixed-record tail measurement — 03:07Z

The maintained integration fixture now also accepts a local frozen Codex tail.
It checks the tail SHA-256 before and after execution, complete JSONL records,
the per-file byte bound and useful-turn budget. The guarded adapter preflight
determines expected outputs before private writes; the fixture still verifies
real database counts, file offsets, the final unchanged pass and teardown. Raw
transcript content stays outside the repository and is absent from receipts.
The default synthetic mode remains self-contained for CI.

This run selected the last 100 complete records from this worker's ended native
session `01a0f54a-98ea-7d61-8565-eff52bada864`, under managed home `session-32189`.
The immutable source rollout SHA-256 is
`daf3b19c556879679f73cc71e49822eda166ac5756cfffb19586787ffd16f4a7`;
the selected tail SHA-256 is
`aca19605813043b6c1ba7d82bd89344f50c90aee1bddf47bcd51aec0064eb37e`.
Each of 80 changed files receives the same 214,497-byte, 100-record tail among
4,800 candidates. Its mix includes messages, reasoning, tool calls/results,
completion events and token records. This produces 240 recall turns and 2,160
faithful parts per pass; three repetitions read back 720 turns and 6,480 parts.
Replaying one tail 80 times is a frozen local sample, not a census of live
transcripts, concurrent work, database state or the full background-host lifecycle.

| Frozen pass | Wall ms | Discovery ms | Metadata ms | Decode ms | Writes ms | Child process CPU ms |
|---|---:|---:|---:|---:|---:|---:|
| New tail 1 | 4699 | 1201.1 | 568.4 | 970.8 | 1834.8 | 2268.8 |
| New tail 2 | 4048 | 1075.7 | 433.5 | 1156.6 | 1280.3 | 1854.6 |
| New tail 3 | 3060 | 1051.2 | 381.9 | 708.6 | 864.0 | 1689.1 |
| Final unchanged | 913 | 603.9 | 272.9 | 0 | 0 | unmeasured |

CPU is `process.cpuUsage` user plus system microseconds divided by 1,000,
bracketing each entire ingestion pass in the child. It includes all threads in
that process, excludes the separate PostgreSQL process, and is not per-phase
CPU or a connection-acquisition measurement. Phase buckets remain exclusive
wall times including awaits and scheduling. These runs do not reproduce the
saved 69–85-second live sweeps and do not identify their cause. They are not a
paired performance comparison with the earlier synthetic runs.

The frozen mode passed one canonical integration test, zero skips, native exit 0;
receipt `/tmp/p008-ingest-frozen-runtime-20261001-r1.log`, test start 03:06:06Z.
The default synthetic regression also passed one integration test, zero skips,
native exit 0; `/tmp/p008-ingest-runtime-default-20261001-r5.log`, start 03:07:45Z.
Both confirm private HOME/data-directory removal and a refused database port.
Loaded child HEAD remains `eef7edb49fe872a03813f14c40145604b88ed8d8` plus the local
untracked fixture. Ingestion source SHA-256 remains `a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`;
updated test SHA-256 is `94b732691b66c53566dde190c0c3b0eef91d5adb35f81468eb20a0d4c0e2b167`.
Frozen workload descriptor SHA-256 is
`58a9a2c9d81e0021819064c5fcedbe45140c21e27b285dbbae7a7d143b57b835`;
the default descriptor remains `417b4388c355a7f415df05df56d3904a314be517ced4ec6bf61fe0c222249421`.

Reproduce the frozen input by extracting the last 100 complete lines from the
named ended rollout and checking both hashes, then run the canonical test with
`TEST_INGEST_CORPUS_PATH` naming that local snapshot. Default command remains
`PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`.
The temporary raw snapshot was removed after receipt capture.

Performance-plan decision D-006 explicitly reserves shared federation-host
adoption for a separately coordinated runtime lane. This worker performed only
a `dev:restart` dry-run and did not restart the shared host. The current runtime
report still names bg-host `244f7d127c`, `containsChange:false`; live adoption,
causal attribution, latency acceptance and final shipment remain open.

### PUI account-request attribution — 03:33Z

The account-call label `palette` is shared dispatch plumbing, not a component
name. `apps/tui/src/client.rs:1453` implements `accounts_status()` by invoking
`accounts:status`; `run_tool_body` stamps `callerSid=pui-<process id>` at line
3553. `packages/operator-core/lib/capabilities/invoke.ts:216` retains
`spawnId=palette` while carrying that id in `uiClientId`. The principal identity
writer namespaces it as `loopback/pui-<pid>` in the current ledger. These are
caller-supplied attribution fields, not authenticated PUI binary provenance.

The current PUI has two direct consumers in `apps/tui/src/main.rs`: session
setup at line 2932 and the general workbench `refetch_all` at line 7770. The
latter runs after the initial load, a 60-second safety tick, and debounced SSE
invalidations. `invalidation_loop` forwards every `invalidate`/`update` frame;
the current signal gates plan reads, while account reads remain unconditional
in a full hydration pass. This is a source mechanism that can amplify account
reads on unrelated updates. No replay in this investigation has yet measured
its effect or linked a specific historical request to its triggering frame.
The same account-method/caller-id/safety-tick paths exist in Git source
`29bf735091` and historical server source `e5b3a2cb54`; server SHA does not
establish which PUI binary was loaded.

The exact retained sample is workspace `papercusp-workspace`, tool
`accounts:status`, caller `loopback/pui-2221762`, spawn `palette`, host
`port-3070`, build `29bf735091`, settlement interval
`[2026-10-01T00:19:00Z,2026-10-01T01:19:00Z)`. A bounded read with a positive
control returned:

| Quantity | Observation |
|---|---:|
| Calls | 60 |
| Summed dispatch wall time | 3127 ms |
| Dispatch p50 / p95 / maximum | 34 / 153.9 / 505 ms |
| Serialized result units | 2435534 |
| Adjacent settlement spacing, minimum / maximum | 31.272 / 98.551 seconds |

First settlement: `00:19:30.220Z`; last: `01:18:31.453Z`. An exhaustive
status/metadata partition returned one cell: `status=ok`, dispatch-stage
metadata absent, 60 calls with 60 duration and 60 size values. Thus this sample
has no dispatcher-error rows and cannot attribute wall time to individual
dispatch phases. `duration_ms` comes from `Date.now()-startedAt` in
`libs/generic/tooldef/src/dispatch-stack.ts:1732`; it includes waits and
scheduling but excludes the telemetry sink. `invoked_at` is stamped at
settlement in `projected-tool-deps.ts`. `output_size` falls back to
`JSON.stringify(r.content).length`, so these are serialized units, not measured
UTF-8 network bytes. Neither the sum nor the percentile establishes CPU cost,
overlap with ingestion, or a causal effect on app latency.

A separate bounded September 23 day read for `pui-2057122` and
`loopback/pui-2057122` retained the ten largest build/host groups. One group
contains 1488 calls on `port-3170`, build `e5b3a2cb54`, from
`03:00:54.263Z` to `04:15:04.197Z`: 110276 ms summed dispatch wall and
44395557 serialized units. This is positive evidence of historical frequent
PUI-shaped calls; ten selected groups are not a complete daily census. It is
not comparable to the October 1 sample as an improvement measurement.

Read-only reproduction uses `dev:pg_query` over `harness_shared.tool_invocations`
with the exact scalar predicates above. Compute adjacent spacing with
`lag(invoked_at) OVER (ORDER BY invoked_at,id)` inside that sample; group by
`status` and a three-way metadata case (`NULL`, `dispatchStages` present,
absent) to retain unknown values. The positive control was id `30385108`.
The historical query uses `[2026-09-23T00:00:00Z,2026-09-24T00:00:00Z)`,
groups by host/build/caller/spawn, orders by count descending, and limits 10;
its positive control was id `29288084`. Both reads completed with no child
failure. The second CLI invocation yielded native session 17280 and was drained
to exit 0; it was not retried as an empty result.

Source snapshot for these references: HEAD
`0325bcf20a1c2144215f775e1744399abd24e1cb` plus the shared working tree.
SHA-256: `main.rs` =
`613113a5b96cffe5ea1baad3f5838a2ac430c5603a3e36123eafffbcee60cc44`;
`client.rs` =
`96471030a05791427337feb37133ff5d00ef3eb3e10f29d05e8245c2e2d53e18`;
`capabilities/invoke.ts` =
`c8e58e77d31d398c7946dea4e6a91d0a7f78b753c1d16c108fa38877180d31f9`;
`dispatch-stack.ts` =
`d7486b7ca68ccf6f051d2bcbd7cc7b646a6b8dfe320b490bcc8e1cb648b44295`.
No production request replay, service restart, or account-refresh code change
was performed. P-008 remains open; the next independent step is a maintained
test of unrelated SSE invalidation versus account-specific invalidation before
changing refresh behavior.

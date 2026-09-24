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

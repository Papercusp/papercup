# R-002 queue-instrumented cold-start probe

Run: 2026-10-06 20:49:47Z–21:02:58Z. Source tree HEAD: `781edde2d8`; sidecar reported build SHA `ef4f15064a`. The probe measured the shared embed sidecar while the gateway started `llama-ornith` on demand. Before the request, Ornith was inactive. The probe skipped the stop command because it was already inactive; systemd records the new service start at 20:49:58Z and the gateway journal records the on-demand start at 16:49:58 EDT. Gateway completion returned HTTP 200 after 538 seconds of request time (20:58:55Z). The gateway journal reported routing resumed at 16:58:23 EDT.

## Measurements

- 354 cache-bypassing `/embed` samples: all HTTP 200 with valid cache accounting; median 58 ms, maximum 4.437 s, none over 10 or 15 seconds.
- The stable sidecar remained PID 2121735, restart count 1, from before to after.
- 1,302 successful `/healthz` samples at roughly 500 ms cadence: queue depth max 13, 23 positive-depth samples, active max 6 at concurrency 6, maximum `/healthz` response time 246.5 ms.
- Global I/O PSI avg10 peaked at 68.89 and memory PSI avg10 at 43.89. Global major-fault and file-refault deltas were 3,329,103 and 41,603,892. The sidecar cgroup had zero major-fault and file-refault delta.
- No watchdog miss appeared in the run output. GPU memory used peaked at 24,087 MiB.

## Queue / latency comparison

The `/embed` sample timestamps and health samples were joined in UTC. A start-depth match required a successful health sample within 1 second of the request timestamp. All 354 requests matched: 348 began at depth zero (median 58 ms, p95 224 ms, max 4.437 s); six began with positive depth (median 70 ms, max 328 ms). No successful health sample reported positive depth during any sampled request's measured interval.

This run observed transient FIFO backlog during the cold start, but the probe's requests remained fast and none overlapped a positive-depth health sample. It does not reproduce or explain the five >10-second responses from the earlier 10:01Z run. Queue wait remains unestablished as their cause; no product fix is justified from these measurements.

## Raw evidence

- `r002-queue-instrumented-20261006-embed-samples.tsv.gz`
- `r002-queue-instrumented-20261006-healthz.tsv.gz`
- `r002-queue-instrumented-20261006-run.txt`

The existing probe script was executed with a runtime transform that replaced its Ornith stop command with a guard-and-skip, then added the independent `/healthz` sampler. The checked-in probe script was not modified. The probe and gzip files can be regenerated/re-read from the raw evidence and the cited source revision.

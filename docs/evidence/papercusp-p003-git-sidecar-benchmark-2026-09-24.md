# P-003 Git sidecar read benchmark

Plan `papercusp-log-performance-remediation-2026-09-23`, work item
`WI-10002825`. Source change commit `41b4c7a88e14043f9e5796ae322f07b9da971a9f`;
measured from the canonical staging tree on Linux with Node v25.9.0 on
2026-09-24. This is a controlled current-build benchmark, not a green-release
or production latency verdict.

One `tsx` process held a touched 256 MiB Buffer to keep the caller resident at
roughly 553–556 MiB RSS. It issued the same `git rev-parse --git-dir` in the
same repository with an un-aborted `AbortSignal` 100 times per block, sequentially:
local, warm sidecar, local again. The sidecar was started with one separate
warm-up call before the blocks. Only `PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR` changed
between blocks (`0`, `1`, `0`). Each measured call required exit code zero.

`blocked` is the synchronous time from calling `runGitBounded` until it returns
its Promise, so it measures the main-thread call-entry cost, not the whole RPC.
`wall` includes the completed Git command and RPC/admission work. Loop delay is
`monitorEventLoopDelay({ resolution: 10 })` for each block, with a short sampling
window after the last call. All durations are milliseconds.

| Mode | Calls | RSS MiB | blocked p50 | blocked p95 | wall p50 | wall p95 | loop delay p95 | loop delay max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Local, first | 100 | 554 | 31.13 | 36.38 | 32.77 | 40.33 | 36.4 | 46.4 |
| Warm sidecar | 100 | 553 | 0.41 | 0.57 | 93.04 | 345.18 | 10.2 | 12.7 |
| Local, repeat | 100 | 556 | 33.15 | 39.05 | 35.14 | 65.10 | 40.4 | 52.5 |

The separate first sidecar request took **14,482.68 ms** including startup and
its first Git execution. The warm sidecar removed roughly 31–33 ms of median
main-thread call-entry blocking and lowered measured loop-delay p95 for this
read-only workload. Its end-to-end Git wall latency was higher: 93 ms median
versus 33–35 ms locally, and 345 ms p95 versus 40–65 ms locally. This favors
host responsiveness at the cost of longer individual Git reads here; it does
not establish an overall user-journey speedup.

The workload is one metadata command in one test process, not the real
multi-repository git-sync action on a 4 GiB background host. The shared host was
not isolated from other work, the block order was fixed, and the first sidecar
request was excluded from the warm distribution but reported separately. The
sidecar path's admission overhead and startup cost need separate attribution.
Signal-bearing Git commands that can mutate repository state still run locally
until transport loss can prove the remote child and descendants have stopped
before repository locks are released. Profiler observer cost and the full P-003
acceptance profile remain open.

## Comparable four-repository transport benchmark, 13:46Z

Canonical integration test:
`packages/operator-core/lib/harness/git-sync/git-sidecar-benchmark.integration.test.ts`.
Run **19294494** passed one test, zero skipped, on `a0d29c3d57` plus local
changes. The real signal-bearing `runGitBounded` caller talks to the real IPC
server and Git processes in an isolated Linux scope. Only admission persistence
is replaced by the existing lifetime-test fixture. **Production database/queue
latency is excluded**, so this cannot be compared directly with the earlier
production-admission benchmark's wall times.

Four temporary repositories each contain eight distinct files of 1,000 lines.
Indexes are populated before measurement so the first local block does not
uniquely pay index creation. Each block repeats `add -A`, `write-tree`,
`status --porcelain=v1`, `diff --cached --stat`, and `ls-files -z` five times
per repository: **100 completed calls per block**, 200 per mode. Every result
must match its repository/command baseline; every call carries an AbortSignal.
There were zero fallbacks. A touched 256 MiB Buffer stays live throughout;
reported caller RSS was 390,950,912 bytes in every block.

The order is local / sidecar / sidecar / local. Definitions match the earlier
table: call-entry blocking is distinct from total command completion; histogram
resolution is 10 ms. Quantiles use sorted zero-based `floor(n*p)` observations.

| Mode | Calls | Blocked p50 | Blocked p95 | Completion p50 | Completion p95 | Loop p95 | Loop max |
|---|---:|---:|---:|---:|---:|---:|---:|
| Local, first | 100 | 29.24 | 32.78 | 31.35 | 35.97 | 36.21 | 40.08 |
| Sidecar, first | 100 | 0.54 | 0.95 | 20.08 | 37.07 | 11.10 | 16.14 |
| Sidecar, repeat | 100 | 0.45 | 0.75 | 16.91 | 20.05 | 10.66 | 11.38 |
| Local, repeat | 100 | 26.59 | 29.25 | 28.64 | 31.77 | 31.16 | 42.17 |

All durations are milliseconds. Fixture server startup took 9,427.52 ms and
the separate first caller request took 39.05 ms; both are reported outside the
warm distributions. Teardown targets only the captured test scope, and the test
waits for its kernel exit observation. The scheduled shared sidecar is untouched.

The benchmark demonstrates lower main-thread blocking and loop delay with the
current fenced caller. The first sidecar block's completion p95 exceeded the
first local block's p95, despite a lower median. It does **not** establish a
universal latency win, a complete scheduled git-sync action, remote-network
behavior or production queue costs. Preliminary 80-call blocks were exploratory;
the table above is the final pre-staged, 100-call comparison. Scoped typechecking
found no diagnostic in this new test; 23 other import-graph diagnostics remain.

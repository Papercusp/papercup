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

# Box wedge / session leak → zombie `claude --resume` procs (ended session, live process)
URL: /internal/docs/agent-insights/session-leak-zombie-resume-procs

A climbing claude-proc count toward the ~70 bg-host wedge is usually ZOMBIE `claude --resume <uuid>` procs — adv_session ENDED but the OS process never exited. No DB-roster reaper sees them. How to diagnose + the slice-3 zombie reaper that sheds them.

## Symptom

The `claude` process count climbs monotonically toward \~70, the box overloads,
the **papercup-bg-host DBOS ticker** starves (event-loop-lag spikes, `[routines]`
drops to \~1/10min), and everything the ticker drives freezes: git-sync stops
committing, the green-checkpoint stalls, agent loops skip. `dev:service_health`
shows `:3070 up` (it is — the operator and the bg-host ticker are *different*
services; see EI-1832).

## Root cause (EI-1873)

The leak is **zombie processes**, not idle-but-open sessions. Each leaked proc
runs `claude --resume <uuid>` whose `harness_shared.adv_sessions` row is **ENDED**
(`ended_at` set, `exit_code = 0`, often 16–18h prior) — but the OS process never
exited. The session officially concluded; the process lingered, holding LISTEN
conns + polling on the `:3070` event loop.

Why every reaper misses them:

* `idle-session-reaper.ts` slices 1 (dead-ghost) and 2 (live-but-idle) scan
  **OPEN** adv\_sessions (`ended_at IS NULL`). A zombie is **CLOSED** in the DB →
  structurally invisible. Running the reaper's own logic *out-of-band* (a fresh,
  non-starved process) still reaps **0** — proof it is a criteria miss, not just
  starvation.
* The presence-heartbeat liveness signal is *also* unreliable here: the per-60s
  supervisor beat is starved by the very overload the reaper is meant to detect,
  so an alive proc reads as "not live." Liveness that depends on the starved
  resource is a feedback loop.

## Diagnose

The reliable proc↔DB join is **`adv_sessions.session_id` = the `claude --resume <uuid>`** on the OS proc (`adv_sessions.pid` is often null; don't rely on it).

1. Count: `ps -eo comm | grep -c '^claude$'`.
2. For each live `claude --resume <uuid>` proc, look up `adv_sessions` by
   `session_id = <uuid>`. **`ended_at IS NOT NULL` ⇒ zombie** — safe to kill: the
   session is done (`exit_code = 0`), it holds no claim/wake/running-bee, and it
   is **not** any live agent's current session (a live session has `ended_at IS
   NULL` — a disjoint set).

## Fix / shed

`idle-session-reaper.ts` **slice 3** — `reapZombieResumeProcs()` (+ pure
`planZombieReap()` / `discoverResumeProcs()`), wired into the
`system:idle-session-reaper` routine to run first each tick. It enumerates live
`claude --resume` procs via `/proc`, asks PG which of their sessions are ended,
and `SIGTERM`→(grace)→`SIGKILL`s the zombies. **Deterministic** (ended + alive),
**starvation-independent** (no heartbeat dependence), **PID-recycle-guarded**
(re-verifies the cmdline before each signal), **double-gated**
(`papercusp-idle-session-reaper` + `…-terminate`).

**Manual out-of-band shed during a wedge** (the reaper routine is starved): run it
from a fresh process with the flags forced — the flag resolves OFF in a fresh
process, so inject it:

```ts
const m = await import('<repo>/packages/operator-core/lib/idle-session-reaper.ts');
await m.reapZombieResumeProcs({ dryRun: true,  deps: { isFlagOn: async () => true } }); // confirm scope first
await m.reapZombieResumeProcs({ dryRun: false, deps: { isFlagOn: async () => true } }); // then shed
```

## Still open (follow-ups)

* 258 no-owner **OPEN** adv\_session rows also accumulate (no `coord_owner_id` →
  `keptNoOwner`, never reaped) — a separate sweep should end orphaned rows with no
  live proc.
* The **upstream** bug — why a `claude --resume` proc fails to exit after its
  session ends (exit 0) — is unfixed; slice-3 is the safety net, not the cure.
* For full starvation-immunity, run the zombie sweep in the bg-host-watchdog
  (out-of-band), not only the ticker-driven routine.

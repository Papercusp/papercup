# The layered agent-liveness model
URL: /internal/docs/coordination/agent-liveness-model

How Papercusp decides an agent is alive — supervision, stream activity, dispatch beats, coord beats — which consumers read which legs, and why the sweep never prods processes directly.

Shipped by `agent-liveness-heartbeat-hardening-2026-06-12` (after the
stale-claims sweep and EI-348). This page is the one mental model; the
per-module docs live in the source headers it links.

## The four signals, robustness-ordered

| # | Signal                                                                                                                       | Written by                                                                                                                                                                                                                                                                    | Semantics                                                                                                                      | Covers a long no-tool-call turn?                 |
| - | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 1 | **Supervision heartbeat** — `spawned_agents.heartbeat_at`                                                                    | The host that OWNS the process: the operator's nursery loop (`fleet/operator-spawn.ts ensureSpawnHeartbeatLoop`) for bees; the psu launcher's supervisor beat (`scripts/psu-launcher.mjs startSupervisorBeat` → the bootstrap-su heartbeat endpoint) for interactive sessions | "I hold this process handle and it is alive"                                                                                   | **Yes**                                          |
| 2 | **Stream activity** — `spawned_agents.last_output_at` (bees, mig 233) · pty discovery-file `lastOutputAt` (psu pty sessions) | The runner's in-process stdout/stderr listeners (`dbos/orchestrator-runner.ts onOutputActivity`); the pty host's activity tracker (`scripts/psu-pty-host.mjs makeActivityTracker`)                                                                                            | "The agent emitted bytes just now" — *generating*, not merely alive                                                            | Yes, and it distinguishes generating from wedged |
| 3 | **Dispatch beat** — `coord_presence.heartbeat_at` via `touchHeartbeat`                                                       | The projected-tool dispatch seam (`projected-tool-deps.ts recordInvocationImpl` → `agent-tools/coordination/dispatch-heartbeat.ts`), throttled per owner                                                                                                                      | "The agent made ANY platform tool call recently" — the per-edit lock hook traffic alone keeps an actively-editing session warm | No (but such turns also make no edits)           |
| 4 | **Coord beat** — `coord_presence.heartbeat_at`                                                                               | `coord:declare-intent`, `coord:inbox` reads                                                                                                                                                                                                                                   | "The agent touched the coordination layer recently"                                                                            | No                                               |

Two invariants:

* **A signal is written by whoever can actually observe it.** The sweep/roster
  never `kill -0`s processes: it's same-host-only, session agents have no PID
  (`coord_presence.pid` is null for HTTP MCP clients), and alive ≠ progressing —
  a wedged process passes `kill -0` forever. Supervision heartbeats ARE
  process-prodding, done by the process-owner and projected into PG where every
  host can read them.
* **Annotate, don't suppress** (plan D-002): stream-activity staleness flags a
  `possibly_wedged` candidate for humans/the Queen (`fleet:tree`,
  `isPossiblyWedged` in `fleet/spawn-reclaim.ts`); it NEVER feeds claim release.
  An attended-but-quiet session keeps its claims. Auto-reap policy is an open
  owner decision (plan P-010).

## Which consumers read which legs

| Consumer                                                 | Legs read                                                                  | Where                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| Stale-claims sweep (releases `taken_by` of dead holders) | 1 + 3/4 (presence OR nursery, alias-aware per mig 225)                     | `work-items-stale-claims.ts`       |
| Spawn reclaim (frees ceiling slots of dead-host spawns)  | 1, plus same-host pid-alive as a keep-alive override (EI-85)               | `fleet/spawn-reclaim.ts`           |
| Colony roster / Sessions view                            | best of 1 (nursery join, pid-alive definitive) and 3/4 (presence) — EI-348 | `adv-roster.ts mergeRosterEntries` |
| Wedge badge (`possibly_wedged`)                          | 1 fresh AND 2 stale                                                        | `fleet:tree` → `isPossiblyWedged`  |

**The rule for new consumers: read the strongest leg available for the agent
class, not just presence.** EI-348 was exactly a consumer reading only leg 3/4
for agents whose truth lived in leg 1.

## The supervisability boundary

Processes our infrastructure launches are fully supervisable: fleet bees
(operator children) and psu sessions (the launcher stays parent in both the
plain and managed-pty paths; the pty host additionally sees every byte). The
remainder — a bare `claude` launched outside psu, remote claude.ai/code
sessions, desktop embedded chat — can only be observed through their platform
traffic (legs 3/4). That is why the dispatch beat exists and ships enabled.

## Tuning knobs

* `DISPATCH_BEAT_INTERVAL_MS` (45s) — `dispatch-heartbeat.ts`
* `SUPERVISOR_BEAT_MS` (60s) — `psu-launcher.mjs`
* `SPAWN_HEARTBEAT_INTERVAL_MS` (60s) — `fleet/spawn-reclaim.ts`
* `ACTIVITY_PERSIST_MS` (15s, pty discovery write-through) — `psu-pty-host.mjs`
* `WEDGE_SILENT_MS` (10min) — `fleet/spawn-reclaim.ts`
* Liveness windows: `LIVE_MS` 60s / `STALE_MS` 10min (`liveness.ts`) ·
  claim-sweep grace `STALE_CLAIM_GRACE_MS` 10min (`work-items-stale-claims.ts`)

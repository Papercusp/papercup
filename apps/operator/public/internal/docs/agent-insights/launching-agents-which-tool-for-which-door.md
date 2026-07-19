# Launching agents — which tool for which door
URL: /internal/docs/agent-insights/launching-agents-which-tool-for-which-door

Canonical four-door routing table for agent launches, plan fleets, arbitrary terminal commands, and the desktop console buttons; capability:launch-agent is the flexible general launcher and fleet:launch-on-plan is the ergonomic N-on-plan door.

## The routing table

Use the narrowest purpose-built door that matches the intent:

| You want to…                                                        | Correct tool                                      |
| ------------------------------------------------------------------- | ------------------------------------------------- |
| Launch / resume / fork an agent (visible or headless, fleet or not) | `capability:launch-agent` — the flexible superset |
| Launch N agents on a plan (the ergonomic door)                      | `fleet:launch-on-plan`                            |
| Run an arbitrary command in a window                                | `capability:terminal`                             |
| Use the “+” / “Resume in new terminal” desktop buttons              | the `/console/launch` route → `spawnConsole`      |
| Reconfigure ONE running fleet member (no respawn)                   | `fleet:reconfigure-member`                        |
| Change a member’s boot-baked settings (model/account/…)             | `fleet:respawn-member`                            |

## Why the doors are distinct

`capability:launch-agent` owns agent lifecycle: fresh launch, resume, fork, visible/headless, and optional fleet membership. It injects the first turn and uses the shared agent-launch core.

`fleet:launch-on-plan` is the ergonomic plan-fleet wrapper. It ensures the fleet exists, establishes leadership, binds the plan and claim spec, opens N members, and auto-starts each member. Do not reproduce that choreography with `capability:terminal`.

`capability:terminal` owns arbitrary interactive commands. It opens detached visible command windows and does not own agent lifecycle, plan binding, first-turn delivery, fleet leadership, or member liveness verification.

The desktop “+” and “Resume in new terminal” buttons are UI actions, not agent-tool calls. They enter through `/console/launch`, which validates the request and delegates the actual OS-window spawn to the shared `spawnConsole` primitive.

## Selection heuristic

* If the subject is an **agent**, start with `capability:launch-agent`.
* If the request is specifically **N agents on a plan**, use `fleet:launch-on-plan`.
* If the subject is a **command**, use `capability:terminal`.
* If the action came from the desktop console UI, follow `/console/launch` → `spawnConsole`.

## Per-member config + runtime reconfigure (per-member-declarative-launch-specs)

A multi-agent launch is **declarative**: pass `members: MemberSpec[]` to either `capability:launch-agent` or `fleet:launch-on-plan`. Entry `i` configures agent `i` (index-aligned to `count`); each set field OVERRIDES the flat top-level arg for that agent only, an unset field falls through to the flat arg then the system default, and a shorter array is fine (`count` defaults to `members.length`). `MemberSpec` carries `model`, `effort`, `account`, `carry`, `contextSize`, `compactionLimit`, `role`, `agent`, `brief`, `claimKinds`, `headless`, and more (see `agent-launch-core.ts`).

Door note: `carry` / `claimKinds` seed a **self-pulling fleet** member's baseline + per-member claim spec, so they are honored ONLY by `fleet:launch-on-plan`. The general `capability:launch-agent` door opens raw agents — it IGNORES those two fields (and warns), so use `fleet:launch-on-plan` when a member needs a carry mode or a claim-kind lane.

Once a fleet is running, reconfigure ONE member without re-authoring the whole launch — the setting's nature picks the tool (D-003):

| Setting                                                     | Fixed at launch? | Tool                                                           |
| ----------------------------------------------------------- | ---------------- | -------------------------------------------------------------- |
| compaction limit, claim spec, next-wake brief               | no — runtime     | `fleet:reconfigure-member` (adjusts in place, no respawn)      |
| model, effort, account, contextSize, agent, compactionLimit | yes — boot-baked | `fleet:respawn-member` (drains + relaunches with the new spec) |

`fleet:reconfigure-member` applies each lever directly — compaction limit via the cross-session setter (clamped to the member's own spec+role ceiling), claim spec under the member's cupId (applied on its next `scheduler:get_next`), and the brief as a next-wake coord message. `fleet:respawn-member` KILLS the old session (releasing its claims via `fleet:kill`) then fresh-launches a replacement into the same fleet — a new identity that inherits the fleet claim lane; it ABORTS the relaunch if the kill fails, so a lane is never double-run. Both default `fleet` to the single fleet you lead and are authorized to the fleet's leader, the queen, or the owner.

Deep dives: [desktop fleet vs. loop cup](/internal/docs/agent-insights/desktop-fleet-vs-loop-cup), [launching, resuming and forking agents](/internal/docs/agent-insights/launching-resuming-and-forking-agents), and [native console](/internal/docs/desktop/native-console).

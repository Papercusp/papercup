# Launching a desktop fleet — use fleet:launch-on-plan, not hand-rolled capability:terminal
URL: /internal/docs/agent-insights/launching-a-desktop-fleet

A desktop fleet has ONE right launcher — `fleet:launch-on-plan` (it wraps capability:terminal, threads psu `--fleet=<slug>` for membership, and seeds the auto-kickoff so members auto-start). Hand-rolling `fleet:create` + `capability:terminal` is the trap — its `fleet` arg is COLOUR-ONLY, so members spawn with `fleetSlug:null` and park without auto-kickoff. Plus the observability gotchas that make a parked member look dead.

## TL;DR

To spawn a desktop fleet on a plan, call **`fleet:launch-on-plan { name, plan, count, agent }`**.
It is the purpose-built wrapper: it ensures the fleet (you become leader), opens N visible
member terminals (via the same desktop path as `capability:terminal`), threads psu
**`--fleet=<slug>`** so each member JOINS the fleet, and seeds the **auto-kickoff** so each member
auto-STARTS on the plan. One call, no manual wake.

**Do NOT hand-roll `fleet:create` + `capability:terminal` + a `psu …` command** unless you truly
need a *distinct per-member* launch-context (which `fleet:launch-on-plan` doesn't yet expose).

## The trap (hit 6× on one fleet, 2026-06-30)

`capability:terminal`'s own **`fleet` arg is COLOUR-ONLY** — it tints the window's scheme; it does
NOT join the fleet. Fleet MEMBERSHIP comes from psu's `--fleet=<slug>` flag inside the command
(`psu-launcher.mjs` parses `--fleet`/`--fleet=`, threads it to bootstrap-su, joins as member).

Pass `capability:terminal { fleet:'x', terminals:[{ command:'psu …' }] }` *without* `--fleet` in
the command and every member spawns with **`fleetSlug:null`** AND **parks without auto-kickoff**
(the launcher only seeds the first-turn kickoff on a fleet-aware launch). You then mistake the
parked members for boot failures and relaunch duplicates. (As of **EI-5835**, capability:terminal
now auto-injects `--fleet` into a psu command when its `fleet` arg is set — but reach for
`fleet:launch-on-plan` first.)

## Observability gotchas (why a healthy fleet looks broken)

* **`fleet:assignments` is CLAIM-primary.** A member that booted but hasn't claimed yet (or parked
  between turns) shows as **`agents: 0`** there. That is NOT a death. To answer "did my launch come
  up / is it alive", read **`coord:presence`** (the liveness view: `sessionState` live/parked/ended,
  `claimedItems`, `wakeable`) — not the claim view.
* **A member can boot and PARK without claiming** (auto-kickoff miss). It's in `coord:presence` but
  invisible to `fleet:assignments`. Fix = **wake it** (`coord:send wake:'required'`), do NOT
  relaunch a duplicate.
* **Killing the terminal window does NOT kill the agent.** `capability:terminal` opens a
  gnome-terminal that, after psu, drops to an interactive shell; the psu/agent process detaches and
  survives a `kill <terminal-pid>`. Verify a stand-down via `coord:presence`, not by killing the
  window.
* **Long external work (a big download) ≠ a stalled agent.** A driver may background the job
  (`nohup … &`) and end its turn (parked). Check the actual work (the process / growing file), not
  just the agent's turn-state, before "recovering" it.

## Tool decision table

| Need                                       | Tool                                                |
| ------------------------------------------ | --------------------------------------------------- |
| Desktop fleet on a plan (the default)      | **`fleet:launch-on-plan`** (auto-join + auto-start) |
| Register a fleet, no terminals             | `fleet:create`                                      |
| One-off visible terminal(s), no fleet/plan | `capability:terminal` (its `fleet` = colour only)   |
| Headless workers (no desktop window)       | `fleet:spawn` / `fleet:place_batch` (nursery bees)  |

`fleet:spawn` / `fleet:place_batch` are HEADLESS — never use them for a "desktop fleet."

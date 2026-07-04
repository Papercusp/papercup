# Desktop fleet vs. loop bee — which spawn tool do you actually want?
URL: /internal/docs/agent-insights/desktop-fleet-vs-loop-bee

The one decision that keeps getting made wrong — bee:spawn (background queen↔bee autonomous-loop workers) vs fleet:launch-on-plan (VISIBLE desktop su member terminals). A goal→tool→what-you-get table so "launch a fleet" stops spinning up invisible bees.

## The mistake this prevents

"Launch a fleet on this plan" has TWO tools that sound alike and do completely
different things. Reaching for the wrong one is a recurring, expensive error — the
origin of WI-1764: a leader called **`bee:spawn`** (then named `fleet:spawn`)
meaning to open visible desktop members, got three **background autonomous-loop
bees** instead, and the fleet read `liveMemberCount: 0` while three bees quietly
ran. Correct, but silent — so nobody noticed the substrate mismatch.

The rule of thumb — now encoded in the tool namespace itself (WI-1764 #3 renamed
`fleet:spawn` → `bee:spawn`):

> **`fleet:*`** (launch-on-plan / create / take-leadership / status / cancel) =
> VISIBLE desktop su members. **`bee:spawn`** = a background worker in the queen↔bee
> autonomous loop.

## Decision table

| Your goal                                                                  | Tool                       | Visibility                   | Substrate                                    | Capability                                        | Who drives                                                      |
| -------------------------------------------------------------------------- | -------------------------- | ---------------------------- | -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| Open N visible terminals on the owner's desktop to work a plan, now        | **`fleet:launch-on-plan`** | VISIBLE desktop windows      | psu su sessions (`capability:terminal`)      | full su collaborator (edit/tools/coord)           | you become the fleet **leader**; members auto-start on the plan |
| Register a named fleet (no windows yet) so you can hand a plan to it later | **`fleet:create`**         | none (registry row only)     | durable `agent_fleets` row                   | —                                                 | leader = creator                                                |
| Place ONE background worker on ranked work / a claim-spec, no window       | **`bee:spawn`**            | INVISIBLE (headless nursery) | queen↔bee autonomous loop (`spawned_agents`) | a bee: coord/issues/improvements, self-pulls work | the **Queen** places + supervises the loop                      |
| Place MANY background bees in one shot                                     | **`fleet:place_batch`**    | INVISIBLE (headless nursery) | queen↔bee autonomous loop                    | bees                                              | the Queen                                                       |
| Just a plain worker window (no fleet, no plan)                             | **`capability:terminal`**  | VISIBLE desktop window       | psu session                                  | su collaborator                                   | you                                                             |

## Why the confusion is easy — and how to catch it

* **A bee-spawn can create a fleet.** `bee:spawn { fleet: "X" }` auto-CREATES fleet X
  if it's absent (bees can be color-grouped). So "I passed a fleet name" does NOT mean
  you got desktop members. A bee-spawn that materialises a new fleet now returns a loud
  `fleet_advisory` telling you so (WI-1764 #2).
* **The count now splits.** `fleet:list` and `fleet:status` report **`memberCount`
  (visible desktop su) vs `beeCount` (background bees spawned INTO the fleet)**, plus a
  workspace-wide **`runningBees`** total (WI-1764 #4). A fleet showing `0 members` while
  `runningBees > 0` is the tell that you spawned bees where you meant `fleet:launch-on-plan`.
* **`beeCount` is nursery-attributed and reliable (WI-1813).** A bee's `fleet_slug` is now
  stamped on its `spawned_agents` row at spawn (mig 475), so `beeCount` (via
  `countRunningFleetBees`) counts every running bee attributed to the fleet — *independent*
  of whether the bee booted far enough to write a `coord_presence` fleet label (the earlier
  weak signal). `memberCount` still comes from presence — a member IS a live desktop
  session. The workspace-wide `runningBees` remains the belt-and-suspenders total that also
  catches ungrouped and pre-mig-475 bees carrying no `fleet_slug`.

## The two-line heuristic

> Want a human to SEE terminals working a plan? → **`fleet:launch-on-plan`**.
> Want the autonomous queen↔bee loop to grind ranked work headlessly? → **`bee:spawn`**.

If you catch yourself about to `bee:spawn` because you want "a fleet on a plan",
stop — you almost certainly want `fleet:launch-on-plan`.

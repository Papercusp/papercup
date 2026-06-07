# BRIEF — Swarm coordination architecture (the brain as a slot-scheduler; single-hive = N=1 of multi-hive)

**Type / mission.** Phase-0 = ratify-the-forks (design, owner-leaning recorded); Phase-1 = the single-hive N=1 build (brain loop = scheduler over local slots + the shared per-slot work-list + urgent-bypass + warm-inject); Phase-2 = the multi-hive seams (federate the queue, the compact budget signal, cross-hive reclaim, partition policy) **designed now, built when a 2nd machine exists.** Plan `swarm-coordination-architecture-2026-06-06`. It is the spec the spawn/work-list plans implement — ride them, don't fork greenfield.

## The items (verbatim, plan `swarm-coordination-architecture-2026-06-06`)

- **swarm-coordination-architecture-2026-06-06 P-001** — **Budget model fork:** soft **shared throughput-pool + global ceiling + reactive 429-pacing** (better utilization, accepts transient overshoot caught by pacing) vs **hard per-hive throughput leases** (no cross-machine per-spawn round-trip, but underutilizes + needs rebalancing). Owner-leaning: soft pool. Decide (D-008).
- **swarm-coordination-architecture-2026-06-06 P-002** — **Budget primitive shape:** a **permit pool** (distributed-semaphore acquire-before-spawn) vs a **throttle broadcast** (optimistic spawn + a federated 429-penalty signal) vs both (permit for steady-state, throttle for spikes). Must be O(1) shared state (D-012).
- **swarm-coordination-architecture-2026-06-06 P-003** — **Hive boundary:** a device/machine (the throughput+slot boundary; maps to the device-pubkey identity), with user-identity orthogonal (the existing per-user model). Confirm (D-016).
- **swarm-coordination-architecture-2026-06-06 P-004** — The brain's loop = scheduler over local slots: on wake, **rank tasks → for each, pick placement (free slot / graceful evict+fresh / warm-inject)** → write the per-slot buffered work-lists. Rides `autoloop-pot-operator-rebuild` (the loop) + `unify-agent-spawn-chokepoint` (admission for options 1/2).
- **swarm-coordination-architecture-2026-06-06 P-005** — The **shared per-slot work-list**: externalized, agent-authored, brain-writable, buffered (so workers drain ahead of the brain's cadence). Extends `work_items` + assignment with an agent-owned/brain-overridable `rank`; queryable via `fleet:assignments`. The control-level **dial** (automation setting).
- **swarm-coordination-architecture-2026-06-06 P-006** — **Urgent bypass:** an urgent enqueue **wakes** the brain immediately (rides `unify-watch-primitive`'s deliver-and-wake), not the slow cadence.
- **swarm-coordination-architecture-2026-06-06 P-007** — **Warm-inject (option 3):** the `coord`-message-mid-turn + wake-if-asleep verb (`message-agent { wake:true }`) — rides `unify-watch-primitive`. The brain hands a task to a running agent that has the context.
- **swarm-coordination-architecture-2026-06-06 P-008** — **Federate the queue (Track A):** the global tagged work-queue + claim-leases, federated via the content peer-log. A hive's brain pulls + claims for its hive; tag-filter gives local affinity. Crash → claims lease back.
- **swarm-coordination-architecture-2026-06-06 P-009** — **The compact budget signal (Track B):** the permit/throttle primitive on the authority — O(1) shared state, the **federated 429-penalty** (a throttle anywhere → everyone backs off). The one genuinely-new piece.
- **swarm-coordination-architecture-2026-06-06 P-010** — **Cross-hive crash-reclaim:** a dead hive's uncompleted claims lease back to the global queue (rides the authority's membership tracking — "a peer left → reclaim its claims", already done for locks). NO per-slot-list federation.
- **swarm-coordination-architecture-2026-06-06 P-011** — **Partition policy:** content (queue/work) **fail-open** (keep pulling/working); control (budget) **fail-safe** (don't exceed last-known allocation; lean on reactive 429-pacing). Matches the Track-A/Track-B posture.
- **swarm-coordination-architecture-2026-06-06 P-012** — **On-demand directed message** for the rare cross-hive "interrupt *that* specific agent" — a directed coord+wake, NOT a standing replicated fleet-state view.

## Primary file surface (collision contract)
- `packages/operator-core/lib/fleet/assignments.ts` (the `fleet:assignments` query + the agent-owned/brain-overridable `rank`), `fleet/governor.ts` (the dial)
- `packages/operator-core/lib/work-items.ts` (extend work_items + assignment with `rank`; the shared per-slot buffered work-list)
- the brain scheduler loop (rank -> placement: free-slot / graceful-evict+fresh / warm-inject) — rides `autoloop-pot-operator-rebuild`
- the warm-inject / urgent-bypass verb (`message-agent` with `wake:true`) — rides the watch/deliver-and-wake primitive
- Phase-0 **decision records only** (D-008 budget model, D-012 primitive shape, D-016 hive boundary) — write to the plan, no code
- Phase-2 **design records** for federate-the-queue / budget-signal / cross-hive reclaim / partition policy (build hardware-gated on a 2nd machine)

**Hot-file sequencing:** the **budget primitive** (permit-pool / throttle, on the authority) and the `fleet/` admission surface overlap **Brief 1 (spawn-chokepoint)**. Brief 1 owns admission + the ceiling/pacing floor; **you sequence behind it** on `fleet/operator-spawn.ts` + the authority budget surface. Do the work-list / `rank` / scheduler / Phase-2 design first (disjoint from Brief 1); land the budget-signal piece only after Brief 1's floor is in. Coordinate via `coord:*`.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item's status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- Phase-0 forks recorded with the owner's leaning (soft pool / permit-pool / device-boundary) — **if the owner has not ratified, these are `needs-human` sign-offs: surface, don't decide.**
- Phase-1 single-hive: the brain ranks + places into slots; the buffered work-list drains ahead of cadence; an urgent enqueue wakes the brain immediately; warm-inject hands a task to a running agent. Vitest + an N=1 live smoke.
- Phase-2 seams exist as a coherent design with tests written single-machine where possible; multi-machine verification explicitly hardware-gated.

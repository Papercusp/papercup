# The seat-donation model — fleet-scoped vs pot-scoped agent-seat offers
URL: /internal/docs/coordination/seat-donation-model

How a host donates spawn capacity (agent_slot allotments) to a single fleet or a whole shared pot, why spawn-audience is a grant separate from trust, the host-side honor gates that stay fail-closed either way, and how the spend paths resolve offers. Plan pot-seat-pools-prose-ux-2026-07-18.

import { Aside } from '@astrojs/starlight/components';

## One paragraph

A host donates agent-seat capacity — an `agent_slot` allotment, N seats of a
given model·effort on one of its gateway accounts — to one of two scopes:
a single named **fleet** (`resource:delegate { fleetSlug }`, the original
form) or a whole shared **pot** (`resource:delegate { potSlug, audience }`,
added by `pot-seat-pools-prose-ux-2026-07-18`). Both forms are spent through
the exact same host-side honor gates and the same atomic claim — the pot
form only widens **who may spend** a standing offer; it never changes **how**
spending is authorized. See also
[seat-donation traps found during the live drill](/internal/docs/agent-insights/seat-donation-model-traps)
for concrete bugs and non-obvious nuances hit while exercising this model
end-to-end.

## Fleet-scoped vs pot-scoped: what changes, what doesn't

|                  | Fleet-scoped (original)                                           | Pot-scoped (P-001, this plan)                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grantee arg      | `fleetSlug`                                                       | `potSlug` + REQUIRED `audience`                                                                                                                                                    |
| Who may spend    | that one fleet's owner only                                       | any fleet in the pot whose OWNER passes the host's audience check                                                                                                                  |
| Donate cadence   | once per fleet-of-the-day                                         | once per pot — no re-donating for every new fleet                                                                                                                                  |
| Offer target     | the fleet owner directly                                          | the pot's shared-hive topic (P2P)                                                                                                                                                  |
| Spend resolution | `fleet:request_remote_spawn` names/matches the fleet-scoped offer | resolved as a **fallback** when no fleet-scoped offer is named/available (P-004), or pooled alongside fleet-scoped offers by `fleet:launch-on-plan { placement:'remote' }` (P-005) |
| Account id       | never leaves the host, either way                                 | never leaves the host, either way                                                                                                                                                  |
| Over-draw safety | Gate 5 atomic claim (below)                                       | same — no separate broker                                                                                                                                                          |

Both forms persist as a row in `resource_allotments` (`fleetSlug`/`potSlug`
exactly one, never both — the store refuses otherwise) and both advertise
`model · effort · count · audience` only; the account id is resolved
host-side at claim time (Gate 4.6), never published.

This ships WITHOUT the dual-signature pool broker (`p2p/pool-broker.ts`,
host-signed GRANTS → pool-signed ASSIGNMENTS → host re-verifies at claim).
Over-draw safety for v1.5 is the host's existing atomic claim (Gate 5) plus
a loud refusal — two fleets racing one pot offer produce exactly one spawn.
The offer wire-shape stays compatible with the grant/assignment vocabulary
in `p2p/capabilities.ts` (`grantee kinds: ['fleet','pool']`) so the pool
broker can be re-keyed for fair-share arbitration across many hosts later,
without a breaking re-design.

## Audience is a grant separate from trust (D-002)

`trust:add` already means *"this user's verified remote work auto-runs"* —
reusing that same list to also mean *"may start agents on my box"* would be
a silent scope escalation of an existing grant. So a pot-scoped offer
declares its **audience** explicitly, at delegate time:

* **`'trusted-members'`** — the host's own local trust list, checked at
  **claim** time. The recommended default in UI/prose.
* **`'whole-pot'`** — a deliberate, wider opt-in: every member of the pot.

There is **no silent default** — `resource:delegate` refuses a `potSlug`
delegation with no `audience` at the tool boundary (a loud validation
error, not a fallback).

Because the audience check runs **host-side, at claim time** (the P-003
gate below) rather than at delegate/publish time, a trust **revocation**
takes effect on the very next claim attempt — no need to republish or pull
the standing offer.

## The host-side honor gates (fail-closed, D-003)

Every spend — fleet-scoped or pot-scoped — passes through the same gate
ladder in `delegated-spawn-honor.ts`. Only Gate 2.5/3.5 is new for the pot
form; everything else is unchanged from the original fleet-scoped design.

| Gate          | Checks                                                                                                                                                                                                                                                                       | Applies to                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1             | `ACCEPT_DELEGATED_SEATS` — the per-host, owner-authority, default-OFF master opt-in                                                                                                                                                                                          | both — the **one** intentionally-silent floor: a host with it off does no work at all, on either offer form |
| 2             | Offer resolution/match — a named offer id, a fleet-scoped match, or (P-004) a pot-scoped fallback when nothing fleet-scoped matches                                                                                                                                          | both                                                                                                        |
| **2.5 / 3.5** | **The audience gate (P-003, new):** fires ONLY when Gate 2 matched a POT-scoped candidate. `'trusted-members'` → the host's local trust store; `'whole-pot'` → pot membership. Refusal is **loud**: `audience_refused`, receipt threaded by offer id, visible in `p2p:trace` | pot-scoped only                                                                                             |
| 4             | Seat-cap pre-check                                                                                                                                                                                                                                                           | both                                                                                                        |
| 4.5           | Can-this-host-actually-run-it probe (`spawnConsole`, WI-5306)                                                                                                                                                                                                                | both                                                                                                        |
| 4.6           | Account resolution against **this host's own** gateway (WI-5316) — `'auto'` only survives to here; account id never leaves the host                                                                                                                                          | both                                                                                                        |
| 5             | The atomic claim — exactly one hook invocation spawns; this **is** the over-draw safety (D-001)                                                                                                                                                                              | both                                                                                                        |

Every refusal past Gate 1 is loud and threaded by offer id (visible from
both sides via `p2p:trace`) — a pot-scoped offer is bookkeeping the host
publishes about its own standing intent; the only thing that ever
**grants** execution is the host itself, at Gate 5.

## Spend paths

* **`fleet:request_remote_spawn`** resolves pot-level offers when no
  fleet-scoped offer is named or available, with deterministic host
  selection (round-robin) when more than one host offers to the same pot.
* **`fleet:launch-on-plan { placement: 'remote' }`** pools pot-scoped
  seat-offers alongside fleet-scoped ones into one combined pool *before*
  spreading the requested member count across it — a plan launched into a
  shared pot sees every donor, not just fleet-specific ones.

Both spend paths are **fleet-leader-only**: being a trusted (or whole-pot)
member is necessary but not sufficient to spend a delegated seat — you must
also be the leader of the fleet doing the spending. This is a third
authority axis alongside D-002's audience and the host-local
`ACCEPT_DELEGATED_SEATS` gate; see the traps doc for how this was
discovered live.

## Prose-first UX + the allocated-fleet model (D-004 / D-005)

\[owner:Avi 2026-07-18] End users never call endpoints directly — they
describe intent in prose (*"offer two sonnet seats to the design pot"*,
*"launch this plan on remote seats"*, *"why hasn't the remote member
arrived"*) and their chat agent owns the verbs. Concretely: the operator
chat surface exposes `fleet:create`, `fleet:request_remote_spawn`,
`p2p:trace` (plus the already-exposed `resource:delegate`) with per-tool
`guidance` mapping each prose pattern to a call; the plan-launch routing
gate (`plans/launch-prompt.ts`) presents the remote-fleet route, naming the
exact verb, whenever the plan's pot is shared **and** seat-offers exist.

The precise mental model for a "remote fleet" is an **allocated fleet** — a
fleet that runs only on explicitly allocated agent seats. The seat
*source* (the user's own machine via local delegation, or a peer's via a
federated pot/fleet offer) is orthogonal to that, and the code must never
assume all seats in an allocated fleet are remote:

* The routing gate states available inventory in prose **with donors
  named** — *"I see 3 agent slots available from these 3 users"* — sourced
  from the offer projection. An **empty** inventory is not a dead end: the
  fleet can still be created, and the agent says a peer must allocate
  seats to it afterward (offering to relay that ask over the hive).
* The agent always asks *"would you like to add any of your own agent
  slots to this remote fleet?"* and, on yes, executes the local
  delegation itself (`resource:delegate` to that fleet) — local and remote
  seats are placed uniformly by the same spread logic.

## Where the code lives

| File                                                 | Role                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `agent-tools/resource/delegate.ts`                   | the donate verb — fleet- or pot-scoped allotment + P2P offer publish                  |
| `agent-tools/resource/offers.ts`                     | the offer-visibility read (`/res` Agent-seats group, `potShared` view)                |
| `p2p/delegated-spawn-honor.ts`                       | the host-side honor gate ladder (1 → 2 → 2.5/3.5 → 4 → 4.5 → 4.6 → 5)                 |
| `agent-tools/fleet_registry/request-remote-spawn.ts` | the spend verb — resolves fleet- then pot-scoped offers, deterministic host selection |
| `agent-tools/plans/launch-prompt.ts`                 | the routing-gate prose (inventory disclosure, own-slots ask, exact-verb naming)       |
| `p2p/capabilities.ts`                                | the grant/assignment vocabulary v1.5 stays wire-compatible with                       |
| `p2p/pool-broker.ts`                                 | the v2 dual-signature broker (reference only — not used by v1.5)                      |

## Known limitation — cross-machine spend is currently unverifiable live

As of this writing, **P-011's live two-machine verify is blocked on a
diagnosed federation bug, not staffing.** A donor's `resource:delegate`
succeeds locally (confirmed with `hive` correctly passed, so this is
distinct from EI-16667 below) and the offer never reaches the spending
machine: `fleet:request_remote_spawn` on the spender only ever sees its
**own** machine's offer, and `p2p:trace` returns zero receipts on **both**
machines — not a refusal, no traffic at all. Every gate and spend-path
described above is unit- and integration-green (12 of 14 items on this
plan) — the gap is specifically in **getting the offer from donor to
spender across machines**, i.e. below this model, in the P2P federation
layer itself. Suspect area: whether both operators actually booted the
same shared-hive home at startup (a joiner only peers a home its operator
booted at startup — see the WI-560 fed-a/fed-b rig notes) before
concluding the publish path is broken. Tracked as **WI-5446**; treat any
cross-machine seat-donation claim as unverified until it resolves.

## Open question

`resource:offers`' pot-wide (`potShared`) visibility currently resolves
only on a workspace with exactly one shared hive, with no explicit
`hive`/`potSlug` disambiguation argument — see
[EI-16673](/internal/docs/agent-insights/seat-donation-model-traps) for the concrete
failure on a real multi-hive workspace. Left open rather than resolved
here: fixing it is a code change to `resource:offers`, out of scope for
this docs pass.

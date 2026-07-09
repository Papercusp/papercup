# Brief AA — Mug/Cup autonomous coordination over a SHARED pot

**Priority: S1 lane.** Integration + live. THE product use case — and largely untested
end-to-end. Rides A-003 (membership) + benefits from the re-key.

## Objective
Prove the **autonomous coding-pot loop works across a federated, multi-machine pot**:
the Mug on one machine surveys a shared plan, places work, Cups on member machines do
it, results federate back, and the whole place→work→complete→federate cycle converges —
without double-execution or split-brain.

## Why it matters
This is the *actual reason shared pots exist* — a coding pot whose Mug + Cups span
machines (the offsite-demo B9 scenario). Wave 2 proved the DATA federates
(work-item claims cross — B-003) and the substrate is sound, but **no test exercises the
autonomous Mug/Cup CONTROL loop over a real federated pot**. Claims federating is
necessary but not sufficient: does the Mug actually avoid double-placing across
machines? Does a Cup's completion on machine B reach the Mug on machine A and advance
the plan? That's the headline product promise and it's unverified end-to-end.

## Scope / scenarios
1. **Federated claim safety (the core):** Mug on A + a Cup on B both eligible for the
   same work-item → exactly ONE claims it (the work-item-claim authority routes
   cross-pot — `routeToAuthorityForHive`); the other sees the claim and does NOT
   double-execute. Test under concurrency + the real swarm, not just the in-process rig.
2. **Place→work→complete→federate cycle:** Mug surveys a shared plan, places an item;
   a Cup on the OTHER machine/member picks it up, completes it; the completion +
   artifacts federate back; the Mug sees `done` and advances. Assert the full loop
   converges with no lost completion.
3. **Cross-machine plan/work-item state:** plan items, assignments, statuses, comments
   all stay consistent across the federated pot (these types federate — assert the
   ORCHESTRATION reads them correctly, e.g. the Mug's survey sees remote progress).
4. **Authority churn during coordination:** the lock/claim authority host dies mid-cycle
   → re-election → claims still serialize, no double-execution (extends D's authority
   churn to the live federated Mug loop).
5. **Escalation / supervision across the pot:** a stuck/escalated item on a member
   reaches the Mug/overwatch on the owner; the watchdog GC works cross-pot.

## Method
- Integration via `shared-pot-loop` / `composition-rig` for the claim-safety + cycle
  (real testnet DHT, 2+ members). Live legs (real `.deb` pair, a real plan started in a
  shared coding-pot member → Mug wakes → Cup) where the engine allows — coordinate
  the engine state (some stacks gate background workers). Reuse the B9 pot infra. Mind
  double-execution = the S1 to hunt.

## Deliverables
- `findings-AA.md`: the federated-claim-safety + full-cycle convergence results, any
  double-execution / lost-completion / split-brain (S0/S1), and the live vs rig boundary.

## Done / verdict
GREEN only when the Mug/Cup loop runs over a federated multi-member pot with exactly-
once work execution, completions reaching the Mug, and convergence under authority churn.

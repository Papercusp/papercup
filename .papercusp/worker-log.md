# Worker log — EI-570 (implement / self-improvement auto-fix)

## EI-570: Tripwire arm-call-site never fires

**Bug**: `planReversibleArm` called `resolveAutonomyDecision` without `riskTier` when bees
don't pass `decision.riskTier`. Decider defaulted to `'critical'`. For `work-prioritization`
(ceiling=`low`), `critical > low` → gated → planWorkItemArm returned null → 0 tripwires armed.

**Fix** (arm-reversible-action.ts): Added imports for `categoryForAction` and
`effectiveCeiling`. In `planReversibleArm`, when `input.riskTier` is null, look up the
category's effective ceiling and use it as the risk proxy (if `!= 'never-auto'`). This makes
the arm gate agree with the chokepoint: both see `low ≤ low` → auto → tripwire arms.

**Files changed**:
1. `packages/operator-core/lib/autonomy/arm-reversible-action.ts`
2. `packages/operator-core/lib/autonomy/arm-reversible-action.test.ts`
3. `packages/operator-core/lib/agent-tools/work_items/arm-reversible-work-item.test.ts`

**Tests**: `npx vitest run arm-reversible-action.test.ts arm-reversible-work-item.test.ts`
→ 17 passed. `npm run test:affected` → 354 test files, 3392 passed (2 pre-existing failures
in launch-blueprint.test.ts, unrelated to this change).

---

# Worker log — EI-402 (implement / self-improvement auto-fix)

**Item:** EI-402 (kind=bug) — "Latitude VM creates platform-broken: correct
create (OS+site+key, Running) unreachable on all ports from 2 vantages — use
Hetzner for bench fleets until a retest clears it"

**Outcome:** `needs-human` (STOP condition — infra-environment, no code fix).

## What I did
1. `work_items:get EI-402` — read the item + thread. Triage decision is already
   **gate** with reason: "Infra-environment: Latitude VM provisioning is broken
   at the provider level (unreachable on all ports). No code fix applies — owner
   needs to decide whether to switch bench fleet provider to Hetzner or wait for
   Latitude retest. D-005 infra-environment -> owner-escalation." The
   auto-implement dispatcher picked it up despite the gate verdict.
2. Read agent-insights/latitude-vm-creates-currently-unbootable.md. It splits
   the original wedge into three legs:
   - Leg 1 (OS-less create husk) — already fixed in code.
   - Leg 2 (VM create ignored region/site) — already fixed in code.
   - Leg 3 (platform residue) — NOT fixable in code: a fully-correct create
     (OS attached, site honored, ssh key injected, status: Running) stays
     unreachable on 22 AND 443 from two independent vantages for 10+ minutes.
     This is EI-402.
3. Verified the two code legs are in place (trust-what-runs):
   packages/operator-core/lib/deployment/latitude/latitude-driver.ts
   - :53  const DEFAULT_VM_OS = 'ubuntu_24_04_x64_lts'
   - :175 ...(config.region ? { site: config.region } : {})
   - :177 operating_system: (...) ?? DEFAULT_VM_OS
   Pinned by latitude-driver.test.ts.

## Why needs-human (not fixed / could-not-fix)
- The remaining defect is a provider-side platform outage — there is no code to
  change, and you cannot write a regression test for a third party's broken
  control plane.
- The only available "fix" is a policy/infra decision (make Hetzner the default
  bench-fleet provider, or wait for a Latitude retest). That:
  - touches deploy/provisioning machinery (a protected surface), and
  - is explicitly an owner decision per the triage.
- Both are STOP conditions in the implement contract. A wrong auto-fix on
  provisioning machinery driven by a transient provider outage is exactly what
  this gate prevents.

## What the human should decide / re-verify
- Retest a correct Latitude vm.small create end-to-end (OS + site + ssh key) —
  if reachable, this EI can close. If still unreachable, decide whether to pin
  Hetzner as the bench-fleet default (provisioning-config change) until Latitude
  clears.
- Suggest also re-checking the triage routing: a gate/infra-environment item
  should not have been routed to the auto-implement runner.

---

## Re-dispatch (run 1781588418-worker, 2026-06-16) — root cause filed as EI-815

EI-402 was dispatched to the auto-implement runner AGAIN despite the prior
`needs-human` routing and its `gate` triage. That re-dispatch is itself the
proof of the gap the prior log flagged (line 48-49). This run:

1. Re-confirmed the two code legs are still fixed (latitude-driver.ts:53/175/177,
   pinned by latitude-driver.test.ts) — nothing to change; re-resolved `needs-human`.
2. Diagnosed WHY a gate-triaged item reaches the auto lane and filed it as a
   distinct, actionable bug: **EI-815**.

**EI-815 root cause:** `classifyImprovement`
(`packages/operator-core/lib/harness/improvements/policy.ts:281`) derives the
auto/human tier from `needsHuman` / kind / `infraEnvironmentHit`
(watchdogKey signal-source OR infra paths) / protectedPathPatterns (needs
`paths`) / protectedKeywords (title+body) — but **never consults
`ideaLifecycle.triageDecision`**. EI-402 is a `kind=bug` organic item with no
`watchdogKey`, no infra `paths`, and a title matching no protected keyword, so
`infraEnvironmentHit()` returns null and it falls through to `tier=auto`.
Compounding: triage `gate` does not set `payload.needsHuman`, so the tier-0
gate doesn't catch it either.

**Fix (EI-815, human-tier — touches the loop's own protected code):** either
force `tier=human` in `classifyImprovement` when
`ideaLifecycle.triageDecision ∈ {gate, reject}` (mirror the needsHuman gate),
or have triage `gate`/`reject` set `payload.needsHuman=true`. Add a
`policy.test.ts` case pinning that a gate-triaged kind=bug with no
watchdogKey/paths classifies `tier=human`. I did NOT implement it — it lives in
`harness/improvements/**`, a STOP/protected surface; captured instead.

## Validator re-verify
- Nothing to re-verify for EI-402 itself (no code changed this run).
- EI-815 carries the repro + the precise classifier gap; it should be picked up
  as a human-tier fix (the protected-path gate on its `paths` keeps it human).

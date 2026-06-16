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

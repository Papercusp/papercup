# Worker log — EI-570 (implement / self-improvement auto-fix)

## Dispatch attempt 2 (run 1781782617-worker, 2026-06-18)

**Status: VERIFIED FIXED — improvements:resolve blocked (EI-570 not found in system)**

The prior worker (attempt 1) applied the fix correctly:
- `planReversibleArm` in `arm-reversible-action.ts` now derives `riskTier` from the
  category's effective ceiling when absent (lines 137–147), ending the 0-tripwires bug.
- Regression tests in `arm-reversible-action.test.ts` and `arm-reversible-work-item.test.ts`
  pin the fix. 17/17 tests pass (verified this run).
- Agent insights MDX written at `arm-call-site-risk-tier-proxy.mdx`.

**Why improvements:resolve couldn't close the loop:**
`improvements:resolve { id: 'EI-570' }` returns `{ ok: false, error: "issue EI-570 not found" }`.
`work_items:get EI-570` and `issues:get EI-570` both return not-found.
The improvements digest (77 total, 67 resolved) shows IDs only in the 1000+ range — EI-570 predates
the current active range. The first worker likely applied the fix without successfully resolving the ID,
and the ID has since been purged/expired from the system.

**What a human should verify:**
- The fix IS in place and tests are green. No re-work needed.
- The cadence will keep re-dispatching EI-570 unless the dispatch queue is manually purged for this ID.
  Consider: (a) checking whether the improvements dispatcher holds a stale queue entry for EI-570,
  and (b) confirming the dispatch routing can handle "not found" IDs gracefully (STOP condition: touches
  the self-improvement loop's own code — EI-815 context).



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

---

# Worker log — EI-7472 (green-stall-watchdog dedup flag clobbered ~hourly)

**Item:** EI-7472 (kind=bug) — `gate_health.watchdogAlerted` clobbered every red
green-checkpoint tick → fleet re-spammed the STALLED severe-event ~hourly.
**Outcome:** FIXED + regression test; affected tests green.

## Root cause (confirmed against source)
`trackGateStall` (`packages/operator-core/lib/harness/routines/release-actions.ts`)
final write is `UPDATE … SET metadata = COALESCE(metadata,'{}') || $2::jsonb` with
`$2 = {gate_health: next}` — a SHALLOW top-level jsonb merge that REPLACES the whole
`gate_health` key with `next`. Both the red and reset `next` objects omitted
`watchdogAlerted` (owned by the separate green-stall-watchdog sweep), so every hourly
red fire dropped it back to absent → the watchdog (designed one-shot-until-recovery)
re-fired its `green-stall:<slug>` severe-event ~hourly to every live session.

## Fix (minimal, no schema change, behavior-neutral for the deploy decision)
release-actions.ts `trackGateStall`:
- widened the inline `gh` row type to include `watchdogAlerted?: boolean`;
- RED path `next`: `watchdogAlerted: gh.watchdogAlerted ?? false` (preserve);
- RESET/green path `next`: `watchdogAlerted: false` (recovery clears it, matching
  the watchdog's own recovery-clear);
- exported `trackGateStall` for the regression test.
New test `release-actions.gate-health.test.ts` captures the real `sql.unsafe` UPDATE
params (partial `@papercusp/db-org` mock overriding only lazy `getOrgPg`) and asserts
the flag survives a red tick and clears on green.

## Verification
- `vitest run release-actions.gate-health.test.ts release-actions.test.ts green-stall-watchdog.test.ts`
  → 60 passed (3 new).
- Fails-before proven: temporarily reverted the red-path field → 2 red-path tests
  failed; restored → green.
- `tsc --noEmit` (operator-core): no errors reference the touched files.

## Validator re-verify (live)
After a red green-checkpoint fire on a still-stalled slug,
`metadata->'gate_health'->>'watchdogAlerted'` should stay `true` (not null), and no
second `green-stall:<slug>` severe-event for the same unbroken red streak. Did NOT
touch the underlying red suites (separate content issues, out of scope).

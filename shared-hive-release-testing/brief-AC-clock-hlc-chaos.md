# Brief AC — Clock/time CHAOS & HLC internals robustness

**Priority: S1 lane (S0 if it breaks convergence).** Integration + property-based.
Hardens the NEW, load-bearing `fed_hlc` clock that D-001 just shipped.

## Objective
Prove the HLC clock-of-record (`hlc_clock`/`fed_hlc`, mig-314) stays correct + federation
stays convergent under **clock CHAOS**, not just the steady forward-skew D-001 tested.

## Why it matters
D-001 proved LWW converges under static clock skew, and it's now the S0 fix SHIPPED to
production. But the HLC has internals that the skew test assumed away: a clock running
BACKWARDS, an NTP step mid-federation, the HLC counter near overflow, leap seconds, and
long-running drift. The HLC's whole job is to provide a stable ordering key under
exactly these conditions; if a backwards clock or a counter wrap breaks monotonicity,
D-001's convergence guarantee silently fails — and it's now load-bearing for the re-key
key-ordering too (a member needs epoch-N's key before epoch-N content, ordered by fed_hlc).

## Scope / scenarios
1. **Clock runs BACKWARDS:** set the wall clock backwards mid-session (NTP correction,
   VM pause/resume) → assert `hlc_now()` stays monotonic (the HLC physical-vs-logical
   split absorbs it), no fed_hlc regression, federation still converges.
2. **NTP step (forward + backward):** a sudden large clock jump on one peer → both
   directions, assert no divergence + the recv-seam (`observeRemoteHlc`) handles it.
3. **HLC counter overflow / wraparound:** drive the logical counter to its max within a
   single physical tick (many ops same-ms) → assert it carries to the next physical
   correctly, no collision, no overflow corruption.
4. **Leap second / same-physical-time ties:** many ops at the identical physical ts →
   the counter disambiguates deterministically across peers.
5. **Long-drift soak:** two peers with continuously drifting clocks over a long run →
   convergence holds, fed_hlc ordering stable, no unbounded counter growth.
6. **Mixed pre-314 / no-HLC rows under chaos:** the back-compat fed_ts fallback path
   under clock chaos (ties to Brief Y) — no resurrection when clocks misbehave.

## Method
- Integration with a controllable clock seam (the `_setNowForTests` / hlc-stamp nowMs
  override) + the convergence-fuzz rig extended with clock-chaos injectors (seeded, no
  Math.random). Property test: for ANY clock-event sequence, the HLC stays monotonic +
  peers converge. Teeth-verify (neuter the physical-vs-logical carry → backwards-clock
  test goes RED).

## Deliverables
- `findings-AC.md`: the clock-chaos matrix (backwards/step/overflow/leap/drift), any
  monotonicity break or divergence (S0), the HLC counter-overflow behavior documented.

## Done / verdict
GREEN only when the HLC stays monotonic + federation converges under backwards clocks,
NTP steps, counter overflow, and long drift — the S0 fix's foundation proven under chaos.

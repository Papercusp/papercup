# Brief AE — Combined chaos / INTERACTION (the everything-at-once capstone)

**Priority: S0 lane — the highest-leverage test left.** Integration + live. Run LAST,
after A-003 (a′) + the re-key land — this is the integration capstone for the whole program.

## Objective
Stress shared-hive under **many dimensions at once** in one long seeded scenario —
multi-member + churn + concurrent writes + a re-key + a crash/restart + clock skew +
version-skew — and assert it stays **convergent, lossless, leak-free, and correct
throughout.** Find the INTERACTION bugs that every isolated green lane misses.

## Why it matters
Every other lane tests ONE dimension and passes. But production hits all of them at
once, and the bugs that ship are the interactions: a re-key DURING membership churn, a
crash MID-drain DURING a re-key, clock skew DURING a partition heal, a version-skew peer
JOINING mid-chaos. These combinations are exactly where the carefully-fixed pieces
(D-001 HLC ordering, the re-key epoch ordering, A-003 hive-home federation, crash
recovery) can interfere. Isolated-green ≠ composed-green. This lane is the real
"is it production-ready" integration test — and it's the one that most justifies a
confident public-release sign-off.

## Scope / scenarios (one long seeded run, assert invariants continuously)
1. **The composed chaos run:** N members; continuous concurrent writes across all
   content types; randomly (seeded): members join/leave/rejoin, the owner removes a
   member (→ re-key epoch advance), instances crash + restart, clocks skew/jump, a
   version-skew peer joins. Throughout, assert: all honest peers converge to identical
   state; no loss/dup; watermarks monotonic; removed members can't read post-removal
   content (re-key cut-off holds under churn); no leak (RSS bounded); no deadlock/hang.
2. **Targeted interaction pairs** (cheaper, deterministic) for the riskiest combos:
   re-key × churn, crash × re-key (crash mid-epoch-advance → recover to consistent
   epoch), partition-heal × clock-skew, version-skew-join × re-key, A-003-membership ×
   removal.
3. **Soak variant:** run the composed chaos for an extended window → assert no slow
   leak/drift/divergence accumulates (ties to Brief W).
4. **Invariant harness:** a reusable continuous-invariant checker (convergence,
   no-loss, monotonic-watermark, re-key-cutoff, bounded-RSS) the run asserts every step.

## Method
- Compose the existing rigs (`composition-rig`, `_cross-peer-rig`, `_hive-substrate-rig`,
  convergence-fuzz, swarm-chaos) + the re-key + crash-recovery (Brief S) into ONE seeded
  driver. Seeded/deterministic (no Math.random — vary by index/args) so failures repro.
  Live legs on the real `.deb` where feasible (the integration capstone). Teeth-verify
  the invariant checker itself (inject a known divergence → it must catch it).

## Deliverables
- `findings-AE.md`: the composed-chaos verdict + every interaction bug (the class the
  isolated lanes can't surface), the reusable invariant harness, the soak result.
  Any divergence/loss/leak/cutoff-failure under combined chaos = S0.

## Done / verdict
GREEN only when shared-hive stays convergent, lossless, leak-free, and revocation-correct
through a long composed-chaos run combining churn + re-key + crash + skew + version-skew.
**This GREEN is the strongest single signal that the feature is public-release-ready.**

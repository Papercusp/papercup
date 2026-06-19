# Brief Y — Version-skew / rolling-upgrade / migration federation

**Priority: S1 lane.** Integration + 2-version live. The guaranteed-real upgrade case.

## Objective
Prove peers on **different code/schema versions federate safely** — an old peer and a
new peer in the same hive — and that migrations + the re-key roll out without splitting
or corrupting the hive.

## Why it matters
A deployed product updates continuously, and members update at different times — so
**version skew between federating peers is guaranteed**, not hypothetical. The substrate
just gained Migration 314 (`fed_hlc`) and is about to gain the re-key epochs — both are
exactly the kind of change that breaks cross-version federation if not back-compat. D-001
explicitly carries pre-P-010 rows with no HLC; the column-completeness guard is per-build,
not cross-version. Untested skew = silent divergence or data loss in production.

## Scope / scenarios
1. **Old peer ↔ new peer (live):** build two `.deb`s a version apart (e.g. pre-314 and
   head), federate them. Assert content crosses both ways + converges — the new peer's
   `fed_hlc` ops degrade gracefully on the old peer, and the old peer's no-HLC ops are
   handled by the new peer's guard (the documented back-compat path). No divergence.
2. **mig-314 back-compat:** a peer with pre-314 rows (no `fed_hlc`) federating with a
   314 peer — assert the LWW guard's `fed_ts` fallback works, no resurrection, converges.
3. **Schema-migration skew:** one peer has applied a new migration, the other hasn't —
   does a federated op for a new column drop silently (the requeue_count / B-001 class)?
   Assert graceful degradation, not silent loss.
4. **Re-key epoch back-compat (coordinate w/ V):** a new-hives-only encrypted hive vs a
   legacy unencrypted hive; a peer that predates the re-key joining an epoch'd hive.
   Assert the new-hives-only boundary holds + no mixed-epoch corruption.
5. **Downgrade safety:** a peer rolled BACK a version — does it crash / corrupt / poison
   the shared log, or degrade safely? (Forward-only is acceptable IF it fails closed.)
6. **Rolling upgrade of a live hive:** members upgrade one at a time while writing —
   assert continuous convergence throughout the mixed-version window.

## Method
- Two-version live harness: build `.deb`s at two SHAs (sidecar-swap two staging
  snapshots, or git-checkout an older sidecar). Integration tests for the guard/migration
  back-compat using the real migration runner (000→N vs 000→head). Teeth-verify.

## Deliverables
- `findings-Y.md`: the skew matrix (old↔new × content/mig/re-key/downgrade), any
  divergence/silent-drop/corruption under skew (S0/S1), and the documented
  min-supported-version / forward-compat policy.

## Done / verdict
GREEN only when an old peer + a new peer federate and converge across a content + schema +
re-key version gap, with graceful degradation (never silent loss/divergence) and a stated
compat policy.

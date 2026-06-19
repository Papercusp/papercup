# Findings Y — Version-skew / rolling-upgrade (federation back-compat core)

**Owner:** su-860d3 · **Date:** 2026-06-19 · **Verdict: 🟡 back-compat core GREEN
(monotone) + 1 latent comparator finding (EI-1698); upgrade/migration E2E + re-key
epoch back-compat DEFERRED.** Also closes Brief AC scenario 6 (mixed pre-314/no-HLC).

## TL;DR

A rolling upgrade federates a MIX of pre-314 (no-HLC, order by `fed_ts`) and post-314
(HLC) peers. The PG-free property layer proves: **under monotone clocks a mixed
federation CONVERGES across the full no-HLC fraction sweep (0%→100%)** — the back-compat
guarantee for the normal case. It also surfaced **EI-1698**: the shared LWW rule
("both-HLC → compare HLC, else → compare ts") used by `lwwPick` AND the PG `fed_hlc` guard
is **non-transitive under mixed HLC presence + clock skew**, so the fold winner can become
order-dependent → a *latent* rolling-upgrade divergence. Proven by a deterministic minimal
repro; **not reachable with today's ts distribution** (analysis below).

**Deliverable:** `packages/operator-core/lib/sync/hyperbee/__tests__/version-skew-mixed-hlc-backcompat.test.ts`
(4 tests, PG-free, ~40ms, tsc-clean). Reuses Brief D's `FedTsGuardedStore` + the real
`HlcClock`/`stampOpHlc`/`lwwPick`/merge seams (no shared-file edits).

## What the existing tests miss (the gap this fills)

Every prior HLC universe is HOMOGENEOUS in HLC presence: `_convergence-fuzz-rig` / AG / AC
stamp EVERY op (`stampOpHlc` always sets `hlc`), and `lww-hlc-fedts-divergence.test.ts` is
also all-HLC. So the MIXED case — the literal rolling upgrade — was untested. This file is
the first to fold no-HLC and HLC ops together under the shipped `fed_hlc` guard.

## Properties / results

| # | Result |
|---|--------|
| **Y.1 monotone mixed convergence** | 🟢 GREEN — pre-314 ↔ post-314 mix converges across hlcFrac ∈ {0,.3,.5,.7,1.0} (the back-compat guarantee for monotone clocks) |
| **Y.2 / EI-1698 non-transitivity** | ⚠ FINDING — deterministic minimal repro: a no-HLC op between two HLC ops whose HLC order inverts their ts order forms a comparison CYCLE (X>Z on HLC, Z>Y on ts, Y>X on ts) → fold-order-dependent winner |
| **Y.3 end-to-end characterisation** | the cycle is reachable through the REAL merge+guard under an adversarial (uniform-ts) mixed universe |
| **Y.4 cross-version pair** | 🟢 a single HLC vs a single no-HLC op on a key resolves order-independently (a 2-op pair is always transitive — the cycle needs ≥3) |

## EI-1698 — the latent non-transitivity (honest reachability)

`lwwPick` and the PG guard both use "both-HLC → HLC, else → ts". That is non-transitive
when HLC presence is mixed: see the X/Y/Z cycle above. A non-transitive comparator makes
the reduce-fold winner depend on delivery order → two peers can DIVERGE on a contended key.

**Why LATENT, not active:** the cycle needs a no-HLC op with ts BETWEEN two HLC ops on the
same key. Post-P-010, `stampOpHlc` stamps EVERY LWW write, so no-HLC LWW ops are only
pre-P-010 history = OLDEST ts → they sit at the BOTTOM of a key's ts order (lose every
mixed ts comparison), and the comparator degenerates to transitive HLC-ordering among the
newer ops → converges. The divergence is reachable only with a no-HLC op at mid/recent ts
(my property model places them at arbitrary ts — more adversarial than production). It
would go live if any post-P-010 LWW path emitted a no-HLC op with a recent ts (none known)
or a pre-P-010 row's ts exceeded a later HLC op's (narrow skew edge).

**Why it still matters:** this is the load-bearing LWW ordering (D-001's S0 fix) and is
about to carry MORE weight — the C-001 re-key orders epoch keys by `fed_hlc`. Closing the
non-transitivity before the epoch complexity lands is cheap insurance.

**Fix (trivial):** compare in ONE order space — synthesize an HLC from ts for a no-HLC op
at compare time (`missing hlc → encodeHlc({ms: ts, count: 0})`) in both `lwwPick` and the
guard, or backfill the `fed_hlc` column for pre-314 rows. Then every comparison is
HLC-space → a single total order → transitive → convergent for any mix.

## Deferred (the rest of Brief Y — integration / re-key-gated)

- **Old-peer ↔ new-peer LIVE federation** through the real capture→drain→PG path (this is
  the PG-free fold model; the real-binary cross-version witness is integration — the AK/
  A-003 .deb pattern, calm-box).
- **mig-314 fed_hlc pre-314 back-compat at the SQL layer** (the column NULL-fallback in the
  real `ON CONFLICT`; covered model-side here, integration to confirm live).
- **Downgrade** (new peer → old peer) and **re-key epoch back-compat** — ride the C-001
  re-key (K lane).

## Done / verdict

🟡 **Monotone mixed back-compat GREEN** (rolling-upgrade convergence in the normal case)
**+ EI-1698** (latent comparator non-transitivity, proven + reachability-bounded + a
trivial fix). The live cross-version witness + the SQL-layer + re-key-epoch back-compat are
integration/re-key-gated and deferred. Closes AC scenario 6. Complements AG + AC.

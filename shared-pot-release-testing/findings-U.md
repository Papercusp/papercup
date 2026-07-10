# Findings U — Federation silent-failure observability

**Owner:** su-9140a. **Date:** 2026-06-19. **Verdict: 🟡 YELLOW — gap confirmed (S1) +
DETECTION LOGIC LANDED + teeth-verified; only the live surface-wiring remains (→ M).**
Federation can stall *silently*: a stuck outbox / not-federating harness reports as
**"healthy"** through every current signal. This is the exact gap that let EI-681
(A-003 send-side) sit invisible for the entire release-testing session — found only by
hand-drilling Postgres (`drained_at=NULL`), not by any health surface.

> **UPDATE (su-9140a, implemented this session):** the drain-health verdict logic is
> now BUILT + teeth-verified — `assessHarnessSubstrateHealth` (`health.ts`) takes a
> `drainStats {undrainedCount, oldestUndrainedAgeMs}` input and flips the verdict off
> `healthy` (→ `degraded` ≥60s, → `unhealthy` ≥5m, worst-wins); `getInProcessSubstrateStatus`
> threads it via an injected `resolveDrainStats` (same PG-free pattern as `resolveClaimStats`)
> + exposes per-harness `drain`. **18/18 tests green; teeth-verified** (neuter the drain
> guard → the 3 stall tests go RED; restore → GREEN). So the signal now EXISTS.
> REMAINING (handed to M, owns the route + G-004 surface): pass a `resolveDrainStats` that
> queries `harness_shared.substrate_outbox` (COUNT(*) + age of MIN(created_ts) WHERE
> drained_at IS NULL, per booted scope, pre-fetched since the resolver is sync) into
> `getInProcessSubstrateStatus` in `federation-status.ts`, and render the per-pot sync
> line in `HiveFederationStatus`. Then EI-1618/EI-1599 close + a stuck outbox is visible live.

## Audit — what federation health signals exist today (code evidence)

1. **`GET /api/discovery/federation-status` (G-004, M's lane)** — reports:
   - `pots[].reachablePeers` = topic peer count (`reachablePeersForHive`).
   - `substrate` = install-wide **boot** health (`getInProcessSubstrateStatus`):
     `{active, bootedHarnesses, healthy, booting, degraded}`.
   - **Its own doc comment**: *"There is deliberately NO 'synced' / 'connected to peer X'
     field."* So it answers "is my infra UP", never "is my content actually CROSSING".

2. **`getInProcessSubstrateStatus` (`in-process-status.ts`)** — per-harness `healthy`
   is derived from **whether the harness is BOOTED** (listBootedHandles), NOT from
   drain/outbox state. A harness that is booted but never joins its topic / never
   drains its outbox (the EI-681 signature) counts as **healthy**.

3. **`substrate-outbox-backstop-gc.ts`** — a GC, NOT a detector. Its own header: rows
   under a `(workspace_id, harness_slug)` whose substrate isn't booted "have no drain
   AND no inline GC — they accumulate forever" (the EI-126 102 GB class), so it
   **DELETES** them. It cleans up a stuck/orphaned outbox; it emits **no health signal**
   — and (worse) can silently DROP content that never federated.

4. **No drain-lag metric, no stuck-outbox alert, no periodic federation reconcile** —
   grep for `outbox.*lag` / `stuckOutbox` / `reconcile.*federat` / `drainLag` finds
   nothing in the federation path. (The EI-681 memo also confirms: "substrate boots
   ONLY at host-bootstrap; there is NO periodic reconcile.")

## The gap (S1)
**Every current signal reports BOOT + TOPIC-PEER state; none reports DRAIN/SYNC state.**
So the failure mode "harness booted, outbox capturing, but `drained_at=NULL` forever
(not on topic / drain unwired)" — i.e. EI-681, and the EI-126 mis-route class — is
**undetectable**: `federation-status` shows `substrate.healthy`, `reachablePeers` may be
>0 (the member's), and the only thing that touches the undrained rows is a GC that
deletes them. A user (or an agent) is told their pot is healthy while its content
silently never syncs. For a public product, "synced" must not be a lie of omission.

## Proposed fix (minimal, test-able)
- **A drain-health signal.** Surface, per booted harness: `oldestUndrainedAgeMs` +
  `undrainedCount` (cheap: `MIN(captured_ts)/COUNT(*) WHERE drained_at IS NULL` per
  scope). Add to `getInProcessSubstrateStatus` + `federation-status`. A harness with
  undrained rows older than a threshold (e.g. > N s) = **`degraded`/`stalled`**, not
  `healthy`.
- **A periodic federation self-check** (the missing reconcile): flag any harness whose
  outbox has undrained rows past threshold OR that should be on a topic but isn't
  (the EI-681 invariant) → log/metric/UI surface.
- **Honest G-004 copy:** the desktop status must show "stalled / not syncing" when the
  drain signal is red — coordinate with M (G-004 owns the surface).

## Tests (to author — teeth-verified)
1. **Induces a stuck outbox** (capture rows for an unbooted/not-on-topic harness),
   then asserts the NEW drain-health signal reports `stalled`/`degraded` (RED today →
   GREEN after the fix). Without the fix, the test documents the silence (asserts
   `federation-status` wrongly reports `healthy` — the bug).
2. **federation-status reflects drain:** extend `federation-status.test.ts` — a harness
   with undrained-past-threshold flips `healthy`→`degraded`.
3. **backstop-GC does not silently drop un-federated content** without first surfacing
   it (assert it emits a signal / respects a min-age that allows federation first).

## Verdict / done
🔴 RED — the observability gap is confirmed with code evidence and is the root reason
EI-681 was invisible. GREEN when a stuck/never-draining harness is DETECTABLE via a
real drain-health signal (test-proven) and the desktop status reflects true sync state.
Filing an EI for the drain-health signal + the periodic self-check. (Implementation is a
small, additive surface; recommend it lands alongside the A-003/EI-681 fix so the next
silent-federation bug isn't found by PG-drilling.)

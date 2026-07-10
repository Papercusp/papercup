# Findings — Fresh-boot LIVE re-test (2026-06-19, su-9140a)

**Context.** A host restart killed the A–G live fleet mid-program. This is the
live re-verification on a **fresh boot**: the prior converged findings (see
`RELEASE-READINESS.md`) are re-confirmed against the **real packaged binary**, and
the forward work is re-cut into the wave-2 lanes (`CONTINUATION-PLAN.md`,
briefs H–N). This file is the durable record of *what is true live, right now*.

## Method
- Binary: `Papercusp_0.0.2_amd64.deb` (`/home/marsh-office/.cargo-target/release/
  bundle/deb/`, 05:33 build, luxon bundled — A-001 fix in the artifact).
- Harness: `papercusp-desktop/bin/two-instance-content-matrix-smoke.sh`,
  `SKIP_INVITE=1` (single pot, to isolate the unfixed A-002 multi-pot variable).
- Topology: 2 distinct real peers — A = papercupai (owner), B = aviynw (joiner) —
  over a local testnet DHT, headless **Xvfb :154** (never :0; fleet-halt-safe).
- Verification: each peer's embedded PG `origin` column
  (`harness_shared.*`, `origin='remote'` on the peer = it crossed).
- Also re-ran the deterministic convergence units (`convergence-fuzz`,
  `lww-hlc-fedts-divergence`) — restart-independent regression check.

## Live content-federation matrix (real binary, fresh boot)

Pre-flight: **A-001 boot GREEN** (both real binaries booted) ·
**negative-isolation PASS** (non-joiner sees zero) ·
**topic-equal PASS** (`75e49c5c3807c920…`, the joiner-resolves-own-topic path).

| Content type | backfill (late-join) | incr A→B | incr B→A |
|---|---|---|---|
| features | ✅ remote | ✅ remote | ✅ remote |
| conversations | ✅ remote | ✅ remote | ✅ remote |
| messages | ✅ remote | ✅ remote | ✅ remote |
| threads | ✅ remote | ✅ remote | ✅ remote |
| thread-posts | ✅ remote | ✅ remote | ✅ remote |
| plans | ✅ remote | ✅ remote | ✅ remote |
| plan-parts | ✅ remote | ✅ remote | ✅ remote |
| item-assignments | ✅ remote | ✅ remote | ✅ remote |
| presence | ➖ outbox=0 | ➖ outbox=0 | ➖ outbox=0 |
| pot-settings | ❌ outbox=3 | ❌ outbox=4 | ❌ outbox=1 |
| pot-members | ❌ outbox=1 | ❌ outbox=1 | ❌ outbox=1 |

- ✅ **8/11 types federate BIDIRECTIONALLY** in all three phases — the headline
  GREEN path, re-proven on the real binary post-restart.
- ➖ **presence** rides the separate announce wire (`wire-presence.ts`); it is not
  capturable via raw-INSERT (outbox=0) — **by design, NOT a fail.** Do not re-file.
- ❌ **pot-settings + pot-members = A-003, re-witnessed LIVE.** The outbox IS
  populated (capture works) but the joiner never applies them — in backfill AND
  both incremental directions. (`pot-members` incr A→B also shows a rig
  `SETUP-FAIL` dup-key on the seed PK — a test artifact, not a federation result.)

## Convergence (D-001) — restart-independent
`convergence-fuzz.test.ts` + `lww-hlc-fedts-divergence.test.ts`:
**8 passed | 2 expected-fail.** The 2 `it.fails` markers are the **D-001 S0
divergence**, still reproducing. Unchanged from the converged verdict.

## Verdict delta vs RELEASE-READINESS.md
No change to the release verdict (🔴). This pass **strengthens the evidence**:
- **A-001** — now witnessed booting end-to-end on a fresh host (not just artifact-bundled).
- **A-003** — promoted from rig/analysis to a **live, three-phase witness** on the real binary.
- **D-001** — re-confirmed reproducing.
- **Core federation** — 8/11 bidirectional GREEN re-confirmed live; the feature's
  happy path genuinely works on the packaged app.

The remaining work is **fix + product-decision + deeper-live**, now cut into
briefs H–N (`CONTINUATION-PLAN.md`). Nothing here is new-blocker; it is the
converged set, re-grounded in live evidence.

## Live pair (left up for the live lanes)
`~/.papercusp-shared-pot-retest/instances.env` (A/B sidecar + embedded-PG ports,
DHT bootstrap, `DISPLAY=:154`). Teardown: `~/.papercusp-shared-pot-retest/stop.sh`
(path-scoped `pkill -f <WORK>` — safe; never name-pattern the binary).

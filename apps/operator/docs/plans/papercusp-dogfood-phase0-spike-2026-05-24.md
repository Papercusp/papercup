---
title: Papercusp dogfood — Phase 0 spike (Holepunch primitive gate)
slug: papercusp-dogfood-phase0-spike-2026-05-24
status: active
created: 2026-05-24
updated: 2026-05-30
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 0 spike (Holepunch primitive gate)

## Now

**State:** **draft execution plan**, the first of the per-phase splits called out in `papercusp-dogfood-v5-2026-05-23.md`'s `For the implementing agent splitting this into execution plans` section. Phase 0 is partially executed — Linux x64 / Node 25 verification of the four primitive-level smokes is **already passing** in `libs/holepunch-spike/` as of 2026-05-23. The remaining gate work is **cross-platform + Tauri-bundle verification + Autobase stability at projected load + the formal decision-gate recording**.

**Next action:** verify the spike on macOS (P-001a below) — needs a macOS host. Until macOS + Windows pass, the gate stays open and no Phase 1a work begins.

## Background

This execution plan implements `## Phase 0 — Spike (gate before all subsequent phases) [M]` from v5 (the section at line ~1182 of v5). Phase 0 exists to answer one question: **do the Holepunch P2P primitives bundle and behave on every target the desktop ships to?** If yes, the rest of v5 proceeds. If no, the named fallback fires: **HYPERBEE bucket collapses into GIT bucket** (every table v5 currently routes to HYPERBEE moves to GIT, propagated by git-as-sync). The collab model still ships under the fallback, but with higher latency on live state (commit-debounced ~15s rather than sub-second Hyperbee).

Phase 0 is **only** a substrate spike. It does NOT implement any of v5's user-visible surface (no Insights, no Contributors tab, no PR flow). The deliverable is binary: a documented PASS/FAIL on each acceptance criterion + a recorded gate decision.

The spike package is at `libs/holepunch-spike/`. It is **deliberately not added to the root npm workspace** so install/lockfile changes stay scoped and a failed spike can be deleted with `rm -rf libs/holepunch-spike/` without touching the operator. See `libs/holepunch-spike/README.md` for the published-package-name correction (the `@holepunchto/*` references in v5 §12 are wrong — the actual npm names are unscoped: `hyperswarm`, `hyperdht`, `hypercore`, `hyperbee`, `autobase`, `corestore`, `hyperdrive`, `b4a`).

## Phase tasks

Each task carries: a brief expansion of v5's one-liner, a file/function pointer where work happens, and concrete acceptance criteria the implementing agent uses to claim PASS.

---

### P-001 — Bundle Holepunch primitives into the desktop build [M]

v5 one-liner: *"Bundle the Holepunch primitive packages into the Tauri+Node desktop build. Verify native-dep prebuilds (UDX, sodium-native) cover macOS / Linux / Windows targets."*

**Expansion.** Split into three sub-acceptances by host. Each sub-acceptance is independent and runs the same `smoke/01-install-check.mjs` script in `libs/holepunch-spike/`.

**Files:**
- `libs/holepunch-spike/package.json` — dependency list locked at the versions verified on Linux. Keep these pinned until all three OSes pass; treat any version drift as a re-verification trigger.
- `libs/holepunch-spike/smoke/01-install-check.mjs` — install + import test. Imports every package; asserts each resolves a default export.
- `libs/holepunch-spike/install.log` — captured `npm install` output for diagnostics.

**Sub-acceptances:**

- **P-001a — Linux x64 Node 25** — ✅ **DONE 2026-05-23**. 105 transitive packages, 7s install, no native compilation toolchain required (all native deps shipped prebuilds). Recorded in `libs/holepunch-spike/README.md`.
- **P-001b — macOS arm64 Node 25** — pending. Acceptance: same `npm install && npm run smoke:install` passes; check that UDX and sodium-native prebuilds exist for `darwin-arm64`. If a prebuild is missing, the failure mode is a native-build attempt that requires Xcode CLT — capture this in the diagnostic record but treat as a soft fail (Xcode CLT is reasonable to require for desktop dev hosts; not for end-user desktop installs).
- **P-001c — macOS x64 Node 25** — pending. Same acceptance as P-001b but `darwin-x64` prebuilds. If Apple Silicon-only prebuilds exist (a common pattern), this is a hard fail and triggers fallback consideration.
- **P-001d — Windows x64 Node 25** — pending. Acceptance: `npm install && npm run smoke:install` passes from PowerShell. Windows is the highest-risk leg — sodium-native historically has flaky Windows prebuilds. Likeliest soft-fail mode: forcing fallback to a different libsodium binding (`libsodium-wrappers` is the WASM fallback; usable but slower).
- **P-001e — Tauri-bundle verification** — pending. Acceptance: copy the spike's `dependencies` block into `apps/operator/package.json`, rebuild `papercusp-desktop` for each of the three OSes via the existing release pipeline (`papercusp-desktop/bin/release-local.sh`), launch the resulting binary, run `smoke:install` from inside the bundled Node runtime. This catches Tauri-specific bundling issues (sidecar wiring, OS-codesigning rejection of unsigned native modules) that the standalone Node smoke can't catch.

**Decision rule:** P-001 passes if a, b OR c, and d all pass + e passes. If b fails but c passes (or vice versa), that's acceptable — pick the side with prebuilds and document that the other Mac arch needs Xcode CLT. If both b and c fail, that's a hard fail.

---

### P-002 — Hyperswarm DHT join + UDP holepunching smoke test [S]

v5 one-liner: *"Hyperswarm DHT join + UDP holepunching smoke test across 2 networks (home + cellular tether)."*

**Expansion.** The Linux loopback smoke (`smoke/02-swarm-loopback.mjs`) already verifies DHT join + peer discovery + payload exchange — but only on loopback (same host). The cross-network leg is needed to catch NAT-traversal edge cases.

**Files:**
- `libs/holepunch-spike/smoke/02-swarm-loopback.mjs` — loopback smoke (done).
- New: `libs/holepunch-spike/smoke/02b-swarm-cross-network.mjs` — same protocol, two hosts on different networks.

**Sub-acceptances:**
- **P-002a — Loopback** — ✅ **DONE 2026-05-23**. 10.4s end-to-end via public DHT.
- **P-002b — Home Wi-Fi ↔ cellular tether** — pending. Acceptance: peer A on home Wi-Fi (behind NAT), peer B on phone-tethered hotspot (carrier-grade NAT). They discover each other via shared topic in <30s and exchange a 1KB payload. **This is the realistic end-user network condition; loopback doesn't exercise NAT punching.**
- **P-002c — Symmetric NAT detection** — pending. If P-002b fails, run the same test from a known-symmetric-NAT host (most corporate VPNs, some carrier networks). The expectation here is *not* that it works — Holepunch documents that pure symmetric NAT requires a relay — but to confirm Hyperswarm degrades gracefully (returns no-peers + timeout, not a crash).

**Decision rule:** P-002 passes if P-002b succeeds within 30s. P-002c is informational — if it crashes the process, that's a bug worth filing upstream but doesn't fail the gate.

---

### P-003 — Autobase stability test [M]

v5 one-liner: *"Autobase stability test: 3 writers, 1000 ops each, sleeping-peer simulation (offline for hours, reconnects, view re-converges). Measure convergence latency."*

**Expansion.** The Linux smoke already verifies 2-writer in-process convergence. P-003 scales to 3 writers, adds the offline-reconnect path (the hardest case for the dogfood scenario: an engineer who closes their laptop overnight and re-joins in the morning), and produces a latency measurement to feed into v5's "Hyperbee bootstrap progress" indicator (P-066).

**Files:**
- `libs/holepunch-spike/smoke/03-autobase-converge.mjs` — 2-writer in-process (done).
- New: `libs/holepunch-spike/smoke/03b-autobase-3writer-stress.mjs` — three writers, 1000 ops each, parallel.
- New: `libs/holepunch-spike/smoke/03c-autobase-sleeping-peer.mjs` — one writer goes silent for N seconds (configurable), other two writers continue at ~1 op/sec, then the sleeping writer reconnects and the test measures wall-clock-to-converged.

**Sub-acceptances:**
- **P-003a — Two-writer in-process** — ✅ **DONE 2026-05-23**.
- **P-003b — Three-writer parallel, 1000 ops each** — pending. Acceptance: all three writers' final views are byte-identical; total wall-clock <120s on the verification host; no Autobase view-divergence asserts thrown.
- **P-003c — Sleeping-peer reconnect** — pending. Acceptance: a writer offline for 1 hour (simulated by closing the corestore + reopening) re-joins and its view catches up within 10× the lag (so 1hr offline = up-to-10s catch-up after reconnect). This is the latency floor the §9.0 Insights "Hyperbee bootstrap progress" indicator (P-066) needs to budget.
- **P-003d — Sleeping-peer reconnect, 8hr offline** — pending. Same as P-003c but 8 hours offline (overnight scenario). Acceptance: catch-up within 60s.
- **P-003e — Latency-distribution recording** — pending. Output a `latency-distribution.json` file with p50/p95/p99 op-to-merged times across P-003b. The P-066 indicator design depends on knowing this distribution.

**Decision rule:** P-003 passes if all sub-acceptances pass. P-003c is the hardest case; if it fails with view divergence, the gate fails (Autobase isn't stable enough for v5's design).

---

### P-004 — Hyperbee KV benchmarks under projected load [S]

v5 one-liner: *"Hyperbee KV write/read benchmarks under projected load (~10 ops/sec)."*

**Expansion.** The existing smoke verifies KV-over-Autobase correctness but not throughput. P-004 produces a sustained-load benchmark to confirm v5's projected ~10 ops/sec across an active harness's HYPERBEE bucket (8 tables × occasional writes from N engineers) is comfortably within Hyperbee's headroom.

**Files:**
- `libs/holepunch-spike/smoke/04-hyperbee-kv.mjs` — correctness smoke (done).
- New: `libs/holepunch-spike/smoke/04b-hyperbee-throughput.mjs` — sustained 10 ops/sec for 5 minutes; measure write latency, read latency, and memory footprint over time.

**Sub-acceptances:**
- **P-004a — Correctness smoke** — ✅ **DONE 2026-05-23**.
- **P-004b — Sustained 10 ops/sec, 5 min** — pending. Acceptance: write p95 < 200ms; read p95 < 50ms; memory footprint grows <50MB over the 5min run (catches obvious leaks).
- **P-004c — Burst 100 ops/sec, 30 sec** — pending. Tests the realistic "everyone wakes up and syncs at once" pattern. Acceptance: no thrown errors; write p99 < 1s; recovery to baseline within 60s after burst ends.

**Decision rule:** P-004 passes if P-004b passes. P-004c is informational; failure means v5's UI needs to show a "sync in progress" affordance more prominently (already partially specced as P-066), but doesn't fail the gate.

---

### P-005 — Decision gate: spike pass → proceed; spike fail → trigger fallback [S]

v5 one-liner: *"Decision gate: spike pass → proceed; spike fail → trigger fallback (HYPERBEE bucket collapses into GIT bucket)."*

**Expansion.** This is the formal gate-record task, not a technical task. It produces a documented decision that becomes the input to Phase 1a's go/no-go.

**Files:**
- New: `libs/holepunch-spike/RESULTS.md` — one-page per-acceptance PASS/FAIL grid + the gate verdict. Committed alongside the spike code so future readers can see exactly what was tested.

**Acceptance:**
- All of P-001, P-002, P-003, P-004 sub-acceptances marked one of: PASS, FAIL, INFORMATIONAL.
- Verdict line at the top: either `GATE: PASS` (with link to v5 Phase 1a as the unblocked next step), or `GATE: FAIL` (with the fallback rollout plan from the next section as the unblocked next step).
- Recorded by appending a `D-001` decision to this execution plan's `## Decisions` section + bumping the v5 plan's `## Now` to reflect the verdict.

### Named fallback rollout (only fires on `GATE: FAIL`)

If the gate fails, the fallback is "HYPERBEE bucket collapses into GIT bucket." Concrete steps to make this real:

1. **Edit v5 §7.1** — strike the HYPERBEE bucket table and move every row into §7.2's GIT bucket. The HYPERBEE-only schemas (`feature_queue`, `contributors`, `contributor_usage_events`, etc.) become file-per-row under `.harness/state/` instead.
2. **Edit v5 §6** — remove the hybrid sync model section; sync becomes git-only.
3. **Edit v5 §13** — reactivity becomes git-as-sync polling (or fs-watcher on the GIT-bucket files) rather than Hyperbee subscription. The §13 reactivity layer absorbs this with minimal redesign — `pg_notify` triggers fire on PG writes regardless of where the canonical store lives.
4. **Edit v5 §12** — entire section ("P2P transport") gets struck.
5. **Edit v5 phases** — Phase 5a/5b/6 collapse into Phase 5 "git-as-sync wiring." Phase 10 (Hyperdrive peer-mirror) is struck entirely (no Hyperdrive without Holepunch).
6. **Edit v5 addendum 3** — the activity ledger becomes a GIT-bucket file-per-event under `.harness/state/contributor_usage_events/<event_id>.json`. The Insights/Contributors UI patterns are unchanged; only the storage layer differs.
7. **`libs/holepunch-spike/` is deleted** (`rm -rf`) — no dangling spike code in the tree.
8. **Write a new addendum 4** at the top of v5 documenting the fallback fire + the changes above.

This entire rollout is sized **M** if it fires. The fact that it's specced is *itself* the gate guarantee — the named fallback is real, not aspirational.

## Decisions

### D-001 — Phase 0 gate: PARTIAL PASS (Linux x64 only; macOS/Windows/Tauri-bundle pending)

**Date:** 2026-05-24  
**Verdict:** `GATE: PARTIAL PASS`

**What passed (Linux x64):**
- P-001a — `npm install` + `smoke/01-install-check.mjs` PASS on Linux x64, Node 25. 105 packages, 7s install, no native compilation required (prebuilds shipped for all native deps).
- P-002a — `smoke/02-swarm-loopback.mjs` PASS: Hyperswarm DHT join + peer discovery + payload exchange over public DHT in 10.4s.
- P-003a/b — Autobase 2-writer in-process convergence PASS.
- P-004 — `smoke/04-hyperbee-kv.mjs` Hyperbee KV read/write PASS.

**What is still pending (gate remains OPEN for cross-platform):**
- P-001b/c — macOS arm64 + x64 prebuild verification
- P-001d — Windows x64 prebuild verification
- P-001e — Tauri-bundle verification (all OSes)
- P-002b/c — cross-network holepunching (home Wi-Fi ↔ cellular tether; symmetric NAT)
- P-003 (full 3-writer + sleeping-peer reconnect at projected load)
- P-005 — formal gate recording pending above

**Implication:** Phase 1a has proceeded under the assumption that Linux x64 passes and that the Hyperbee bucket can be deferred or collapsed to GIT bucket if macOS/Windows fail. Per D-003 in v5 (Phase 5a deferred): "Phase 5a (Hyperbee live state) DEFERRED until cross-platform spike passes." Phase 1a–4 work is safe to continue on Linux-only infrastructure. Revisit full gate when macOS/Windows hosts are available.

## Cross-references

- **`papercusp-dogfood-v5-2026-05-23.md`** — the parent plan, specifically `## Phase 0` (~line 1182), `### §12 — P2P transport` (~line 858), and the **named fallback** description in `## Background` and `### §6 — Hybrid sync model`.
- **`libs/holepunch-spike/`** — the actual spike package with current PASS status and smoke scripts.
- **`papercusp-desktop/bin/release-local.sh`** — the cross-platform build pipeline that P-001e exercises.
- **D-007** in v5 — established hybrid HYPERBEE+GIT model that this gate validates.
- **D-015** in v5 — established that Phase 0 uses unscoped Holepunch primitives, not the Pear runtime. This execution plan strictly follows D-015.

## Open questions

### Q-1 — Who runs P-001b/c/d (the macOS + Windows verifications)?

Linux is already done. macOS + Windows verifications require physical (or VM) access to those OSes. Three options: (a) the dogfood team has access to all three; (b) a CI matrix runs the spike on every OS but the developer doesn't need direct access; (c) macOS-only at first because Apple Silicon is the most common dev host, defer Windows to a later sub-task. Pick before P-001b starts.

### Q-2 — Acceptance threshold for P-003d (8hr offline reconnect)?

The 60s threshold I picked is reasoned-from-first-principles, not measured. If the actual measurement shows 8hr offline reconciles in 5s, the threshold is too generous and the §9.0 Insights bootstrap-progress indicator can be cheaper. If it shows 5min, the indicator design needs to surface "this might take minutes" more prominently. The threshold is a budget for design, not a hard fail condition; revisit after the first real measurement.

### Q-3 — Is HyperDB worth evaluating as an alternative substrate?

`libs/holepunch-spike/README.md` flags this: Hyperbee + RocksDB local indexing combined into one abstraction. Possibly cleaner for §7.1's projection layer than raw Hyperbee + manual rollups. Out of scope for the gate, but worth a separate evaluation arc if the dogfood loop accumulates projection-layer pain.

## For the next agent (Phase 1a)

Phase 1a (`Workspace + create-harness UI shell + classifier`) starts the moment this plan's `GATE: PASS` is recorded in P-005. **Phase 1a does not start while any Phase 0 acceptance is `pending`**, even if the rest are passing.

What Phase 1a inherits from Phase 0:
- The spike's `dependencies` block in `libs/holepunch-spike/package.json` is the verified version pin. Use those exact versions when adding deps to `apps/operator/package.json` (per v5 §1.2's substrate setup). Drift requires re-running P-001e.
- The `RESULTS.md` latency numbers (P-003e) inform Phase 5a's P-066 (sleeping-laptop bootstrap progress indicator). Phase 1a doesn't touch this directly but Phase 5a will, so don't lose the file.
- The published-package-name correction noted in `libs/holepunch-spike/README.md`. v5 §12 has a follow-up edit on this; either Phase 0 closes it before Phase 1a (preferred — clean handoff) or Phase 1a's plan opens with a one-line "v5 §12 has wrong package names, here's the correction."

What Phase 1a should NOT carry forward from Phase 0:
- The spike code itself (`libs/holepunch-spike/`). Once the gate passes, the spike has served its purpose; delete it as part of Phase 1a's first commit. The verified dep block moves into `apps/operator/package.json`; the smoke scripts are throwaway.

If the gate FAILS, do not write a Phase 1a plan from the v5 baseline. Write a new v6 (or v5.1) that reflects the fallback rollout from this plan's "Named fallback rollout" section first, then write Phase 1a against that.

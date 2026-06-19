# Shared-Hive Release Testing — Wave 3 (briefs P–V)

**Why a wave 3.** Waves 1 (A–G) + 2 (H–N) + the integrated live witness proved the
*core* federation path and fixed/scoped the blockers (D-001 closed; A-002 GREEN;
A-003 = EI-681 send-side, owned; C-001 = re-key, owned). But that testing was almost
entirely **single-box, loopback, 2-peer (owner+joiner), over a local testnet DHT**.
A public release runs on **independent machines, behind NATs, with many members,
across version upgrades, surviving crashes, and failing OBSERVABLY.** Wave 3 attacks
exactly those untested dimensions. These are **parallel lanes** — read this index,
then your brief.

## What's already proven (do NOT re-test — build on it)
- Core federation 8/11 types bidirectional, backfill, isolation, topic-equal — live GREEN.
- D-001 convergence under skew — closed code + live. A-002 multi-hive — GREEN.
- Honesty G-001/G-002/G-003/G-004 — live GREEN. N-peer scale/churn (rig) — GREEN.
- Known-open + OWNED (don't duplicate): A-003 send-side (EI-681, d2230), C-001 re-key (Move 2, ed300+K).

## Wave-3 lanes

| Brief | Dimension | Why it's new / why it matters | Disjoint area |
|------|-----------|------------------------------|---------------|
| **P** | Cross-machine / real-WAN federation | Everything so far was 1 box + testnet DHT. Real peers are on different machines behind NATs over the PUBLIC DHT, with latency/loss/partition. | 2-machine harness / netem |
| **Q** | Live multi-member hives + membership churn | Witnesses were 2-peer owner+joiner. Real hives have 3+ members joining/leaving/rejoining under load. | composition over N live members |
| **R** | Hive lifecycle & edge cases | dissolve, leave+rejoin, ownership transfer, rename, concurrent membership ops — none witnessed. Stresses the A-003/EI-681 hive-home path. | hive-create/dissolve/leave/transfer |
| **S** | Substrate durability & crash/restart recovery | This very box restarted mid-effort + lost the fleet. What happens to federation on instance/PG/box crash mid-drain? Recovery? Partial writes? | boot/drain/corestore recovery |
| **U** | Federation silent-failure OBSERVABILITY | EI-681 sat silent ALL SESSION (outbox drained_at=NULL, harness not on topic, no signal). Does the system DETECT + SURFACE federation stalls, or fail silently? | health/metrics/alerting + deceptive-publish class |
| **V** | Re-key (Move 2) adversarial test plan | The C-001 re-key is the release critical path; it needs an adversarial test gate authored NOW, ready for when ed300/K land it. | gated on the re-key build; co-own with K |

## Rules (inherited — unchanged)
- One framework per test (Vitest / Playwright / Cargo / LLM-scenarios). **No new
  `.mjs`/bash test drivers** (CI P-038). Reuse the rigs (`_cross-peer-rig`,
  `composition-rig`, `_hive-substrate-rig`) + the live harness (`two-instance-*.sh`).
- **Teeth-verify** every new test (green → neuter invariant → RED → restore → GREEN).
- The 2-peer rigs bypass `defaultResolveSwarmBinding` — any federation brief MUST
  exercise the real joiner-resolves-own-topic path (live, or the resolver directly).
- Work on `staging`; **git-sync owns commit+push** (healthy again). `coord:*` +
  `locks:*` before deep work; declare your brief letter. **NEVER `:0`** — own Xvfb.
- Live lanes (P/Q/R/S) coordinate the live harness + display ranges (P :180+, Q :185+,
  R :190+, S :195+) via `coord:*`; the box has ~128 cores but watch load.
- Build on the **integrated fix-`.deb`** recipe (`/tmp/integrated-witness.sh`, sidecar-swap,
  no cargo) — rebuild from current staging so fixes (A-003, re-key) are included.

## Severity rubric (unchanged)
- **S0:** data loss/corruption, privacy leak, unauthorized write, non-convergence, crash/hang.
- **S1:** silently doesn't federate, revocation not enforced, recovery fails, deadlock under churn.
- **S2:** UX/honesty, slow path, recoverable-but-noisy, missing observability.

## Deliverables (every brief)
1. New tests (right framework, teeth-verified) closing the gap.
2. `findings-<X>.md` — every bug (repro + severity), gap closed, gap left open (why).
3. A release-readiness verdict for the dimension: GREEN / YELLOW / RED.
4. Fix in-scope low-risk bugs; `coord:*` + file an EI for cross-cutting ones.

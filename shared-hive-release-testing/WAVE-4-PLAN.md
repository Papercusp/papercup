# Shared-Pot Release Testing — Wave 4 (briefs W–AB)

**Why a wave 4.** Waves 1–3 + the integrated witness proved *correctness* (federation,
convergence, lifecycle), fixed the blockers (D-001 shipped live; A-002 green; A-003 +
C-001 re-key owned), and added cross-machine/scale/recovery/observability. What's still
untested is what bites a **real, public, untrusted, long-running, evolving** deployment:
**performance + leaks under sustained load, an adversary who is an admitted member,
version-skew across upgrades, correctness at the data edges, and the actual product use
case — an autonomous Mug+Cup pot federated across machines.** Wave 4 attacks those.
Parallel lanes; read this index then your brief.

## Already proven / owned (do NOT re-test)
- Core federation, convergence (D-001 LIVE+shipped), A-002, scale/churn (N/Q), crash
  recovery (S), observability detection logic (U/EI-1618), honesty (G-001/2/3/4).
- Owned + in flight: A-003 send-side (d2230), C-001 re-key Move-2 (ed300+K, V = its
  adversarial gate), cross-machine (P), lifecycle (R).

## Wave-4 lanes

| Brief | Dimension | Why it's new / why it matters | Disjoint area |
|------|-----------|------------------------------|---------------|
| **W** | Performance, throughput & resource-leak at scale | No perf/leak testing exists. Sustained high-write federation, memory/CPU/disk growth over hours, log compaction under load, big-pot backfill. The EI-126 102 GB unbounded-outbox proves this is real. | bench/k6 + soak + log-compaction |
| **X** | Adversarial security depth (untrusted peers) | C's threat-model covered admission/forged-sig/malformed-op basics. PUBLIC = an admitted member can be malicious: flood/garbage/malform at scale, DoS via pot/topic spam, DHT Sybil/eclipse, metadata/traffic-analysis privacy, invite-secret brute-force. | threat-model battery + DoS + DHT |
| **Y** | Version-skew / rolling-upgrade / migration | A deployed product updates → old peer + new peer federate (guaranteed skew). mig-314 `fed_hlc` back-compat w/ pre-314 peers; schema-migration skew; downgrade safety; re-key epoch back-compat. | two-version federation harness |
| **Z** | Data-integrity edges | Large payloads/blobs, unicode/encoding, and per-type LWW correctness: delete-vs-update, tombstone handling, **delete-resurrection** (d2230's re-key del-guard touched this), empty/null fields, requeue. | per-type op fuzz + payload edges |
| **AA** | Mug/Cup autonomous coordination over a SHARED pot | THE product use case (federated coding pot). Claims federate (B-003), but does the full Mug survey→place→Cup work→complete→federate loop work across a shared pot + machines? (B9 demo touched infra, not the autonomous loop.) | pot-loop + fleet over federation |
| **AB** | Real-world collaboration E2E journeys | The end-to-end human story: two users collaborate in a shared pot; onboarding (discover+join a public pot, contribute, see others); error-recovery UX (join fails / sync stalls — does the UI guide them?). | LLM-scenarios / Playwright + Tauri |

## Rules (inherited — unchanged)
- One framework per test (Vitest / Playwright / Cargo / LLM-scenarios; **k6/Vitest-bench**
  for W perf, nightly-only). **No new `.mjs`/bash test drivers** (CI P-038).
- **Teeth-verify** every new test. The 2-peer rigs bypass `defaultResolveSwarmBinding` —
  exercise the real joiner path for any federation claim.
- Work on `staging`; **git-sync owns commit+push** (healthy). `coord:*` + `locks:*` first;
  declare your brief. **NEVER `:0`** — own Xvfb (W :200+, X :205+, Y :210+, AA :215+, AB :220+).
- Build on the **integrated fix-`.deb`** recipe (`/tmp/integrated-witness.sh`, sidecar-swap,
  no cargo) rebuilt from current staging so A-003 / re-key / EI-1618 are included.
- Coordinate with the in-flight lanes: AA rides A-003 (membership) + the re-key; Y rides the
  re-key epoch back-compat; X overlaps C's threat-model (extend, don't duplicate).

## Severity rubric (unchanged)
- **S0:** data loss/corruption, privacy leak, unauthorized write, non-convergence, crash/hang, **resource exhaustion/OOM**.
- **S1:** silently doesn't federate, revocation not enforced, recovery fails, deadlock under churn, **memory/disk leak**, version-skew breakage.
- **S2:** UX/honesty, slow path, recoverable-but-noisy, missing observability.

## Deliverables (every brief)
1. New tests (right framework, teeth-verified) closing the gap.
2. `findings-<X>.md` — every bug (repro + severity), gap closed, gap left open (why).
3. A release-readiness verdict for the dimension: GREEN / YELLOW / RED.
4. Fix in-scope low-risk bugs; `coord:*` + file an EI for cross-cutting ones.

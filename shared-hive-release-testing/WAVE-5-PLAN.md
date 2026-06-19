# Shared-Hive Release Testing — Wave 5 (briefs AC–AG)

**Why a wave 5 (and a note on diminishing breadth).** Waves 1–4 (~26 lanes) cover the
breadth: correctness, convergence, scale, cross-machine, recovery, observability,
security depth, performance, version-skew, the autonomous product loop, E2E UX. That
breadth is now near-exhaustive. Wave 5 is deliberately **narrow + deep** on the
remaining *distinct* dimensions plus the one highest-leverage gap every prior lane
shares: each tests ONE dimension in isolation, but **the bugs that ship to production
are the INTERACTIONS** (a re-key during churn during a crash under version-skew). AE is
that lane and is the most valuable thing left to test. The rest harden the *new,
load-bearing* components (the HLC clock, workspace routing) and the *foundational
guarantee* (idempotency/replay) under conditions the happy-path lanes assume away.

## Already covered (don't re-test) — see WAVE-1..4 + the integrated witness.

## Wave-5 lanes

| Brief | Dimension | Why it's distinct / why it matters | Disjoint area |
|------|-----------|-----------------------------------|---------------|
| **AC** | Clock/time CHAOS & HLC internals | D-001 tested skew CONVERGENCE; this tests the new `fed_hlc` clock under chaos: clock running BACKWARDS (not just forward excursion), NTP step mid-federation, counter overflow/wraparound, leap second, long-drift, monotonic-vs-wall. The HLC is the S0 fix's foundation — its edge robustness is unproven. | hlc-stamp/hlc_clock internals |
| **AD** | Workspace / tenancy isolation & routing | The EI-126 102 GB blowup was a **workspace MIS-ROUTE** (writes defaulting `workspace_id` to 'default'). Test: cross-workspace hive isolation (hive in ws-A must NOT leak to ws-B), multi-workspace-per-box, the default-routing class, the ALS workspace-context (`runWithWorkspace`) under concurrency. | workspace-registry / routing / ALS |
| **AE** | Combined chaos / INTERACTION (the everything-at-once lane) | **Highest leverage.** Every lane tests one dimension; this combines them: multi-member + churn + concurrent writes + a re-key + a crash/restart + clock skew + version-skew, all in one long seeded scenario, asserting convergence + no loss/dup/leak throughout. Interaction bugs are what isolated green lanes miss. | a composed long-run chaos rig |
| **AF** | Discovery / directory mechanics in depth | The directory (announce/beacon/TTL/withdraw/re-announce) is its own layer, lightly tested. Directory consistency across peers, stale-entry handling, the invite-hive beacon-capture type bug (dc9db found), re-announce after restart, directory-at-scale (many hives). | hive-directory / beacon |
| **AG** | Idempotency / determinism / replay audit | The foundational guarantee: re-apply the same op log twice → identical state; replay from ANY cursor → converges; no double-apply, no order-dependence beyond the documented LWW. A property-based audit of the whole capture→drain→projection pipeline's idempotency. | property-based over the full pipeline |

## Rules (inherited — unchanged)
- One framework per test (Vitest / Cargo / fast-check / k6); **no new `.mjs`/bash drivers** (P-038).
- **Teeth-verify** every new test. Exercise the real joiner path for federation claims.
- Work on `staging`; **git-sync owns commit+push**. `coord:*` + `locks:*` first; declare your brief.
- **NEVER `:0`** — own Xvfb (AE :225+, AF :230+). AC/AD/AG are mostly integration/property (no live display).
- Build on the integrated fix-`.deb` (rebuilt from staging so A-003 (a′) + re-key + EI-1618 are included).
- Coordinate: AE rides everything (run it LAST, after the fixes land — it's the integration capstone);
  AC/AG can start now (the HLC + pipeline exist); AD now; AF now.

## Severity rubric (unchanged)
- **S0:** data loss/corruption, privacy/tenancy leak, unauthorized write, non-convergence, crash/hang, OOM.
- **S1:** silently doesn't federate, revocation not enforced, recovery fails, deadlock, leak, non-idempotent replay.
- **S2:** UX/honesty, slow path, recoverable-but-noisy, missing observability.

## Deliverables (every brief)
1. New tests (right framework, teeth-verified). 2. `findings-<X>.md` (bugs + repro + severity, gaps closed/open).
3. A dimension verdict GREEN/YELLOW/RED. 4. Fix in-scope low-risk bugs; `coord:*` + EI for cross-cutting.

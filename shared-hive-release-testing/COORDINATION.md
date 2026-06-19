# Shared-hive release test — live coordination log (lead-owned)

This file is maintained by the **lead (Claude)** to prevent lane collisions. Other
agents: read it, but edit your OWN `findings-<X>.md` / test files, not this file.

## Lane assignment (observed live)

| Lane | Status | Owner | Notes |
|------|--------|-------|-------|
| A live multi-peer E2E | UNSTAFFED | — | live harness currently DOWN (relaunch needed; PRE-FIX instances). |
| B data-completeness | **ACTIVE (agent)** | co-agent | created `federated-column-completeness.integration.test.ts` (04:34) — caught **B-001** below. LEAD pivoted OUT to avoid collision. |
| C security/privacy | **ACTIVE (agent)** | co-agent (+lead owns C-001) | co-agent drives `federation-threat-model.test.ts` (#4 done, #5/#2/#8 next). |
| D concurrency/convergence | **LEAD (taking)** | lead | high value, integration-based, confirmed unstaffed. |
| E lifecycle/visibility | UNSTAFFED | — | NOTE: the private-flip cut-off test will hit C-001 — file as ONE finding. |
| F resilience/recovery/scale | UNSTAFFED | — | |
| G desktop UX/honesty | UNSTAFFED | — | needs live harness (shares lock with A). |

## B-001 (S1 — silent data loss; owned by the Brief-B agent)

`harness_shared.harness_issues_consolidated.severity` is a real column that the
federation value-mapper (`feature-issue-op-keys.ts` `toIssueValue`) does NOT carry
→ a federated issue's severity lands NULL/default ('minor', migration 131) on every
peer = silent data loss for issue severity. Caught by the Brief-B agent's new
`federated-column-completeness.integration.test.ts` (currently RED on `severity`).
**Lead is NOT fixing this** (the Brief-B agent owns `feature-issue-op-keys.ts` + that
test). Brief-B agent: either carry `severity` in `toIssueValue` + the issues
projection INSERT (it IS meaningful shared data — recommend federate), or document
it `NOT_FEDERATED` with a reason. (Note: `toEngineerIssueValue` already carries
severity — the gap is the `harness_issues_consolidated` mapper specifically.)

## Active collision-avoidance rules

1. **findings-C.md is being co-edited** — lead will NOT touch it (ceded to the
   co-agent) except the **C-001 section, which the lead owns**. Co-agent: please
   leave the C-001 + GENERALIZATION sections intact; edit only your threat rows.
2. **Brief C ↔ Brief E overlap:** the read-revocation gap (C-001) and the
   private-flip cut-off (Brief E #4) are the SAME root finding. Whoever takes E,
   reference C-001 — do not file a duplicate.
3. **Live harness (lanes A/E/G):** one fixed-`.deb` pair at a time. The currently
   running instances are PRE-FIX (PG from before the 00:10 fixed `.deb`) — destroy
   + relaunch with the fixed `.deb` before any live test. Coordinate via the
   `shared-hive-live-instances` lock if the coord MCP is up.

## Key open finding (release blocker)

**C-001 (lead): no read-plane revocation.** Member-removal and public→private both
stop WRITES/DISCOVERY but NOT a prior pubkey-holder's READS (immutable identity,
unconditional replication, firewall on the wrong key space). Empirically confirmed
by a passing test. Needs a **product decision** + honest UI before public release.
Full writeup in findings-C.md.

## Release verdict (rolling) — AGGREGATED ACROSS ALL 7 LANES

**OVERALL: 🔴 NOT PRODUCTION-READY.** All 7 lanes now reporting (agents are
coordinating well — E cross-refs C-001, F/G cross-ref A-001, no collisions seen).
Multiple S0 blockers stand between here and a public release:

| Lane | Verdict | Headline |
|------|---------|----------|
| A live E2E | 🟡 (fix landed) | **A-001 (S0) — FIX APPLIED + SOUND.** Lane A added `copy_pkg_closure luxon` to `build-desktop-sidecar.sh` (04:25) — the SAME proven mechanism that already ships `rrule`. High-confidence fix. Only a clean `.deb` rebuild remains, and that's wedged purely on the cargo-lock infra (38 `npm run dev` shells), NOT on A-001. Effectively resolved pending mechanical re-verification. |
| B data-completeness | 🟢 GREEN (1 YELLOW) | B-001 (severity drop) FIXED + now guarded; `trusted_authors` correctly local (B-005); B-002 = an owner decision. |
| C security/privacy | 🟡→🔴 | **C-001 (S1/S0):** write-only revocation — removed member keeps READ. Needs product decision. |
| D concurrency | 🔴 RED | **D-001 (S0):** federated LWW DIVERGES under clock skew (HLC merge order ≠ `fed_ts` projection order). Non-convergence — peers see different state. |
| E lifecycle/visibility | 🟡→🔴 | E-R1 = C-001 at the lifecycle layer (member-remove + private-flip don't cut reads). SAME product decision as C-001. |
| F resilience/scale | 🟢 GREEN | no S0/S1 in-lane; regression guard added. |
| G desktop UX | 🟡 (blocked) | live pass BLOCKED by A-001. **G-001:** `reachablePeers` topic-blind → publish overstates reach (S2, honesty regression of the deceptive-publish class — could be S1). |

### Release blockers (must resolve before public release)

1. **A-001 (S0) — the `.deb` doesn't boot.** Highest priority: nothing else ships
   until the artifact runs. **Fix is known** (lead memory `deb-createrequire-bundling-gotcha`):
   a `createRequire(...)('pkg')` in the bundled host graph is invisible to esbuild —
   luxon must be copied into `sidecar/node_modules` (or the import de-`createRequire`d).
   → tell the Lane-A agent.
2. **D-001 (S0) — divergence under clock skew.** Unify the ordering key (HLC of
   record in the PG projection too) so merge-order and apply-order can't decouple.
3. **C-001 / E-R1 (S1, S0-potential) — write-only revocation.** ONE product decision
   covers both: does "remove member" / "make private" have to cut READ access? If
   yes → re-key/evict (real fix). If no → document loudly + honest UI.
4. **G-001 (S2→S1) — publish honesty regression.** `reachablePeers` ignores topic.

### Coordination health: GOOD
Agents cross-reference each other's findings (E↔C, F/G↔A), own distinct files, and
the shared findings-*.md edits have not collided. Lane A/E/G share the live harness
(currently DOWN/pre-fix) — A-001 blocks live work for all three until the `.deb` boots.

## ⚠ INFRA BLOCKER (lead-found) — A-001 `.deb` rebuild is STALLED

The tauri build for the A-001 fix is **stuck**: 0 `rustc`/0 `cargo` procs, 0 files
written under `release/` in 5+ min, `.deb` still 00:10 after ~20 min. Cause = the
known **cargo build-lock contention**: ~38 `npm run dev` shells + 4 debug
`papercusp-desktop` binaries are running and share `CARGO_TARGET_DIR`, so the
release `tauri build` can never acquire the lock. (Same stall the lead hit earlier
this session.)

**Lane A / whoever owns the build:** the rebuild won't finish until either (a) the
release build uses an **isolated `CARGO_TARGET_DIR`** (e.g. `/home/marsh-office/
.cargo-target-release-a001`), or (b) the contending `npm run dev` shells are
stopped first. Also worth checking WHY there are ~38 dev shells (lanes A/E/G each
spawning their own? a runaway?) — that alone is degrading the whole box under load.
Lead is NOT killing them (live lanes may need them).

## A-001 `.deb` — LEAD IS REBUILDING (resolving the stall)

The wedged tauri build died (30-min waiter timeout, no `.deb`; zombie proc gone).
The warm `/home/marsh-office/.cargo-target` lock is now FREE. The lead is producing
the A-001-verified `.deb` (`/tmp/build-a001-deb.sh`, task `b2n4otgy3`): rebuild the
sidecar (applies Lane A's `copy_pkg_closure luxon` — the current sidecar predates
the 04:25 fix), then `tauri build` in the warm dir, then verify luxon is bundled.
**Lane A: don't start a competing `.deb` build until this finishes** (cargo-lock).
Once it lands + boots, A-001 is fully closed and lanes A/E/G can run live E2E on it.

## ✅ A-001 CLOSED — bootable `.deb` produced (lead)

The lead's rebuild SUCCEEDED: a new `.deb` (05:33, 930MB) at
`/home/marsh-office/.cargo-target/release/bundle/deb/Papercusp_0.0.2_amd64.deb`
**bundles luxon (49 `sidecar/node_modules/luxon` entries)** — the
`Cannot find module 'luxon'` boot-crash is fixed end-to-end. **Lanes A/E/G: this
is your bootable artifact for the live E2E** (the create→publish→join→federate
pass). A-001 is closed on correctness + artifact; a real boot-launch is the live
lanes' to run.

_Aggregated + maintained by lead. Last update: A-001 CLOSED — bootable .deb at 05:33._

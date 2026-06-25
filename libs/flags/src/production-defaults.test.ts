/**
 * production-defaults.test.ts — the "flags default ON" acceptance guard.
 *
 * Repo rule (CLAUDE.md "Feature flags + PostHog"): **new flags DEFAULT TO
 * ENABLED — finished work never ships dark.** Default-OFF is reserved for
 * genuinely incomplete/unsafe work or an explicit owner ask.
 *
 * This test enforces that rule mechanically: every key in FLAG_DEFAULTS must
 * default `true` UNLESS it is consciously listed in KNOWN_DARK_FLAGS below.
 * Adding a new flag with default `false` trips the test — the author must
 * either ship it enabled or add it to the allowlist here with a comment
 * saying why it must ship dark. Flipping an allowlisted flag ON later trips
 * the staleness check, so the allowlist can only shrink to match reality.
 *
 * Pure unit, no env/network (same as types.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { ALL_FLAG_KEYS, FLAGS, FLAG_DEFAULTS, type FlagKey } from './types';

/**
 * The consciously-dark set, vetted against FLAG_DEFAULTS as of 2026-06-10.
 * Every entry needs a justification comment. Remove the entry when the flag
 * flips to default-ON.
 */
const KNOWN_DARK_FLAGS: ReadonlySet<FlagKey> = new Set<FlagKey>([
  // (MEMORY_WORKSPACE_SCOPED_RECALL graduated to default-ON 2026-06-25, owner-directed flip —
  // the reversible cutover kill-switch; owner attended the flip directly (live recall-hit-rate
  // is the watch, OFF reverts to global recall). Removed from KNOWN_DARK_FLAGS per the rule.)
  // (CAPABILITY_GRANT_TOOL + WORKITEM_REDUNDANCY + CAPABILITY_ENVELOPE_OVERRIDES graduated to
  // default-ON 2026-06-22 — owner ratified the owner-authority flips in-session.)
  // ── Cut-for-V1 surfaces (types.test.ts pins these off too) ─────────────
  FLAGS.CLOUDFLARE_PUBLISH, // cut for V1 — publish surface not shipping
  FLAGS.HARNESS_PHASES, // cut for V1
  FLAGS.DESIGN, // cut for V1
  FLAGS.TESTING, // cut for V1

  // ── Genuinely incomplete/unsafe work (per the FLAG_DEFAULTS comments) ──
  // (RECLAIM_STALLED graduated to default-ON 2026-06-23, owner-directed (BRIEF D) after verify — both
  // legs landed + tested: the work-item STALLED-claim reconciler leg (agent-activity-liveness-truth
  // P-003; 34 reconciler integration tests) AND the new spawned_agents WEDGED-reclaim leg (durable
  // DB-truth `reclaimWedgedSpawns`; 12 integration tests; action threshold = the already-live in-memory
  // wedge reaper's 30-min, so incremental risk is bounded). Reversible kill-switch — removed per the rule.)
  // (LAZY_SUBSTRATE_BOOT graduated to default-ON 2026-06-23, WI-596 — lazy/bounded substrate boot v1.
  // The eviction reaper tears down ONLY idle, INERT private (swarm-less, peerless) harness engines; a
  // swarmed/peered harness is pinned + never evicted, so the EI-126 fleet-divergence class is off the
  // table for v1, and an evicted engine re-boots on access. OFF = byte-identical eager boot. 1227-test
  // hyperbee suite green incl. federation/convergence/swarm-chaos; v1 wiring 37 tests. The idle-SHARED
  // eviction + swarm-presence keepalive (D-004) is the v2 follow-up under the SAME flag — removed per
  // the rule, not parked.)
  // git-sync-dx-hardening-2026-06-17 P-004: derived per-agent commit attribution rewrites
  // the git-sync COMMIT hot path. OFF = today's single `git add -A` commit (byte-identical);
  // owner flips after reviewing the flag-ON commit behavior. Safe to ship dark.
  // (SCHEDULER_MAINTAINED_READY + SCHEDULER_ISSUES_CLAIMABLE graduated to default-ON 2026-06-23, owner-
  // directed/ratified. MAINTAINED_READY: the maintained-readiness sidecar cutover (mig 379 folded into the
  // shared claim-test fixture so every claim test has the sidecar; live drift=0; flag-ON claim path 9/9).
  // ISSUES_CLAIMABLE: the owner ratified adding issues to the fleet's dispatch backlog (additive feature-miss
  // branch; issue readiness uses the inline predicate; claim tests pinned per-arm). Both reversible
  // kill-switches; finished + owner-ratified ships ON — removed per the rule.)
  // (PLAN_WORKITEM_PROMOTION + PLAN_ITEM_CLAIM_AUTO_CONVERT graduated to default-ON 2026-06-22,
  // owner-directed — the work-items-everywhere ledger's two halves were built+tested but left dark
  // (promotion dogfood-verified D-007; claim-auto-convert 48 green tests). Finished work ships ON,
  // not dark — removed from the allowlist per the rule.)
  // (COORD_OPEN_ESCALATIONS_PROJECTION graduated to default-ON 2026-06-22 — mig 355 verified applied
  // (harness_shared.coord_open_escalations exists, trigger live); owner-directed flip.)
  // NOTE: SU_BLUEPRINT_PERSONA (P-006) is now DEFAULT ON (owner-authorized 2026-06-18) — removed from
  // this allowlist after the P-008 papercup-hive su instance-override content was authored + seeded.
  // NOTE: REPLACE_CLAUDE_BASE (P-013/P-014) is now DEFAULT ON (owner-authorized 2026-06-18) — removed
  // from this allowlist; composition-tested + validated by the live e2e (a bee produced a judge-verified
  // artifact with it on) + 173 orchestrator tests.
  // watchdog-and-exposed-systems-improvement-2026-06-18 P-009: the watchdog auto-close sweep.
  // OFF = escalate-only (today's behavior, byte-identical) — auto-closing real improvement
  // items autonomously is unsafe until the owner reviews the guards. Safe to ship dark.
  // (HIVE_REKEY graduated to default-ON 2026-06-25 — shared-hive-public-release-2026-06-22 GATE-3,
  // owner ratification. The hive epoch re-key is code-complete + unit-proven (read-cut-witness +
  // crypto-impl + op-gate + boundary, 32/32) and wired end-to-end. The owner ratified the
  // security-cutover ahead of the live cross-machine K-CUT witness (WI-560, in flight on the
  // fed-a/fed-b rig). Finished + owner-ratified work ships ON, not dark — removed from the allowlist
  // per the rule.)
  // (INBOX_DURABLE_ESCALATIONS graduated to default-ON 2026-06-23, WI-594 — inbox-cards-
  // unification Phase D is IMPLEMENTED + wired end-to-end + live-verified (plan D-009 round-trip;
  // ran ON in papercusp-workspace via a stored runtime override). Finished work ships ON, not
  // dark — removed from the allowlist per the rule.)

  // plan-federation-regrain-2026-06-13 (P-005/P-006): per-PART plan federation.
  // DARK because it is an UNVERIFIED cutover — the cross-machine merge proof
  // needs two real machines (P-008) and existing plans need backfilling (P-007)
  // before the flip. With it OFF, plans federate exactly as today (whole
  // harness_plans.content blob); the per-part capture/projection are inert.
  // Pending flip surfaced in the plan's ## Now. Owner flips at cutover.
  // papercusp-self-improvement-loop Phase 3 master switch: auto-IMPLEMENTING
  // captured improvements only begins once the owner flips it (capture +
  // triage run regardless).
  // operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007): the idle-session
  // reaper ENDS adv_session rows — DARK until proven on the fleet. OFF ⇒ a no-op;
  // the routine is also seeded INACTIVE. Bring-up: --active --dry-run, then flip.
  // operator-memory-and-psu-resilience-2026-06-14 P-011 / WI-152 (D-007): the
  // reaper's WRITE half — TERMINATING a LIVE-but-idle session (Ctrl-C then
  // SIGKILL). DELIBERATE dark ship (the explicit-owner-ask exception to the
  // alpha default-on policy): a destructive, not-yet-proven reaper of live
  // processes. DOUBLE-GATED (no-op unless IDLE_SESSION_REAPER is ALSO on) and
  // busy-owner-excluding; OFF ⇒ a pure no-op. The owner flips it ON only after a
  // live --dry-run proof on the fleet — same bring-up gate as its slice-1 sibling.
  // hive-inference-gateway P-012: DELIBERATE dark ship — enabling reroutes
  // every bee's inference auth through a gateway service that must be
  // deployed first; flipping early would break the whole fleet's auth.
  // inference-gateway-multi-credential-routing-2026-06-14 P-009: DELIBERATE dark
  // ship — multi-credential per-request routing changes egress/credential
  // selection. The flip is gated on billed API keys registered in the account
  // pool + a real multi-key run (D-001). OFF = the single bound-credential
  // gateway, byte-identical to today. Pending flip surfaced in the plan's ## Now.
  // auth-tier rollout (OWNER rows): SECURITY gate, not unfinished work —
  // /auth/signup is internet-reachable via the cloudflared tunnel; open
  // signup on a single-owner box mints real accounts. The zero-users
  // bootstrap path in the route keeps fresh installs working while dark.
  FLAGS.OPEN_SIGNUP,
  // live-configurability-audit-2026-06-20 P-019: the §G auth/sandbox override umbrella. OWNER-AUTHORITY
  // (not unfinished work) — it gates an ESCALATION surface: auth:set_full_access_roles can WIDEN the
  // TESTING_FULL_ACCESS_ROLES gate-bypass set (the strongest escalation in the system). The sibling
  // dials it gates (clamp:set_safe_tools, exec_sandbox:set_policy) are tighten-only, but the cluster
  // shares one dark flag the owner flips to ratify. OFF (default) ⇒ the auth-config sync-cache stays
  // empty ⇒ every surface uses its baked literal ⇒ byte-identical. Code-complete + unit-tested; the
  // owner flips ON to enable the dials. (papercusp-testing-full-access — the env→flag kill-switch — is
  // default-ON, NOT dark: ON reproduces today's testing-phase bypass exactly.)
  FLAGS.AUTH_CONFIG_OVERRIDES,
  // (FLAGS.AUTHORITY_RPC_PROTOMUX graduated to default-ON 2026-06-23, WI-607:
  // shared-hive-hardening-2026-06-13 P-003 / D-003 — the option-(c) protomux
  // lock-authority RPC transport's contended cross-peer serialization is now
  // proven over a REAL Hyperswarm wire (authority-rpc-swarm-real-wire.test.ts: two
  // real peers / real DHT / real per-socket muxer, NOT fail-open), closing the
  // last gate. Fails open (D-004) so any residual is merge-churn-only. No longer dark.)
  // shared-hive-hardening-2026-06-13 P-016: the φ+SWIM eviction probe is wired +
  // unit/loopback-tested, but its LIVE cross-machine path rides the (also-dark)
  // protomux transport and is real-hardware-unverified (D-003, P-003 two-machine
  // proof). OFF = staleness-only authority selection, byte-identical to pre-P-016
  // + fail-open (D-004); the flip is gated on the two-machine eviction proof.
  // (FLAGS.SUBSTRATE_LOG_SNAPSHOT graduated to default-ON 2026-06-14:
  // substrate-peer-log-compaction-2026-06-13 D-008 — the real-wire 2-machine
  // Hetzner proof landed green (fresh joiner converged with contiguousLength=0
  // vs the from-start reader's full 4602 over real NAT/WAN/holepunch), clearing
  // the P-008 gate. No longer dark.)
  // (SUBSTRATE_SIDECAR graduated to default-ON 2026-06-25 — removed from KNOWN_DARK_FLAGS
  // after the packaged 2-machine fed-a/fed-b verify proved the relocated engine engages on
  // both peers; the packaged-build non-engagement bug is fixed in substrate-sidecar-spawn.ts.)
  // (WORKER_CHUNK_LOOP_BLUEPRINT graduated to default-ON 2026-06-23, owner-directed
  // flags-default-on sweep / WI-606: behavior-neutral because routing requires a SECOND
  // per-harness `workerChunkLoop` gate (default false) — the master flag no longer dark.)
  // self-learning-frontier D-001 (owner-ratified dark-ship rule): every
  // frontier LEARNING LOOP ships built + tested + DARK, arming only when the
  // plan's P-001 gate closes (consume-edges P-013 live proof + owner
  // ratification). Covers the negative-space miner (P-010/FB-04) and the
  // neologism miner (P-011/FB-05); later frontier loop flags join this block
  // under the same decision.
  // NEGATIVE_SPACE_MINER graduated to default-ON 2026-06-23 (owner-directed flags-default-on
  // sweep, plan flip-dark-flags-default-on-2026-06-23): double-gated, so flag-ON stays inert
  // until the learning governor is budgeted — flip only un-gates the SQL-only capture seams.
  // … the replay harness (P-020/FB-06) — double-gated: flag OFF here AND
  // unregistered/unbudgeted on the learning governor until the P-001 arming
  // act (registerReplayLoop with an owner-set budget).
  // … and regret mining (P-021/FB-07) — same double gate: flag OFF here AND
  // unbudgeted on the learning governor (loop `regret-mining`) until P-001.
  // … and the transfer harness (P-022/FB-08) — same double gate: flag OFF
  // here AND unbudgeted on the learning governor (loop
  // `frontier:transfer-harness`) until P-001.
  // … and the Fleet EKG (P-030/FB-10) — same double gate: flag OFF here AND
  // unbudgeted on the learning governor (loop `fleet-ekg`) until P-001.
  // … and prompt sedimentology (P-023/FB-09) — triple gate: flag OFF here,
  // unbudgeted on the learning governor (loop `prompt-ablation`), AND the
  // weekly routine seeded inactive, until P-001. Real LLM spend per cycle;
  // shadow-only (never mutates live prompts) even when armed.
  // … and deferral interest (P-042/FB-14) — same double gate: flag OFF here
  // AND unbudgeted on the learning governor (loop `deferral-interest-refit`)
  // until P-001. SQL-only zero-spend refit; the ranker feature reads any
  // already-trained model either way (degrades to zero-priced when none).
  // … and the owner preference model (P-043/FB-15) — single gate: the flag
  // IS the arming act (no routine, no governor budget — inline SQL-only
  // re-ranking in the digest read path). Dark until P-001 because it
  // re-orders the owner's live queue; interaction capture is unflagged
  // substrate so history accumulates before arming.
  // … and calibration markets (P-041/FB-13) — triple gate: flag OFF here
  // (gates the capture seams AND the resolution sweep), the routine seeded
  // INACTIVE, and unbudgeted on the learning governor (loop
  // `calibration-markets`) until P-001. SQL-only zero-spend; the ranker
  // feature contributes 0 while dark.
  // … and the Red Queen vaccination drills (P-031/FB-20) — triple gate: flag
  // OFF here (gates the drill cadence AND the out-of-band engine-death
  // sentinel), the routine seeded INACTIVE, and unbudgeted on the learning
  // governor (loop `red-queen`) until P-001. SQL-only zero-spend, but every
  // drill files an origin=drill capture (new capture volume, drill-lane
  // partitioned) — the live MTTSH proof is itself a P-001 act.
  // … and the audit-as-sensors SLO collectors (P-047/FB-21) — single gate:
  // the flag IS the arming act (no routine of their own — they ride the
  // existing improvement-watchdog tick — and no governor budget: SQL-only,
  // zero LLM spend). Dark until P-001 because a breach FILES into the
  // improvements queue: new capture volume waits for the consume-edges
  // live proof like every other frontier capture source.
  // … and the graduation evidence tracker (P-045/P-046/FB-19) — triple gate:
  // flag OFF here, the daily routine seeded INACTIVE, and unbudgeted on the
  // learning governor (loop `graduation-tracker`) until P-001. SQL-only
  // zero-spend, but it files owner ratification reports into the
  // improvements queue (new capture volume). The widening act itself (the
  // autoKinds/policy edit) is NEVER automated regardless of this flag.
  // (CAPABILITY_ENVELOPE graduated to default-ON 2026-06-23 — owner-directed arming of
  // agent-capability-confinement B-06/P-012, WI-601. The B-18 cutover + B-05 capability
  // tools shipped, so enforcement no longer strands the fleet; the only active denies are
  // the universal protected floor (secrets:*/processes:kill) + the sentinel/overwatch
  // fs-write/bash denies — caps those roles don't hold. Live-validated: the fleet ran
  // enforced for days (operator_flag_overrides) with 0 envelope-caused failures. Removed
  // from the dark allowlist per the shrink-only rule.)
  // queen-autonomy-policy-2026-06-13 B-12 (P-092): the autonomy decider ARMING GATE.
  // OFF ⇒ the decider gates EVERY item (autonomy dark, behavior-neutral, D-007); the
  // owner's P-092 act flips it ON, and even then every category ships never-auto
  // (D-005) so arming alone auto-decides nothing. The pending flip is owner-only.
  // queen-autonomy-and-selffeed-fix-2026-06-15 Phase 2: the OWNER FULL-AUTONOMY grant.
  // ON lets the Queen auto-decide the categorical residue (owner-authority / protected
  // / irreversible / graduation:*) and lifts the auto-implement loop's protected-path
  // TCB — the recursive-self-improvement boundary. DELIBERATE dark default (NOT the
  // alpha default-on policy); the owner flips it, and OFF restores today's gates.
  // (FLEET_CAPABILITY_ONLY graduated to default-ON 2026-06-23 — owner-directed arming of
  // agent-capability-confinement B-18/P-020, WI-602. Live-validated on this box: with the
  // cutover ON (operator_flag_overrides) bees+queen made hundreds of successful
  // capability:bash/edit/git/write calls over days with 0 errors — capability:* ergonomics
  // confirmed on live agents. Pairs with CAPABILITY_EXEC_SANDBOX (re-containment, still
  // dark pending bwrap-host validation — WI-608). Removed from the dark allowlist per the
  // shrink-only rule.)
  // (CAPABILITY_EXEC_SANDBOX graduated to default-ON 2026-06-23 — WI-608. Validated
  // end-to-end on a bwrap+srt-capable host: an AppArmor profile granting /usr/bin/bwrap
  // the `userns` permission (Ubuntu 24.04 apparmor_restrict_unprivileged_userns=1) makes
  // bwrap+srt sandbox. A real-exec integration test (exec-sandbox.integration.test.ts) +
  // a live :3170 capability:bash proved credential masking + cwd confinement + netns
  // egress; the run also fixed a fail-CLOSED bug (a missing ~/.config/gcloud aborted the
  // bwrap-fallback). FAIL-OPEN, so a non-bwrap host is unaffected. Removed from the dark
  // allowlist per the shrink-only rule.)
  // experiment-registry-invocation-api-2026-06-14 (#2): the dark Scout→experiment rail.
  // ON forks testable Scout proposals into DRY-RUN experiment specs (no spend, no change
  // to gym routing); the owner flips it after reviewing the mechanical proposal→arms
  // mapping (the LLM-polished candidate-overlay generation is the follow-on).
  // (SCOUT_RUBRIC_RAIL graduated to default-ON 2026-06-22 — owner-directed; drafts stay Queen-gated.)
  // overwatch-role-2026-06-15 B-10 (D-002 / D-004): the OVERWATCH autonomous
  // system-health role. DELIBERATE dark ship (NOT the alpha default-on policy) —
  // a brand-new, not-yet-proven autonomous role that nudges the live fleet; a
  // confused overwatch must not be able to thrash the system it protects, so it
  // ships dark until B-12's first live staging run proves it (coherent brief,
  // nudges-not-replaces, observes-not-ideas, no thrash, cross-monitors the Queen).
  // The owner flips it ON after that proof. Gates the role registration (B-01),
  // the wake-loop/routine (B-04), and the UI pane (B-08). Pending flip surfaced in
  // the plan's ## Now + every lane report.
  // sentinel-as-herald-2026-06-21 (mirrors OVERWATCH): the SENTINEL autonomous
  // system-health role. DELIBERATE dark ship (NOT the alpha default-on policy) —
  // a brand-new, not-yet-proven autonomous role that nudges the live fleet; a
  // confused sentinel must not be able to thrash the system it protects, so it
  // ships dark until its first live staging run proves it. The owner flips it ON
  // after that proof. Gates the role registration, the wake-loop/routine, and the
  // UI pane. Pending flip surfaced in the plan's ## Now + every lane report.
  // sentinel-as-herald-2026-06-21 Phase 5 (P-018..P-022): the SERVER-SIDE proactive
  // "decide to speak" sweep (the voice-host periodic tick that lets the Sentinel Herald
  // speak out-of-band with no desktop UI open, or route a salient alert via attention-push
  // + hindsight when no live voice session exists). DELIBERATE dark ship (mirrors SENTINEL;
  // NOT the alpha default-on policy) — a brand-new autonomous speak loop. OFF ⇒ the sweep
  // no-ops every tick (live voice + the browser-provider proactive ticks are byte-for-byte
  // unchanged); triple-gated on top of the flag (humanFacingRole==='sentinel' + not
  // DND/paused/over-budget + voice-host owns the lease). Owner flips ON after its first
  // live staging run. Pending flip surfaced in the plan's ## Now + every lane report.
  // impartial-benchmark-suite-2026-06-15 P-005 (BRIEF 3): the EXTERNAL-BENCH grader
  // adapter + the `external-bench:run` op. DELIBERATE dark ship (NOT the alpha
  // default-on policy) — the runner is genuinely incomplete (M2 in-container
  // modality unbuilt) and infra-heavy (it spins real throwaway harnesses + drives
  // the official SWE-bench Pro Docker grader with GB-scale per-instance image pulls
  // on a dedicated host). It ships dark until the ~50-task pilot (P-009) proves the
  // end-to-end path; the owner flips it ON after. Pending flip surfaced in the
  // plan's ## Now + the lane completion report.
  FLAGS.EXTERNAL_BENCH,
  // plan-implementation-framework-2026-06-15 (Wave 1 bets): ALL FOUR bets flipped default-ON
  // 2026-06-15 (owner authorization) — none remain dark. compiled-briefs + touch-set-exclusion are
  // validated by the framework bake-off running concurrently (a 'regressed' verdict auto-reverts
  // the flag off via autoRevertOnRegression / P-015).
  // (BEE_FRESH_CONTEXT_WARM_INJECT graduated to default-ON 2026-06-23 — WI-593. The Phase-1
  // fork shipped + tested (carry-seam oracle + 14 fork tests) and was live-verified (real
  // executeWake + real getFlag → channel fresh-context-warm-inject, never --resume). Fail-soft
  // to legacy `--resume`; removed from the dark allowlist per the shrink-only rule.)
  // bee-context-efficiency-2026-06-14 P-013 (D-007): the bee transcript-cap recycle BACKSTOP.
  // DEFAULT OFF + the routine is seeded INACTIVE (double-gated) — an unverified bee-lifecycle
  // change that force-recycles over-cap idle bees. OFF ⇒ a no-op (the sweep logs the over-cap
  // cohort but recycles nothing). Bring up dry-run-first, then flip after live verification.
  // (COORD_PER_WORKSPACE graduated to default-ON 2026-06-23 — owner-directed verify+flip
  // (WI-599, workspace-data-isolation-leaks F-C1). The per-workspace coordination cutover:
  // flipping the CODE DEFAULT fixes the live writes-to-'default' (log.ts boot-cached
  // coordPerWorkspaceOn fell through to the false default, D-006); migrations 361 + 391
  // re-stamp the 'default' coord history onto papercusp-workspace so inboxes/read-positions/
  // escalations don't fragment at the cutover restart. Reversible — removed per the shrink-only rule.)
  // (ISSUES_PER_WORKSPACE graduated to default-ON 2026-06-22 — owner-directed; reversible,
  // old default-partition issues preserved.)
  // (ROUTINES_PER_WORKSPACE graduated to default-ON 2026-06-23 — owner-attended cutover; migration
  // 305 additive (both ON CONFLICT targets valid, zero live collisions), reversible.)
  // workspace-data-isolation-leaks-2026-06-17 F-M7: ui:dispatch/get_state cross-workspace guard
  // (SU-only surface). DELIBERATE dark ship — reversible; OFF = today's behavior, byte-identical.
  // (WORKITEM_CLAIM_LEASE graduated to default-ON 2026-06-23 — owner-directed verify+flip (WI-597).
  // The D-008 gate waited on the recovery layer; it's now in place: the stale-claim reaper requeues
  // mid-flight items (GAP 1) + covers the issue family (GAP 2), closing the stuck-item risk
  // regardless of the lease. Mechanism verified green (lease acquire/heartbeat/expiry-steal +
  // dead-holder reclaim); single-box re-claim gates on work_items.taken_by (liveness-reclaimed),
  // NOT the lease TTL, so the self-selection no-heartbeat is benign; cross-Swarm double-claims are
  // reconcile-covered (P-005). Reversible — removed from the dark allowlist per the shrink-only rule.)
  // (SCOPED_SUPERUSER_CLAMP graduated to default-ON 2026-06-23 — owner-directed flip,
  // psu-in-desktop-builds D-002: it is the workspace boundary for a full-tool end-user psu
  // session. Reversible kill-switch; removed from the dark allowlist per the rule.)
  // (WORKSPACE_COORDINATION graduated to default-ON 2026-06-23 — owner-directed flip. Built end-to-end +
  // unit-tested: P-002 Scout + P-003 Queen Phase A/B/C + Overwatch re-key; OFF was byte-identical. The
  // per-hive→workspace re-key is a hot-path cutover, so it's watched live (brain-loop liveness) + is
  // instantly revertible via flags:set if it wedges wakes. Removed from the dark allowlist per the rule.)
  // loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5 / P-008): the engine-managed-loop
  // master gate (loop:arm — the tracked replacement for Claude /loop). DEFAULT OFF because the
  // loop engine is multi-part (B-LOOP-1 schema + B-LOOP-2 completion-rebase + B-LOOP-3 warm-wake
  // fire) and the end-to-end warm-wake round-trip is not yet verified green — arming a loop before
  // the fire lands would create a routine that never wakes. OFF ⇒ loop:arm refuses (loops_disabled);
  // the feature is otherwise inert (no loop rows exist; loop:end/loop:status are ungated). Owner
  // flips ON once the B-LOOP-1..5 chain is green + the manual warm-loop e2e passes. Pending flip
  // surfaced in the plan's ## Now + the lane completion report.
  // (TOOL_DELTA_PROTOCOL + STATE_SNAPSHOT_DELTAS graduated to default-ON 2026-06-22 — owner-directed
  // flip. TOOL_DELTA is INERT until a delta-aware client exists (WI-514 — nothing sends _meta.delta);
  // the delta-gate stays warn-only/un-armed so it doesn't block deploys. STATE_SNAPSHOT's live client
  // is the desktop's use-state-snapshots. Both reversible — removed from the dark allowlist per the rule.)
  // (SYNC_RESOURCE_DELTA graduated to default-ON 2026-06-23 — owner-directed flip. The sync RESOURCE
  // rows-delta (plans.attention/plans.list, the ~327GB/3d win); merge is done in code by the
  // SyncDeltaCodec/DeltaToolClient with a checksum→refetch-full guard, NO LLM in the path. Reversible —
  // removed from the dark allowlist per the rule.)
  // (PSU_END_USER graduated to default-ON 2026-06-23 — owner-directed flip, psu-in-desktop-builds:
  // psu verified shipping in real mac + windows builds (mac .app sidecar; windows vm-smoke 9/9 incl
  // the psu shim check). Owner ratified the end-user exposure; per D-002 the surface is the full
  // engineer profile, workspace-clamped by SCOPED_SUPERUSER_CLAMP. Removed from the dark allowlist
  // per the rule.)
  // (DOGFOOD_PAPERCUSP_HIVE_SHARE graduated to default-ON 2026-06-24 — owner-ratified after the
  // single-device smoke verified the per-owner gist identity + invite announce + signed owner-only
  // allowlist policy on a real VM (psql-confirmed). Finished work ships ON, not dark — removed per
  // the rule. 2-device data-merge remains the owner's live witness; the share step is best-effort/
  // non-fatal so a fresh launch is never broken.)
]);

/**
 * WHY each dark flag ships OFF — its ALLOWED reason, per CLAUDE.md "Feature flags + PostHog".
 * Default-OFF is permitted ONLY for one of these four cases. Crucially there is NO
 * "finished, owner flips ON after verifying" case — a finished + tested feature MUST ship ON
 * (the author verifies-then-flips IN-TASK), so that excuse is literally un-typeable here. Every
 * KNOWN_DARK_FLAGS entry must declare its case (the test below enforces 1:1 coverage).
 *   - 'incomplete'      the code does not fully work yet, or is unverified on a path that matters.
 *   - 'owner-authority' a privilege / security / destructive / autonomy surface the owner ratifies.
 *   - 'cutover'         a reversible kill-switch the owner flips after an attended live verify.
 *   - 'parked'          deliberately out of V1 scope (built-or-not, simply not shipping yet).
 */
type DarkCase = 'incomplete' | 'owner-authority' | 'cutover' | 'parked';
const DARK_FLAG_CASE: ReadonlyMap<FlagKey, DarkCase> = new Map<FlagKey, DarkCase>([
  // parked — deliberately out of V1 scope
  [FLAGS.CLOUDFLARE_PUBLISH, 'parked'],
  [FLAGS.HARNESS_PHASES, 'parked'],
  [FLAGS.DESIGN, 'parked'],
  [FLAGS.TESTING, 'parked'],
  // incomplete — not fully working / unverified on a path that matters
  // (HIVE_REKEY graduated default-ON 2026-06-25 — removed from KNOWN_DARK_FLAGS, GATE-3 owner ratification)
  // (SUBSTRATE_SIDECAR graduated default-ON 2026-06-25 — packaged 2-machine fed-a/fed-b verify; removed here)
  [FLAGS.EXTERNAL_BENCH, 'incomplete'],
  // owner-authority — privilege / security / destructive / autonomy the owner ratifies
  [FLAGS.OPEN_SIGNUP, 'owner-authority'],
  [FLAGS.AUTH_CONFIG_OVERRIDES, 'owner-authority'],
]);

/**
 * The dark allowlist must be RE-REVIEWED by this date. Past it, the review-by
 * test below goes red — forcing the team to walk every dark flag and either flip
 * the ones now ready to default-ON (remove them here) or consciously push this
 * date out with a fresh look. This is the "expiry" that stops a dark flag
 * lingering silently past the alpha default-on policy (owner ask, 2026-06-16).
 * Treat a red here as "do the review," not "bump the date" — the bump is the
 * LAST step, after flipping what's ready.
 */
const DARK_FLAGS_REVIEW_BY = '2026-07-15';

describe('production flag defaults (CLAUDE.md: new flags DEFAULT TO ENABLED)', () => {
  it('every flag defaults ON unless consciously allowlisted as dark', () => {
    const offenders = ALL_FLAG_KEYS.filter(
      (key) => FLAG_DEFAULTS[key] === false && !KNOWN_DARK_FLAGS.has(key),
    );
    expect(
      offenders,
      `New flags DEFAULT TO ENABLED — finished work never ships dark (CLAUDE.md "Feature flags + PostHog"). ` +
        `These flags default to false without being allowlisted: [${offenders.join(', ')}]. ` +
        `Either ship the flag enabled (default true in FLAG_DEFAULTS) or — only for genuinely ` +
        `incomplete/unsafe work — consciously add it to KNOWN_DARK_FLAGS in ` +
        `libs/flags/src/production-defaults.test.ts with a comment justifying the dark ship, ` +
        `and surface the pending flip in the plan's "## Now" + your completion report.`,
    ).toEqual([]);
  });

  it('the dark allowlist is not stale (every entry still defaults false)', () => {
    // When a dark flag flips ON, its allowlist entry must be removed — the
    // allowlist documents the CURRENT dark set, not a historical one.
    const stale = [...KNOWN_DARK_FLAGS].filter((key) => FLAG_DEFAULTS[key] !== false);
    expect(
      stale,
      `These KNOWN_DARK_FLAGS entries no longer default to false — remove them from the ` +
        `allowlist in libs/flags/src/production-defaults.test.ts: [${stale.join(', ')}]`,
    ).toEqual([]);
  });

  it('every allowlisted dark flag is a real registered flag key', () => {
    const known = new Set<string>(ALL_FLAG_KEYS);
    for (const key of KNOWN_DARK_FLAGS) {
      expect(known.has(key), `KNOWN_DARK_FLAGS contains unregistered key "${key}"`).toBe(true);
    }
  });

  it('the dark allowlist is not past its review-by date (no silent lingering)', () => {
    // The default-on policy only "sticks" if a dark flag can't sit forever. Past
    // DARK_FLAGS_REVIEW_BY this fails — the team re-reviews EVERY dark flag, flips
    // the ones now ready, and ONLY THEN pushes the date out for what must stay dark.
    const reviewBy = Date.parse(DARK_FLAGS_REVIEW_BY);
    expect(Number.isNaN(reviewBy), 'DARK_FLAGS_REVIEW_BY must be a valid ISO date').toBe(false);
    expect(
      Date.now() <= reviewBy,
      `The KNOWN_DARK_FLAGS allowlist is past its review-by (${DARK_FLAGS_REVIEW_BY}). ` +
        `Walk every dark flag in libs/flags/src/production-defaults.test.ts: flip the ones now ` +
        `ready to default-ON (remove them here), then push DARK_FLAGS_REVIEW_BY out with a fresh ` +
        `look. Don't just bump the date — the review is the point.`,
    ).toBe(true);
  });

  it('the dark allowlist only ever SHRINKS — agents may not reconstruct it (owner mandate 2026-06-23)', () => {
    // ANTI-RECONSTRUCTION GUARD (owner-directed, plan flip-dark-flags-default-on-2026-06-23): the
    // allowlist was being abused as a PARKING LOT — finished work left default-OFF "to be safe"
    // because flipping it on made agents uncomfortable. After the owner's flags-default-ON sweep the
    // dark set stands at the high-watermark below and may ONLY SHRINK. Adding a new dark flag FAILS
    // here: ship finished work default-ON, or — for genuinely incomplete/unsafe NEW work — graduate
    // an existing dark flag first (net-zero), or get EXPLICIT owner sign-off to raise the watermark.
    // Growth must be a deliberate, owner-visible act, never a quiet append. (Pairs with the
    // valid-reason guard below, which already bars the "finished, owner flips later" excuse.)
    const DARK_FLAGS_HIGH_WATERMARK = 22;
    expect(
      KNOWN_DARK_FLAGS.size <= DARK_FLAGS_HIGH_WATERMARK,
      `The dark allowlist GREW to ${KNOWN_DARK_FLAGS.size} (high-watermark ${DARK_FLAGS_HIGH_WATERMARK}). ` +
        `Do NOT reconstruct the parking lot: ship finished work default-ON, or graduate an existing ` +
        `dark flag to make room. Raising DARK_FLAGS_HIGH_WATERMARK needs explicit owner sign-off.`,
    ).toBe(true);
  });

  it('every dark flag declares a valid reason — closes the "finished-pending-verify" loophole', () => {
    // CLAUDE.md allows default-OFF ONLY for: incomplete | owner-authority | cutover | parked.
    // There is deliberately NO "finished, owner flips after verifying" case — a finished + tested
    // feature must ship ON (verify-then-flip in-task). Forcing every dark flag to pick a real case
    // makes that excuse un-expressible. DARK_FLAG_CASE must be 1:1 with KNOWN_DARK_FLAGS (the
    // DarkCase TYPE already rejects an invalid reason at compile time).
    const untagged = [...KNOWN_DARK_FLAGS].filter((key) => !DARK_FLAG_CASE.has(key));
    expect(
      untagged,
      `Dark flags with no DARK_FLAG_CASE reason: [${untagged.join(', ')}]. Tag each with ` +
        `'incomplete' | 'owner-authority' | 'cutover' | 'parked'. There is NO "finished, owner ` +
        `flips after verifying" case — if it's finished + tested, ship it ON (flip in-task).`,
    ).toEqual([]);
    const orphan = [...DARK_FLAG_CASE.keys()].filter((key) => !KNOWN_DARK_FLAGS.has(key));
    expect(
      orphan,
      `DARK_FLAG_CASE tags a flag no longer in KNOWN_DARK_FLAGS (drift) — remove it: [${orphan.join(', ')}]`,
    ).toEqual([]);
  });
});

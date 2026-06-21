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
  // live-configurability-audit-2026-06-20 P-008: capability:grant_role / capability:revoke_role is a
  // privilege-escalation surface D-007 assigns to OWNER-AUTHORITY — ships dark; the owner's flag
  // flip is the ratification/activation gate after reviewing the D-009 design. Safe dark: the
  // loadRoleCapabilities grant-union is flag-gated, so OFF = byte-identical capability resolution.
  FLAGS.CAPABILITY_GRANT_TOOL,
  // ── Cut-for-V1 surfaces (types.test.ts pins these off too) ─────────────
  FLAGS.CLOUDFLARE_PUBLISH, // cut for V1 — publish surface not shipping
  FLAGS.HARNESS_PHASES, // cut for V1
  FLAGS.DESIGN, // cut for V1
  FLAGS.TESTING, // cut for V1

  // ── Genuinely incomplete/unsafe work (per the FLAG_DEFAULTS comments) ──
  // git-sync-dx-hardening-2026-06-17 P-004: derived per-agent commit attribution rewrites
  // the git-sync COMMIT hot path. OFF = today's single `git add -A` commit (byte-identical);
  // owner flips after reviewing the flag-ON commit behavior. Safe to ship dark.
  FLAGS.GIT_SYNC_DERIVED_ATTRIBUTION,
  // NOTE: SU_BLUEPRINT_PERSONA (P-006) is now DEFAULT ON (owner-authorized 2026-06-18) — removed from
  // this allowlist after the P-008 papercup-hive su instance-override content was authored + seeded.
  // NOTE: REPLACE_CLAUDE_BASE (P-013/P-014) is now DEFAULT ON (owner-authorized 2026-06-18) — removed
  // from this allowlist; composition-tested + validated by the live e2e (a bee produced a judge-verified
  // artifact with it on) + 173 orchestrator tests.
  // watchdog-and-exposed-systems-improvement-2026-06-18 P-009: the watchdog auto-close sweep.
  // OFF = escalate-only (today's behavior, byte-identical) — auto-closing real improvement
  // items autonomously is unsafe until the owner reviews the guards. Safe to ship dark.
  FLAGS.WATCHDOG_AUTO_CLOSE,
  // shared-hive-rekey-2026-06-19 (C-001 read-plane revocation, S0-for-release): the hive
  // epoch RE-KEY master gate. DARK because the boundary + op-path wiring is incomplete — the
  // K-half crypto/serving/epoch/boundary/producer modules are landed + teeth-verified, but
  // advanceEpochAndWrap + encrypt-on-write + decrypt-on-read are not yet in the live op path.
  // OFF ⇒ resolveHiveEpochCrypto returns the notImplemented stub (no content encryption),
  // byte-identical to today. Owner flips ON only after the P-008 live cut-off witness passes.
  FLAGS.HIVE_REKEY,
  // inbox-cards-unification Phase D (P-031): durable-escalation mirror of
  // chat decision cards is still building; the live ctx.askUser path is
  // unchanged with this off.
  FLAGS.INBOX_DURABLE_ESCALATIONS,

  // plan-federation-regrain-2026-06-13 (P-005/P-006): per-PART plan federation.
  // DARK because it is an UNVERIFIED cutover — the cross-machine merge proof
  // needs two real machines (P-008) and existing plans need backfilling (P-007)
  // before the flip. With it OFF, plans federate exactly as today (whole
  // harness_plans.content blob); the per-part capture/projection are inert.
  // Pending flip surfaced in the plan's ## Now. Owner flips at cutover.
  FLAGS.PLAN_PART_FEDERATION,
  // papercusp-self-improvement-loop Phase 3 master switch: auto-IMPLEMENTING
  // captured improvements only begins once the owner flips it (capture +
  // triage run regardless).
  FLAGS.IMPROVEMENT_AUTO_IMPLEMENT,
  // operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007): the idle-session
  // reaper ENDS adv_session rows — DARK until proven on the fleet. OFF ⇒ a no-op;
  // the routine is also seeded INACTIVE. Bring-up: --active --dry-run, then flip.
  FLAGS.IDLE_SESSION_REAPER,
  // operator-memory-and-psu-resilience-2026-06-14 P-011 / WI-152 (D-007): the
  // reaper's WRITE half — TERMINATING a LIVE-but-idle session (Ctrl-C then
  // SIGKILL). DELIBERATE dark ship (the explicit-owner-ask exception to the
  // alpha default-on policy): a destructive, not-yet-proven reaper of live
  // processes. DOUBLE-GATED (no-op unless IDLE_SESSION_REAPER is ALSO on) and
  // busy-owner-excluding; OFF ⇒ a pure no-op. The owner flips it ON only after a
  // live --dry-run proof on the fleet — same bring-up gate as its slice-1 sibling.
  FLAGS.IDLE_SESSION_REAPER_TERMINATE,
  // hive-inference-gateway P-012: DELIBERATE dark ship — enabling reroutes
  // every bee's inference auth through a gateway service that must be
  // deployed first; flipping early would break the whole fleet's auth.
  FLAGS.INFERENCE_GATEWAY,
  // inference-gateway-multi-credential-routing-2026-06-14 P-009: DELIBERATE dark
  // ship — multi-credential per-request routing changes egress/credential
  // selection. The flip is gated on billed API keys registered in the account
  // pool + a real multi-key run (D-001). OFF = the single bound-credential
  // gateway, byte-identical to today. Pending flip surfaced in the plan's ## Now.
  FLAGS.INFERENCE_GATEWAY_MULTI_ACCOUNT,
  // auth-tier rollout (OWNER rows): SECURITY gate, not unfinished work —
  // /auth/signup is internet-reachable via the cloudflared tunnel; open
  // signup on a single-owner box mints real accounts. The zero-users
  // bootstrap path in the route keeps fresh installs working while dark.
  FLAGS.OPEN_SIGNUP,
  // shared-hive-hardening-2026-06-13 P-001 / D-005: the option-(c) Hyperswarm-mux
  // lock-authority RPC transport is wired but its cross-machine path is
  // real-hardware-unverified (P-003). OFF is byte-identical to today (HTTP-only
  // addressing) + fails open (D-004); the flip is gated on the two-machine
  // serialization proof, not unfinished code.
  FLAGS.AUTHORITY_RPC_PROTOMUX,
  // shared-hive-hardening-2026-06-13 P-016: the φ+SWIM eviction probe is wired +
  // unit/loopback-tested, but its LIVE cross-machine path rides the (also-dark)
  // protomux transport and is real-hardware-unverified (D-003, P-003 two-machine
  // proof). OFF = staleness-only authority selection, byte-identical to pre-P-016
  // + fail-open (D-004); the flip is gated on the two-machine eviction proof.
  FLAGS.AUTHORITY_EVICTION_PROBE,
  // (FLAGS.SUBSTRATE_LOG_SNAPSHOT graduated to default-ON 2026-06-14:
  // substrate-peer-log-compaction-2026-06-13 D-008 — the real-wire 2-machine
  // Hetzner proof landed green (fresh joiner converged with contiguousLength=0
  // vs the from-start reader's full 4602 over real NAT/WAN/holepunch), clearing
  // the P-008 gate. No longer dark.)
  // substrate-process-isolation-2026-06-15 P-009: dedicated sidecar for corestores/
  // Hyperswarm natives, freeing main operator from GC pauses + per-harness RSS.
  // DARK: staged on :3170 FIRST, never :3070 until integration-verified (two-peer-
  // swarm federation test + event-loop latency regression test). Phase 1: skeleton +
  // basic methods. Phase 2: socket handoff + integration tests.
  FLAGS.SUBSTRATE_SIDECAR,
  // worker-chunk-loop-operator-hosted-2026-06-14 (P-142 / D-003): the operator-
  // hosted worker:chunk-loop is the coding HOT PATH and ships dark, then
  // dark-launch → 25/50/100 cohort ramp → retire. OFF = the subprocess chunk
  // loop, unchanged. Genuinely incomplete-until-ramped per the FLAG_DEFAULTS
  // comment; flipped per-cohort as parity metrics confirm each step.
  FLAGS.WORKER_CHUNK_LOOP_BLUEPRINT,
  // self-learning-frontier D-001 (owner-ratified dark-ship rule): every
  // frontier LEARNING LOOP ships built + tested + DARK, arming only when the
  // plan's P-001 gate closes (consume-edges P-013 live proof + owner
  // ratification). Covers the negative-space miner (P-010/FB-04) and the
  // neologism miner (P-011/FB-05); later frontier loop flags join this block
  // under the same decision.
  FLAGS.NEGATIVE_SPACE_MINER,
  FLAGS.NEOLOGISM_MINER,
  // … the replay harness (P-020/FB-06) — double-gated: flag OFF here AND
  // unregistered/unbudgeted on the learning governor until the P-001 arming
  // act (registerReplayLoop with an owner-set budget).
  FLAGS.REPLAY_HARNESS,
  // … and regret mining (P-021/FB-07) — same double gate: flag OFF here AND
  // unbudgeted on the learning governor (loop `regret-mining`) until P-001.
  FLAGS.REGRET_MINING,
  // … and the transfer harness (P-022/FB-08) — same double gate: flag OFF
  // here AND unbudgeted on the learning governor (loop
  // `frontier:transfer-harness`) until P-001.
  FLAGS.TRANSFER_HARNESS,
  // … and the Fleet EKG (P-030/FB-10) — same double gate: flag OFF here AND
  // unbudgeted on the learning governor (loop `fleet-ekg`) until P-001.
  FLAGS.FLEET_EKG,
  // … and prompt sedimentology (P-023/FB-09) — triple gate: flag OFF here,
  // unbudgeted on the learning governor (loop `prompt-ablation`), AND the
  // weekly routine seeded inactive, until P-001. Real LLM spend per cycle;
  // shadow-only (never mutates live prompts) even when armed.
  FLAGS.PROMPT_ABLATION,
  // … and deferral interest (P-042/FB-14) — same double gate: flag OFF here
  // AND unbudgeted on the learning governor (loop `deferral-interest-refit`)
  // until P-001. SQL-only zero-spend refit; the ranker feature reads any
  // already-trained model either way (degrades to zero-priced when none).
  FLAGS.DEFERRAL_INTEREST,
  // … and the owner preference model (P-043/FB-15) — single gate: the flag
  // IS the arming act (no routine, no governor budget — inline SQL-only
  // re-ranking in the digest read path). Dark until P-001 because it
  // re-orders the owner's live queue; interaction capture is unflagged
  // substrate so history accumulates before arming.
  FLAGS.OWNER_PREFERENCE_RANKING,
  // … and calibration markets (P-041/FB-13) — triple gate: flag OFF here
  // (gates the capture seams AND the resolution sweep), the routine seeded
  // INACTIVE, and unbudgeted on the learning governor (loop
  // `calibration-markets`) until P-001. SQL-only zero-spend; the ranker
  // feature contributes 0 while dark.
  FLAGS.CALIBRATION_MARKETS,
  // … and the Red Queen vaccination drills (P-031/FB-20) — triple gate: flag
  // OFF here (gates the drill cadence AND the out-of-band engine-death
  // sentinel), the routine seeded INACTIVE, and unbudgeted on the learning
  // governor (loop `red-queen`) until P-001. SQL-only zero-spend, but every
  // drill files an origin=drill capture (new capture volume, drill-lane
  // partitioned) — the live MTTSH proof is itself a P-001 act.
  FLAGS.RED_QUEEN,
  // … and the audit-as-sensors SLO collectors (P-047/FB-21) — single gate:
  // the flag IS the arming act (no routine of their own — they ride the
  // existing improvement-watchdog tick — and no governor budget: SQL-only,
  // zero LLM spend). Dark until P-001 because a breach FILES into the
  // improvements queue: new capture volume waits for the consume-edges
  // live proof like every other frontier capture source.
  FLAGS.LEARNING_SLO_SENSORS,
  // … and the graduation evidence tracker (P-045/P-046/FB-19) — triple gate:
  // flag OFF here, the daily routine seeded INACTIVE, and unbudgeted on the
  // learning governor (loop `graduation-tracker`) until P-001. SQL-only
  // zero-spend, but it files owner ratification reports into the
  // improvements queue (new capture volume). The widening act itself (the
  // autoKinds/policy edit) is NEVER automated regardless of this flag.
  FLAGS.GRADUATION_TRACKER,
  // agent-capability-confinement-2026-06-13 B-06 (P-012): the per-role capability
  // envelope ENFORCEMENT at the dispatch chokepoint. DELIBERATE dark ship (NOT the
  // alpha flags-default-on policy) — enabling would DENY autonomous-fleet MCP calls
  // outside the still-initial per-role allowlist before the B-18 fleet cutover wires
  // the fleet onto the gated capability defineTools. Runs OBSERVE-ONLY (annotates
  // the ledger, never blocks) while dark; the pending flip is the B-18 act.
  FLAGS.CAPABILITY_ENVELOPE,
  // queen-autonomy-policy-2026-06-13 B-12 (P-092): the autonomy decider ARMING GATE.
  // OFF ⇒ the decider gates EVERY item (autonomy dark, behavior-neutral, D-007); the
  // owner's P-092 act flips it ON, and even then every category ships never-auto
  // (D-005) so arming alone auto-decides nothing. The pending flip is owner-only.
  FLAGS.QUEEN_AUTONOMY_ARMED,
  // queen-autonomy-and-selffeed-fix-2026-06-15 Phase 2: the OWNER FULL-AUTONOMY grant.
  // ON lets the Queen auto-decide the categorical residue (owner-authority / protected
  // / irreversible / graduation:*) and lifts the auto-implement loop's protected-path
  // TCB — the recursive-self-improvement boundary. DELIBERATE dark default (NOT the
  // alpha default-on policy); the owner flips it, and OFF restores today's gates.
  FLAGS.QUEEN_FULL_AUTONOMY,
  // agent-capability-confinement-2026-06-13 B-18 (P-020): the FLEET CUTOVER. DELIBERATE
  // dark ship (NOT the alpha default-on policy) — ON removes native write/exec tools from
  // autonomous-fleet spawns and routes them to the gated capability:* tools; flipping it
  // before capability:* ergonomics are validated on a live bee would strand the fleet.
  // P-023 makes the flip an owner act. OFF = today's allowlist, zero live-fleet change.
  FLAGS.FLEET_CAPABILITY_ONLY,
  // agent-capability-confinement-2026-06-13 B-18 (P-022 / D-008): the server-side
  // capability-exec sandbox. FAIL-OPEN (bwrap-unavailable ⇒ raw spawn), so it is safe to
  // ship, but the bwrap argv path needs end-to-end validation on a bwrap-capable host
  // (this dev box's unprivileged userns is AppArmor-restricted — bwrap can't map uids).
  // The owner arms after that validation. OFF = today's raw operator-side spawn.
  FLAGS.CAPABILITY_EXEC_SANDBOX,
  // experiment-registry-invocation-api-2026-06-14 (#2): the dark Scout→experiment rail.
  // ON forks testable Scout proposals into DRY-RUN experiment specs (no spend, no change
  // to gym routing); the owner flips it after reviewing the mechanical proposal→arms
  // mapping (the LLM-polished candidate-overlay generation is the follow-on).
  FLAGS.SCOUT_EXPERIMENT_RAIL,
  // plan-templates-and-rubric-v2-2026-06-20 P-009 (Phase 4 auto-crystallization): the
  // Scout `rubric` rail auto-authors a `template: rubric` DRAFT plan on each detected
  // rubric gap. DELIBERATE dark ship — a brand-new autonomous PLAN-WRITE behavior; the
  // gap DETECTION (P-008) is always live, only the auto-authoring is gated so the owner
  // observes gap quality before Scout starts creating drafts. Drafts are Queen-gated
  // (invisible to rubrics:list until promoted). Pending flip surfaced in the plan's ## Now.
  FLAGS.SCOUT_RUBRIC_RAIL,
  // overwatch-role-2026-06-15 B-10 (D-002 / D-004): the OVERWATCH autonomous
  // system-health role. DELIBERATE dark ship (NOT the alpha default-on policy) —
  // a brand-new, not-yet-proven autonomous role that nudges the live fleet; a
  // confused overwatch must not be able to thrash the system it protects, so it
  // ships dark until B-12's first live staging run proves it (coherent brief,
  // nudges-not-replaces, observes-not-ideas, no thrash, cross-monitors the Queen).
  // The owner flips it ON after that proof. Gates the role registration (B-01),
  // the wake-loop/routine (B-04), and the UI pane (B-08). Pending flip surfaced in
  // the plan's ## Now + every lane report.
  FLAGS.OVERWATCH,
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
  // bee-context-efficiency-2026-06-14 (sourced from its own FLAG_DEFAULTS comment): an
  // unverified HOT-PATH change to live bee re-invocation (fresh session vs `--resume`). OFF ⇒
  // legacy `--resume`, behavior-neutral; flip ON after the P-006 live verification. (Pre-existing
  // dark flag that was missing from this allowlist — added here to green the gate.)
  FLAGS.BEE_FRESH_CONTEXT_WARM_INJECT,
  // bee-context-efficiency-2026-06-14 P-013 (D-007): the bee transcript-cap recycle BACKSTOP.
  // DEFAULT OFF + the routine is seeded INACTIVE (double-gated) — an unverified bee-lifecycle
  // change that force-recycles over-cap idle bees. OFF ⇒ a no-op (the sweep logs the over-cap
  // cohort but recycles nothing). Bring up dry-run-first, then flip after live verification.
  FLAGS.BEE_TRANSCRIPT_CAP,
  // workspace-data-isolation-leaks-2026-06-17 F-C1: per-workspace coordination cutover.
  // DELIBERATE dark ship (NOT alpha default-on) — flipping it cuts the LIVE fleet's
  // coordination (messages/handoffs/escalations/plan-events) over from the shared
  // `default` partition to per-workspace partitions. Ships as a reversible kill-switch
  // the owner flips ON (OFF = today's behavior, byte-identical; old `default` history
  // preserved so OFF fully restores it). Verify on :3170 (bees receive inboxes, Queen
  // surveys, escalations route) before promoting.
  FLAGS.COORD_PER_WORKSPACE,
  // workspace-data-isolation-leaks-2026-06-17 F (owner D-001): per-workspace engineer-issues
  // cutover of the shared `default` issue bus. DELIBERATE dark ship — reversible kill-switch
  // the owner flips ON (OFF = today's behavior, byte-identical; old `default` issues preserved).
  FLAGS.ISSUES_PER_WORKSPACE,
  // workspace-data-isolation-leaks-2026-06-17 F-E1 (phase 1): routines per-workspace ON CONFLICT.
  // DELIBERATE dark ship — reversible; OFF = today's ON CONFLICT (install_slug,name), byte-identical.
  FLAGS.ROUTINES_PER_WORKSPACE,
  // workspace-data-isolation-leaks-2026-06-17 F-M7: ui:dispatch/get_state cross-workspace guard
  // (SU-only surface). DELIBERATE dark ship — reversible; OFF = today's behavior, byte-identical.
  FLAGS.UI_WORKSPACE_GUARD,
  // work-queue-stuck-item-recovery-2026-06-17 P-012 / D-008: the per-Hive authority claim LEASE,
  // migrated off the PAPERCUSP_WORKITEM_CLAIM_LEASE env gate. DEFAULT OFF — once the stale-claim
  // reaper requeues mid-flight items (GAP 1) + covers the issue family (GAP 2), the stuck-item
  // risk is closed regardless of the lease, and the lease's heartbeat is wired only into the DBOS
  // orchestrator (not the general claim tools), so flipping it ON now would add a TTL with no
  // heartbeat on the self-selection path. Owner flips ON after the recovery layer is exercised;
  // OFF = today's local SELECT … FOR UPDATE SKIP LOCKED, byte-identical.
  FLAGS.WORKITEM_CLAIM_LEASE,
  // scoped-superuser-workspace-clamp-2026-06-18: bind a psu workspace-scoped superuser
  // session to its launch workspace at the dispatch layer (engaging the existing
  // effectiveDispatchWorkspace clamp) + deny crossWorkspace tools / the harness:'all' global
  // plan escape for a scoped session. DELIBERATE dark ship — it changes auth enforcement for
  // every superuser session, so it ships as a reversible kill-switch the owner flips ON after
  // an attended :3170 verification (OFF = today's unscoped '*' superuser, byte-identical).
  FLAGS.SCOPED_SUPERUSER_CLAMP,
  // workspace-scoped-coordination-2026-06-20 (D-007): the SHARED Queen+Scout workspace-scoping
  // gate. DARK because the per-hive→workspace re-key is a multi-part hot-path change to the live
  // wake/learning loop (P-003 Queen A+B+C + P-002 Scout) not yet built end-to-end + canary'd.
  // OFF ⇒ today's per-hive brains, byte-identical. Owner flips ON post-canary.
  FLAGS.WORKSPACE_COORDINATION,
  // loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5 / P-008): the engine-managed-loop
  // master gate (loop:arm — the tracked replacement for Claude /loop). DEFAULT OFF because the
  // loop engine is multi-part (B-LOOP-1 schema + B-LOOP-2 completion-rebase + B-LOOP-3 warm-wake
  // fire) and the end-to-end warm-wake round-trip is not yet verified green — arming a loop before
  // the fire lands would create a routine that never wakes. OFF ⇒ loop:arm refuses (loops_disabled);
  // the feature is otherwise inert (no loop rows exist; loop:end/loop:status are ungated). Owner
  // flips ON once the B-LOOP-1..5 chain is green + the manual warm-loop e2e passes. Pending flip
  // surfaced in the plan's ## Now + the lane completion report.
  FLAGS.LOOPS,
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
});

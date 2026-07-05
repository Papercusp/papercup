// Single source of truth for Papercusp feature flag keys, defaults, and shape.
// Adding a flag: append here, then create the matching definition in PostHog
// (key MUST match the string literal exactly). Defaults are V1 ship-state (off).

export const FLAGS = {
  // SNAPSHOTS retired (retire-snapshots-instance-spec-2026-06-09): the harness-
  // snapshot system + the Cupboard `kind=snapshot` path are gone; the reproducible
  // clone is now the lightweight InstanceSpec (capture/boot/vary, ungated). The
  // legacy :3057 marketplace + /templates were already deleted (revive-cupboard D-004);
  // distribution lives in the (ungated) Cupboard.
  CLOUDFLARE_PUBLISH: "papercusp-cloudflare-publish",
  HARNESS_PHASES: "papercusp-harness-phases",
  DESIGN: "papercusp-design",
  // RES — the workspace-scoped Resources section (top-level nav CTA next to OPS
  // + the /res allocation board): hand account pools + local GPUs to the fleets
  // inside the workspace hive tree, each with a share %. Default ON (derived
  // FLAG_DEFAULTS — additive new surface, nothing else changes behavior when the
  // tab is hidden); flip OFF via /admin/features to pull the nav item + route.
  RES_ALLOCATION: "papercusp-res-allocation",
  // Testing-only surfaces (pi tab, add-plugin button) AND the Oracle assistant
  // (dock + Tutorial menubar button + /settings/oracle + /api/oracle/*) — the
  // separate `papercusp-oracle` key was folded into this one by owner ask
  // (2026-06-10): the Oracle is a testing surface.
  TESTING: "papercusp-testing",
  // inbox-cards-unification Phase D (P-031): when on, a chat decision card
  // (chat:ask_choice / ctx.askUser) ALSO writes a durable coord escalation so
  // the human can answer it live OR later from the inbox; either path resolves
  // the same record. Default off — the live ctx.askUser path is unchanged.
  INBOX_DURABLE_ESCALATIONS: "papercusp-inbox-durable-escalations",
  // papercusp-self-improvement-loop-2026-06-04 Phase 3 (D-004/D-006/D-008): the
  // master switch for AUTO-implementing captured improvements. When OFF (default),
  // the improvement-implement routine is a no-op — capture (Phase 1) + triage
  // (Phase 2) run, but nothing is auto-built. Flip ON only once the work_items
  // surface + the release-gate cutover have landed (the routine spawns the
  // implementer in a dedicated runner harness and lands via the release gate).
  IMPROVEMENT_AUTO_IMPLEMENT: "papercusp-improvement-auto-implement",
  // self-improvement-consume-edges-2026-06-12 P-003 (D-002): the composite
  // "learning system offline/degraded" status — meridian reachability + runner
  // spawn path + gym circuit → ONE Learning-tab chip + an owner notification on
  // the transition to offline. Infra failures escalate; they don't queue.
  LEARNING_INFRA_HEALTH: "papercusp-learning-infra-health",
  // holepunch-video-shared-harnesses-2026-06-05: gates the desktop P2P video
  // channel (the participant-grid VideoGrid). Runtime default ON (derived
  // FLAG_DEFAULTS — not in DARK_FLAGS), made DELIBERATE by
  // voice-unified-sentinel-pipeline-2026-07-01 P-011: voice/video are the
  // product surface under active completion; flip OFF via /admin/features to
  // go dark.
  VIDEO_CHANNELS: "papercusp-video-channels",
  // holepunch-voice-channels-2026-06-05 (P-015/D-014): gates the desktop P2P
  // VOICE-channel surface (VoiceChannelPanel — channel list/join/mute/meter +
  // mic capture/mix playback over the desktop voice bridge). Runtime default ON
  // (derived FLAG_DEFAULTS — not in DARK_FLAGS), made DELIBERATE by
  // voice-unified-sentinel-pipeline-2026-07-01 P-011; flip OFF via
  // /admin/features to go dark.
  VOICE_CHANNELS: "papercusp-voice-channels",
  // the-hive-lexicon-2026-06-06: selects the active brand pack for the
  // user-facing LEXICON layer. ON = the `the-hive` bee pack (Hive/Colony/Queen/
  // Bee/…); OFF = the `classic` Papercup POT pack. DEFAULT OFF as of
  // restore-pot-lexicon-public-release-2026-07-04 (owner 2026-07-04): public
  // release ships the Pot lexicon; the Swarm skin is kept but TESTING-gated
  // (in DARK_FLAGS, reachable only via the FLAGS.TESTING BrandSwitcher). Fully
  // reversible presentation switch; @papercusp/lexicon resolves it. NOTE: the
  // backend-identifier rename (hive→pot, Phase 6) is a SEPARATE change from this
  // presentation flag.
  THE_HIVE: "papercusp-the-hive",
  // blueprint-aware-harness-ui-2026-06-09 (P-008): gates the new SCHEMA-DRIVEN
  // harness settings panel (BlueprintSettingsPanel) that renders controls from the
  // harness blueprint's declared `params` (P-006), replacing the hardcoded
  // coding-pipeline form. ON (default, owner-activated 2026-06-09); OFF = the
  // legacy HarnessSettingsPanel. Reversible presentation switch; the Tauri visual
  // pass + folding in the legacy panel's residual sections (Discord/telemetry)
  // are tracked on the plan.
  BLUEPRINT_AWARE_SETTINGS: "papercusp-blueprint-aware-settings",
  // blueprint-aware-harness-ui-2026-06-09 (P-011): gates the Prompt Studio surface
  // (edit the renderSuPlaybook SOURCES — base playbooks / per-client overlays /
  // project-guide — with a live assembled-prompt preview), mounted at
  // /settings/prompt-studio. ON (default, owner-activated 2026-06-09). The
  // /api/prompt-studio/* routes are gated on this flag TOO (plus the loopback
  // guard + 512KB cap + id-whitelist from the security review).
  PROMPT_STUDIO: "papercusp-prompt-studio",
  // hive-agent-tabs-psu-tui-2026-06-09: gates the unified agent-tabs system where
  // EVERY agent surface (Queen · Bee · Sentinel · Planner) is a real psu/Claude
  // TUI session, plus the per-agent wake-mode gate, per-type color/grouping, and
  // per-frame tabs. Server-side gates only (wake delivery, roster stamping) —
  // the pui dock ships the unified shape unconditionally since P-014 retired
  // the legacy `pui chat-pane`/`pui watch-pane` surfaces (2026-06-12).
  HIVE_AGENT_TABS: "papercusp-hive-agent-tabs",
  // hive-inference-gateway-2026-06-09 (P-012): when ON, every bee spawn gets
  // ANTHROPIC_BASE_URL pointed at the localhost pacing gateway (127.0.0.1:8788), so
  // the whole fleet egresses through ONE bound account paced against the unified
  // 5h/7d utilization budget (D-009) instead of each `claude -p` bursting blind.
  // DEFAULT OFF — genuinely unsafe to enable by default: it reroutes how EVERY bee
  // authenticates and HARD-DEPENDS on the gateway service (papercup-inference-gateway)
  // running. Flip ON only AFTER the service is deployed + the 20-bee load test (P-015)
  // passes during a budget-available window. Off = unchanged (bees use their symlinked
  // ~/.claude credential directly).
  INFERENCE_GATEWAY: "papercusp-inference-gateway",
  // inference-gateway-multi-credential-routing-2026-06-14 (P-009): when ON, the
  // inference gateway routes each request to one of N registered Claude Max subscriptions by the
  // `x-papercusp-account` header (multi-credential — aggregate 5h-budget pooling / per-account IP
  // routing / cache-affinity / failover), and the spawn chokepoint assigns a cache-affinity +
  // budget-draining credential per bee. DEFAULT OFF — DELIBERATE (not the alpha default-on policy):
  // it changes credential routing/egress and needs ≥2 Max OAuth subscriptions registered + a real
  // multi-account run before the flip (D-003). OFF = the single bound-credential gateway,
  // byte-identical to today. Listed in KNOWN_DARK_FLAGS.
  INFERENCE_GATEWAY_MULTI_ACCOUNT: "papercusp-inference-gateway-multi-account",
  // agent-liveness-heartbeat-hardening-2026-06-12 P-010 (owner decision D-006):
  // auto-reap WEDGED bees — alive + supervisor-heartbeating but stream-silent
  // past WEDGE_REAP_SILENT_MS (30min; bees stream thinking deltas + tool events,
  // so true silence that long means hung-not-thinking — the generous threshold
  // absorbs long local tool calls like full test suites). Reap rides the
  // fleet:cancel engine (claims/locks released, coord notice). Checked per
  // supervisor tick; flip takes effect without a restart.
  WEDGE_AUTO_REAP: "papercusp-wedge-auto-reap",
  // claude-credential-sync-2026-06-10 (P-002): gates the operator's background
  // newest-wins reconciler that keeps the Claude OAuth bundle converged across
  // ~/.claude and every per-session CLAUDE_CONFIG_DIR fork (the fix for the
  // every-terminal-relogin rotation cascade). Checked per reconcile PASS, so a
  // flip takes effect without an operator restart. ON by default — leaving it
  // off means credential forks mutually invalidate again.
  CLAUDE_CRED_SYNC: "papercusp-claude-cred-sync",
  // auth-tier-rollout-2026-06-10 (OWNER rows review): POST /auth/signup is
  // `public` and internet-reachable via the cloudflared tunnel. The route
  // allows the FIRST account unconditionally (fresh-install bootstrap); once
  // any active user exists, further signups require this flag.
  OPEN_SIGNUP: "papercusp-open-signup",
  // hive-from-github-url-2026-06-11 (P-011/P-012): gates the picker's GitHub-URL
  // entry — paste a repo URL → create a Hive from it (clone → blueprint detect →
  // hive home + member → visibility-gated auto-publish), join the existing hive
  // when the paste-time lookup hits, or clone standalone (D-007). OFF = the
  // legacy coming-soon stub renders instead. Backend (P-006..P-010) is ungated.
  HIVE_FROM_GITHUB_URL: "papercusp-hive-from-github-url",
  // auth-tier-rollout Wave 1 (audit D-007/D-009, owner-approved 2026-06-10):
  // when ON, routes declared `auth: 'loopback'` are enforced at the dispatch
  // chokepoint — non-loopback Host → 403. OFF is the emergency revert lever
  // (routes fall back to public behavior); PAPERCUSP_ALLOW_REMOTE_ADMIN=1
  // remains the per-host deliberate remote-admin opt-out.
  ENDPOINT_AUTH_TIERS: "papercusp-endpoint-auth-tiers",
  // queen-model-tier-selection-2026-06-11 (P-005): when ON, the Queen's
  // cup:spawn `tier` picks are honored (resolved + clamped to [role floor,
  // role ceiling]). OFF = the kill-switch: a queen-supplied tier is ignored
  // and her spawns run at the role's standing default. Human/operator tier
  // and model args are honored regardless — this gates only the Queen's
  // autonomous escalation lever.
  QUEEN_TIER_SELECTION: "papercusp-queen-tier-selection",
  // EI-322 (authenticated authority RPC): when ON, POST /api/authority/rpc
  // REQUIRES a valid Ed25519-signed caller envelope (sig + freshness +
  // non-revoked device) before running a mutating lock/claim op — closing the
  // self-reported-holderPubkey hole on the cross-machine path. OFF = legacy
  // behavior (verifyIsAuthority + the EI-284 revocation gate only; unsigned
  // callers accepted). The transport ALWAYS signs, so enabling is safe on a
  // box where every peer runs current code; the flag is the cross-machine
  // rollout lever (sign everywhere → then enforce).
  AUTHORITY_RPC_SIGNED: "papercusp-authority-rpc-signed",
  // shared-hive-hardening-2026-06-13 P-001 / D-005 (owner-ratified option c):
  // route remote lock-authority RPCs over the EXISTING per-harness Hyperswarm
  // connection (a papercusp/authority-rpc protomux channel) so NAT'd desktop
  // peers — unreachable by a raw :3070 URL — are served; the connection IS the
  // address. Composes with the HTTP transport (addressable peers) and fails open
  // (D-004) when no channel/address exists. DEFAULT OFF: the cross-machine path
  // is real-hardware-unverified (P-003) — flipping it on is gated on the
  // two-machine serialization proof. OFF = byte-identical to today (HTTP-only).
  AUTHORITY_RPC_PROTOMUX: "papercusp-authority-rpc-protomux",
  // shared-hive-hardening-2026-06-13 P-016: wire the φ-accrual + SWIM failure
  // detector into authority selection so a CRASHED authority is evicted promptly
  // (relays confirm it dead over the same RPC seam) instead of waiting out the 90s
  // staleness window. When ON, boot installs the eviction monitor; selection
  // excludes a peer ONLY when a reachable relay confirms it dead (never on our own
  // blindness — single box / no transport is a no-op, fail-open preserved). DEFAULT
  // OFF (dark): the live cross-machine eviction path is real-hardware-unverified
  // (D-003, like the sibling AUTHORITY_RPC_PROTOMUX it rides) — the flip is gated
  // on the two-machine proof. OFF = staleness-only selection, byte-identical to
  // pre-P-016. Listed in KNOWN_DARK_FLAGS.
  AUTHORITY_EVICTION_PROBE: "papercusp-authority-eviction-probe",
  // substrate-peer-log-compaction-2026-06-13 (design A, D-005): when ON, boot
  // (a) seeds a fresh/reset merge cursor at each log's latest `__snapshot__` index
  // so a new joiner folds from the snapshot instead of replaying full history, and
  // (b) periodically compacts the OWN log (appends one additive snapshot op once it
  // grows past a threshold of ops since the last snapshot). DEFAULT OFF (dark): the
  // mechanism + fold-correctness are proven single-box, but the real-wire
  // replay-cost saving (Hypercore sparse-fetch from the snapshot index) and
  // cross-machine convergence are real-hardware-unverified (P-008, same D-003 gate
  // as the sibling AUTHORITY_RPC_PROTOMUX). OFF = no snapshot ops produced, cursor
  // seeds at 0 — byte-identical to today. Listed in KNOWN_DARK_FLAGS.
  SUBSTRATE_LOG_SNAPSHOT: "papercusp-substrate-log-snapshot",
  // operator-memory-and-psu-resilience-2026-06-14 P-009 (D-008): substrate
  // process isolation — dedicated sidecar for corestores/Hyperswarm natives.
  // When ON, bootAllHarnessesForActiveWorkspace spawns a sidecar process
  // (apps/operator/bin/substrate-sidecar.ts, JSON-RPC 2.0 over Unix socket)
  // and calls it over IPC instead of in-process. Main operator freed from GC
  // pauses + per-harness RSS; sidecar owns merge loops + replication.
  // DEFAULT OFF — staged on :3170 FIRST; never :3070 until integration-verified
  // (two-peer-swarm federation test + event-loop latency regression test).
  // Phase 1 (this sprint): skeleton + basic methods + IPC client.
  // Phase 2: socket handoff + integration tests. Listed in KNOWN_DARK_FLAGS.
  SUBSTRATE_SIDECAR: "papercusp-substrate-sidecar",
  // WI-2105 (shared-hive-p2p-release-readiness) REV-leg fix: persist the substrate
  // boot merge cursor's per-log positions to harness_shared.substrate_merge_cursor
  // (seed before the first fold, checkpoint persist-after-apply during it) so fold
  // progress is MONOTONIC across bg-host restarts. Without it an orphaned 70k-op
  // peer log re-folds from 0 every restart, starves routinesTick past the 240s
  // bghost-watchdog, and the watchdog restart loop means the fold never reaches
  // tail (the REV restart loop). DEFAULT ON (not dark — a correctness fix, verified
  // live on the tower sidecar). OFF = in-memory cursor only, byte-identical to the
  // pre-fix behavior (the kill-switch: reverts to full re-fold each restart).
  SUBSTRATE_MERGE_CURSOR_PG: "papercusp-substrate-merge-cursor-pg",
  // spawner-sidecar-offload-2026-06-30 WI-344 ③ — the SPAWNER sibling of
  // SUBSTRATE_SIDECAR. When ON, spawnInvokeOnceWithFallback (orchestrator-runner.ts)
  // routes the agent-spawn fork/exec + buildInvokeOnce (the ~24.5% main-loop CPU
  // that freezes routinesTick) OFF the bg-host main loop into a dedicated sidecar
  // process (apps/operator/bin/spawner-sidecar.ts, JSON-RPC 2.0 over a Unix socket,
  // mirroring the substrate sidecar). Registered enum-only — EXACTLY like its
  // SUBSTRATE_SIDECAR sibling (which is also NOT in DARK_FLAGS post the 2026-06-29
  // P-011 inversion, so it likewise DERIVES default-ON; the live OFF state is a
  // runtime `system`-scope override, the same way the substrate sidecar is staged).
  // It stays DARK in practice because spawnInvokeOnceWithFallback is INERT — nothing
  // wires it into the hot path yet (the orchestrator does that separately), so the
  // flag's default is byte-irrelevant to the running operator until it is wired +
  // verified. Adding it to DARK_FLAGS for a code-level default-OFF is intentionally
  // NOT done here: the production-defaults guards (count==9 + value-preserving
  // snapshot + owner anti-reconstruction mandate) forbid a NEW default-OFF flag.
  SPAWNER_SIDECAR: "papercusp-spawner-sidecar",
  // operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007): the idle-session
  // reaper. When ON, a periodic sweep marks DEAD-process open adv_sessions ended
  // (owner stopped heartbeating past the liveness grace), reclaiming the live
  // roster + unblocking session-dir-gc for them. DEFAULT ON (not in DARK_FLAGS —
  // proven safe on the fleet). Slice 1 only touches already-dead sessions; it
  // never terminates a live process (that's the follow-on slice, the sibling flag
  // below).
  IDLE_SESSION_REAPER: "papercusp-idle-session-reaper",
  // operator-memory-and-psu-resilience-2026-06-14 P-011 / WI-152 (D-007): the
  // idle-session reaper's WRITE half — actually TERMINATING a LIVE-but-idle
  // session (the D-007 event-loop-saturation cohort: alive + heartbeating but no
  // genuine activity for the idle threshold, holding LISTEN conns + polling).
  // DOUBLE-GATED: the terminate sweep no-ops unless BOTH this flag AND the
  // sibling IDLE_SESSION_REAPER are on. DEFAULT ON (not in DARK_FLAGS — the
  // owner's live --dry-run proof on the fleet already passed; WI-1658: this
  // flag's default was already flipped true pre-inversion, though the DESTRUCTIVE
  // description below stayed accurate and worth keeping). This is a reaper that
  // Ctrl-C's then SIGKILLs a live process. It only ever targets genuinely-idle
  // sessions (busy owners — claim / in-flight wake / running bee — are excluded);
  // a terminated wake-armed session is safe because the wake-executor --resumes
  // it. OFF ⇒ a pure no-op (the kill-switch if this ever misfires).
  IDLE_SESSION_REAPER_TERMINATE: "papercusp-idle-session-reaper-terminate",
  // agent-managed-compaction-2026-07-01 P-012 (L2 mechanical backstop): the
  // compaction-compliance watchdog's FORCE-COMPACT rung. When ON, a limit-carrying
  // session that ran PAST its soft compaction limit WITHOUT self-compacting gets
  // /compact typed into its own live psu-pty TUI (idle-gated: runs after the current
  // turn, dedup'd per crossing) — the sanctioned backstop for the 2026-07-04 incident
  // (sonnet[1m] fleet members drifted to 836k because nothing mechanical caught the
  // ones that ignored every reminder). DEFAULT ON (not in DARK_FLAGS — the owner
  // directed this fix); OFF disables ONLY this rung (seeding + estimate caching +
  // context-death detection keep running) ⇒ warn-only, byte-identical to pre-P-012.
  // The kill-switch if the force-inject ever misfires.
  COMPACTION_WATCHDOG_FORCE_COMPACT: "papercusp-compaction-watchdog-force-compact",
  // agent-managed-compaction P-013 (D-009 ambient awareness): when ON, a BANDED
  // context-usage gauge ("context: N/L (X%)", silent <65% / quiet 65-80% / loud ⚠
  // 80-90% / critical >90%) is appended to EVERY papercusp-su MCP tool RESULT (the
  // result-annotator seam) so a heads-down session that never calls a coord tool still
  // sees its usage — the surface that was missing in the 2026-07-02/07-04 blind-drift
  // incidents. DEFAULT ON (not in DARK_FLAGS — owner-proposed). The flag is read by the
  // compaction watchdog each pass into a sync in-process mirror (the annotator is on a
  // sync hot path), so a flip takes effect within one sweep (~2 min). OFF removes the
  // gauge from tool results (the coord:inbox usage line + P-015 native-tool hook are
  // unaffected) — the kill-switch if it is ever noisy.
  CONTEXT_GAUGE: "papercusp-context-gauge",
  // EI-316 (hive completion split-brain): when ON, work_items:create refuses a
  // title that embeds an existing OPEN work-item id (the "WI-118: …" mirror
  // signal) — the creator must work the given id, not fork a duplicate it then
  // completes while the original strands in `validating`. force:true overrides
  // per-call. DEFAULT ON (not in DARK_FLAGS). OFF = the kill-switch if the guard
  // ever false-positives.
  WORK_ITEM_MIRROR_GUARD: "papercusp-work-item-mirror-guard",
  // EI-309 (Queen frontier-blind wake wedge): when ON, pot:declare-wake refuses
  // an event-only/none declaration (no time component) while the home harness has
  // unplaced todo work items — forcing the Queen to place them or arm a time-wake
  // instead of sleeping on phantom self-claim. force:true overrides per-call.
  // OFF = the kill-switch if the guard ever wrongly blocks a declaration.
  HIVE_WAKE_FRONTIER_GUARD: "papercusp-hive-wake-frontier-guard",
  // learning-packs-2026-06-11 (P-005): seeding a new hive's mem0 store with the
  // selected learning pack at pot:create, plus the learning_packs:* management
  // verbs and the Learnings UI surfaces. OFF skips seeding + hides pack
  // management; the hive:<slug> memory scope itself stays live (recall of an
  // unseeded pool is harmless).
  LEARNING_PACKS: "papercusp-learning-packs",
  // per-hive-learning-loops-2026-06-14 (P-020, D-003/D-008): provisioning a
  // per-HIVE learning loop at pot:create — a DARK gym_autoloop_config row
  // (enabled:false, budget:null) + an INACTIVE scout routine under the hive's
  // own install_slug (NOT @singleton). Both ship inert: the gym tick doubly
  // refuses a disabled+unbudgeted row, and an inactive routine never fires —
  // the owner arms each via the gym/routines UI. Flag-gated + best-effort: a
  // provision failure warns and reports, never fails the create. OFF skips
  // provisioning (a hive still works; it just has no per-hive loop until armed
  // by hand). The matching pot:dissolve teardown is P-021.
  PER_HIVE_LEARNING_LOOPS: "papercusp-per-hive-learning-loops",
  // per-hive-git-and-release-gate-2026-06-29 (P-009, D-008): gates seeding the per-hive
  // staging→main green-checkpoint (+ release-trigger when a deploy target is declared) for
  // repo-backed CODING hives at create/retrofit. DEFAULT-OFF (dark): with it off, only the
  // operator-home (papercusp) release routines run — the live :3070 pipeline is untouched.
  // Flip ON after verifying the gate on one canary hive (oddsmith-hive). Effective only for
  // a hive whose releaseGate.enabled AND that actually has a repo.
  PER_HIVE_RELEASE_GATE: "papercusp-per-hive-release-gate",
  // slash-exposure-tool-catalog-2026-06-12 (P-007): gates the DYNAMIC slash
  // projection — every MCP-exposed tool a session can see surfaces as a
  // `tool:*` MCP prompt (slash command) on prompts/list, with prompts/get
  // rendering the invoke-with-elicitation instruction. Static definePrompt
  // prompts (agent:role, …) are NOT gated by this. OFF = the kill-switch if
  // a client chokes on the 400+-prompt catalog (plan D-003 risk lever).
  SLASH_EXPOSURE: "papercusp-slash-exposure",
  // self-learning-frontier-2026-06-12 (P-004 / FB-02, D-003): the
  // behavior-affecting change ledger — best-effort append-only rows on every
  // prompt/rule mutation (gym commits, prompt-override API, repo prompt-file
  // scan, future FB-09 ablations) + the system:change-ledger-scan cadence.
  // Pure record-keeping (no LLM spend, no queue filing) — Phase 0 FOUNDATION,
  // not one of the D-001 dark-shipped frontier loops: the EKG/ablation need
  // attribution history to already exist when they arm. OFF = kill-switch
  // (every writer no-ops).
  CHANGE_LEDGER: "papercusp-change-ledger",
  // self-learning-frontier-2026-06-12 (P-010 / FB-04): the negative-space
  // miner — `system:negative-space-mine` turns zero-hit docs/plans/memory
  // searches (tool_invocations) into a demand map of missing knowledge and
  // files capped kind=change candidates through the capture core. OFF until
  // the plan's P-001 arming gate closes (D-001 owner-ratified dark-ship rule
  // for frontier loops); the Learning tab demand panel reads the map either way.
  NEGATIVE_SPACE_MINER: "papercusp-negative-space-miner",
  // self-learning-frontier-2026-06-12 (P-011 / FB-05): the neologism miner —
  // `system:neologism-mine` mines coord traffic + insights for emergent
  // recurring vocabulary with no corresponding primitive (tool/table/verb)
  // and routes capped abstraction-proposal candidates into Scout's
  // improvement rail via the capture core. OFF until the plan's P-001 arming
  // gate closes (D-001 owner-ratified dark-ship rule for frontier loops).
  NEOLOGISM_MINER: "papercusp-neologism-miner",
  // self-learning-frontier-2026-06-12 (P-003 / FB-01, D-004): the learning
  // governor — ONE shared learning-spend ledger every unattended learning loop
  // registers with (sub-budget + priority). ON: learningGovernorPreflight
  // gates governor-enforced (frontier) loops — unregistered / unbudgeted /
  // exhausted ⇒ REFUSE (the gym null-budget precedent) — and the gym + scout
  // routine actions mirror their budgets/spend onto the ledger (their own
  // gates stay authoritative; zero behavior change). OFF: the preflight
  // refuses EVERYTHING with 'governor-dark' and the mirrors no-op — the
  // kill-switch.
  LEARNING_GOVERNOR: "papercusp-learning-governor",
  // operator-scalability-event-loop-2026-06-16 P5-2: kill-switch for the
  // loop-pressure concurrency governor (startLoopPressureGovernor). ON: the fleet
  // sheds effective agent concurrency when THIS box's event loop is critically
  // saturated (AIMD multiplicative-decrease), recovering as it clears. OFF: the
  // governor never starts — concurrency follows only the user's cap + 429 AIMD.
  // Safe always-on (bounded under the user's cap, self-recovering); the flag is the
  // operator's escape hatch.
  LOOP_PRESSURE_GOVERNOR: "papercusp-loop-pressure-governor",
  // backend-connection-scaling-2026-06-17 C5-1: kill-switch for the CONNECTION-pressure
  // concurrency governor (the sibling of LOOP_PRESSURE_GOVERNOR). ON: the fleet sheds
  // effective agent concurrency (same AIMD seam) when server-wide PG saturation crosses
  // the critical threshold, recovering as it falls — defense-in-depth if PgBouncer is
  // killed/bypassed or a connection storm hits, shedding BEFORE PG returns "too many
  // clients". OFF: the 30s connection-pressure tick only WARNS (today's signal-only
  // behavior). Safe always-on (only sheds at ≥90% saturation, no-op without a finite cap,
  // hysteresis + transition-debounce, self-recovering); the flag is the escape hatch.
  CONNECTION_PRESSURE_GOVERNOR: "papercusp-connection-pressure-governor",
  // infra-perf-reliability-audit-round4-2026-06-19 P-013: the perf/reliability
  // REGRESSION RIG. ON (alpha default-on): the perf-regression collector
  // (system-health/perf-regression-rig.ts) rides the existing improvement-watchdog
  // tick, snapshots the four key reliability SLO metrics (event-loop-lag p95, PG
  // connection saturation %, the dispatch-orphan rate that silently regressed to
  // 91%, and the coord open-escalation backlog) to harness_shared.perf_regression_snapshots,
  // and FILES a watchdog signal on a budget breach so the round-2/3/4 perf gains
  // can't silently regress. SQL + in-memory only, zero LLM spend; a missing
  // table/metric returns a graceful note. OFF = the collector reports a 'disabled'
  // note and emits nothing (the kill-switch). NOT dark — finished, additive,
  // read-mostly monitoring; flipping it OFF only blinds the regression watch.
  PERF_REGRESSION_RIG: "papercusp-perf-regression-rig",
  // inference-gateway-robustness-audit-2026-06-20 (gateway P2 / B-GW-4): the fleet
  // OPUS-BUDGET governor. ON (alpha default-on): as the aggregate Claude-Max 5h opus
  // utilization climbs, a spawn's NON-CRITICAL opus tier-escalation is shed back to
  // sonnet (background first, then normal), reserving 5h headroom so the fleet paces
  // UNDER the ceiling instead of blow-then-starve; `critical` opus is never downgraded
  // (paced only past near-cap). OFF: spawns run their resolved tier verbatim (today's
  // behavior). Safe always-on (only removes an opus ESCALATION, never below a role's
  // floor; self-healing as the window decays); the flag is the operator's escape hatch.
  OPUS_BUDGET_PACING: "papercusp-opus-budget-pacing",
  // agent-activity-liveness-truth-2026-06-21 P-003 (D-001/D-003/D-004): arm the
  // STALLED leg of the stale-claim reconciler. ON: reclaimStaleWorkItemClaims ALSO
  // frees a claim whose holder is ALIVE but has made no item-scoped progress within
  // the window (last_progress_at stale) — a claim is not progress (D-001) — requeuing
  // the item so the Queen/agents re-pick it. OFF (default): only DEAD-holder + the
  // confirmed-terminal-spawn legs free claims (today's behavior + the new immediate
  // spawn-death release, both safe). DARK because freeing a LIVE agent's claim
  // changes live placement on a fleet-critical hot path (D-003: land it attended).
  RECLAIM_STALLED: "papercusp-reclaim-stalled",
  // operator-memory-and-psu-resilience-2026-06-14 P-008 (WI-147, D-004/D-005/D-006):
  // lazy + bounded harness-substrate boot. ON: the operator boots a harness's heavy
  // substrate ENGINE (corestore + merge-fold + projections + merge-poll) on demand and
  // evicts idle ones via LRU (planSubstrateEviction), keeping only the N hottest resident
  // — a lightweight swarm-presence + LISTEN-substrate_outbox keepalive stays resident so an
  // evicted harness still drains its outbox + receives peer pushes (re-boot-on-NOTIFY/connection).
  // Bounds operator RSS sub-linearly in harness count (~108 MB/harness today). OFF (default):
  // boot is byte-identical to today (eager all-harness boot). DARK + STAGED-ON-:3170-FIRST
  // because a wrong eviction silently stops a harness syncing → fleet data divergence (the
  // EI-126 102 GB class) — D-005/D-006 binding execution constraint.
  LAZY_SUBSTRATE_BOOT: "papercusp-lazy-substrate-boot",
  // self-learning-frontier-2026-06-12 (P-020 / FB-06): the replay harness —
  // re-run an agent from a historical transcript point (or synthetic context)
  // under a modified prompt/policy and judge the divergence; the substrate for
  // regret mining / transfer / shadow ablation (P-021..023). OFF until the
  // plan's P-001 arming gate closes (D-001 owner-ratified dark-ship rule):
  // replayPreflight refuses with 'replay-dark', so no unattended replay can
  // spend. Double-gated — the loop also ships unregistered/unbudgeted on the
  // learning governor until the P-001 arming act.
  REPLAY_HARNESS: "papercusp-replay-harness",
  // experiment-registry-invocation-api-2026-06-14 (#2, "close the loop"): the dark
  // Scout→experiment rail. ON ⇒ each testable (gym-rail) Scout proposal is ADDITIVELY
  // expressed as a DRY-RUN experiment spec (no spend, no change to gym routing); OFF ⇒
  // Scout unchanged. D-001 dark-ship rule; double-gated — experiment:run also rides
  // papercusp-replay-harness + the governor before anything could spend.
  SCOUT_EXPERIMENT_RAIL: "papercusp-scout-experiment-rail",
  // plan-templates-and-rubric-v2-2026-06-20 (P-009, Phase 4 auto-crystallization):
  // the Scout `rubric` rail. ON ⇒ on a detected RUBRIC GAP (corpus-digest rubricGaps,
  // P-008) Scout AUTHORS a `template: rubric` DRAFT plan → the existing queen↔scout
  // loop ratifies it into an active rubric; OFF ⇒ the gap is detected (visible in the
  // digest) but no draft is auto-authored. DARK by default — a brand-new autonomous
  // PLAN-WRITE behavior; the owner flips it after observing gap quality. Idempotent
  // (one stable slug/gap) + best-effort (never disturbs the cycle); drafts are
  // Queen-gated (invisible to rubrics:list until promoted active+templateData).
  SCOUT_RUBRIC_RAIL: "papercusp-scout-rubric-rail",
  // self-learning-frontier-2026-06-12 (P-021 / FB-07): regret mining —
  // `system:regret-mine` selects bad historical sessions (token-burn
  // percentile, validator bounces, rescue markers), locates the divergence
  // turn in the persisted transcript, and — once the FB-06 replay harness
  // lands — counterfactually replays candidate rule changes from that turn,
  // filing scored what-would-have-helped reports origin=replay through the
  // capture core. OFF until the plan's P-001 arming gate closes (D-001
  // owner-ratified dark-ship rule for frontier loops).
  REGRET_MINING: "papercusp-regret-mining",
  // self-learning-frontier-2026-06-12 (P-022 / FB-08, D-006): the transfer
  // harness — `system:transfer-distill` distills candidate lessons from the
  // day's transcripts, admits them FREE at memory tier 'probationary'
  // (admission is never gated — the same-turn insight rule is untouched), and
  // promotes a lesson to 'validated' only when a fresh student agent with it
  // beats one without it on the source historical task (replayed via
  // lib/replay, judged by the frozen eval-battery). Repeated failures retire
  // (forget) the lesson; learning-pack candidate adoption inherits the bar.
  // OFF until the plan's P-001 arming gate closes (D-001 owner-ratified
  // dark-ship rule for frontier loops).
  TRANSFER_HARNESS: "papercusp-transfer-harness",
  // self-learning-frontier-2026-06-12 (P-030 / FB-10): the Fleet EKG —
  // `system:fleet-ekg-scan` embeds agent sessions (agent_activity) into
  // behavioral feature vectors (tool mix/bigrams, pacing, retry rhythm — no
  // LLM), detects fleet-wide distribution shifts against the trailing
  // baseline, attributes them to the behavior-change ledger (D-003), and
  // alarms the attention rail on unattributable MAJOR shifts. OFF until the
  // plan's P-001 arming gate closes (D-001 owner-ratified dark-ship rule for
  // frontier loops); the Learning tab EKG panel reads stored shifts either way.
  FLEET_EKG: "papercusp-fleet-ekg",
  // self-learning-frontier-2026-06-12 (P-023 / FB-09): prompt sedimentology —
  // `system:prompt-ablation`, the weekly SHADOW ablation of one SU-playbook
  // governance rule via the llm-testing su target (a snapshot-baseline arm vs
  // an ablated arm; live prompts are NEVER mutated by this lane). Dead-weight
  // evidence accumulates in harness_shared.prompt_ablation_runs for owner
  // review. Spends real LLM tokens per cycle, so it is governor-preflighted
  // (loop `prompt-ablation`). OFF until the plan's P-001 arming gate closes
  // (D-001 owner-ratified dark-ship rule for frontier loops).
  PROMPT_ABLATION: "papercusp-prompt-ablation",
  // self-learning-frontier-2026-06-12 (P-042 / FB-14, D-006): deferral
  // interest — `system:deferral-interest-refit` backfills realized deferral
  // costs from history (human-lane items → downstream blockage accrued while
  // each sat deferred) and fits the learned pricing model the one queue
  // ranker (P-040 / FB-12) reads as its deferral-interest feature. SQL-only,
  // zero LLM spend. OFF until the plan's P-001 arming gate closes (D-001
  // owner-ratified dark-ship rule for frontier loops); the ranker feature
  // degrades to zero-priced while no model is trained.
  DEFERRAL_INTEREST: "papercusp-deferral-interest",
  // self-learning-frontier-2026-06-12 (P-043 / FB-15): the owner preference
  // model — implicit owner-attention telemetry (owner grades/regrades,
  // queue-view exposure) scored as a bounded re-ranking feature of the one
  // queue ranker (P-040 / FB-12). SQL-only, zero LLM spend; re-ranking only,
  // explicit grades stay sovereign. OFF until the plan's P-001 arming gate
  // closes (D-001 owner-ratified dark-ship rule for frontier loops); the
  // interaction CAPTURE seams are unflagged substrate (FB-02/FB-03 call) so
  // history accumulates before arming.
  OWNER_PREFERENCE_RANKING: "papercusp-owner-preference-ranking",
  // self-learning-frontier-2026-06-12 (P-041 / FB-13): calibration markets —
  // cheap recorded claims at natural moments (improvements:resolve confidence,
  // plan starts, flake filings), matured by `system:calibration-resolve` and
  // Brier-scored per persona per domain; consumed as a feature of the one
  // queue ranker (P-040 / FB-12, D-005) and by Queen-weighting reads
  // (calibration:summary). SQL-only, zero LLM spend. OFF gates BOTH the
  // capture seams and the sweep until the plan's P-001 arming gate closes
  // (D-001 owner-ratified dark-ship rule for frontier loops); the ranker
  // feature contributes 0 while OFF or while no bets are scored.
  CALIBRATION_MARKETS: "papercusp-calibration-markets",
  // relight-self-learning-edges-2026-06-14 (P-033): the `memory-precision`
  // learning singleton — a WEEKLY bench that replays the frozen gold set against
  // the production hybrid backend AT THE PUSH FLOOR and records FP@5 / R@10 /
  // precision to harness_shared.memory_precision_bench, so the Learning tab
  // MONITORS the injection floor (solved/optimal, D-007) instead of trusting a
  // one-time benchmark. Flag-only (no governor, like change-ledger): cheap
  // (~$0.05 embeddings/run, no LLM); ON by default so the monitoring panel has
  // data. OFF cuts the bench (and the precision chips degrade to "—").
  MEMORY_PRECISION_BENCH: "papercusp-memory-precision-bench",
  // data-scoping-audit-2026-06-22 P-006 / D-004 / D-012: workspace-scope the memory RECALL
  // user-pool (drop cross-workspace `project` hits; keep owner-tier user/feedback/reference
  // + legacy NULL-workspace rows). Dark CUTOVER — the flip is the attended live recall-
  // hit-rate verify. Rides migration 398's generated workspace_id column.
  MEMORY_WORKSPACE_SCOPED_RECALL: "papercusp-memory-workspace-scoped-recall",
  // self-learning-frontier-2026-06-12 (P-031 / FB-20): Red Queen vaccination —
  // `system:red-queen-drill` plants origin=drill synthetic frictions in the
  // SANDBOX workspace ('red-queen-sandbox'), detects them with a real watchdog
  // tick, routes them through the real triage path (drill-opted-in), heals
  // them with the class's known remedy, and records MTTSH + a per-run
  // zero-leak assertion (lib/red-queen). SQL-only, zero LLM spend. The same
  // flag gates the out-of-band routine-engine-death sentinel (a plain
  // interval in host-bootstrap — the 06-12 DBOS incident class). OFF until
  // the plan's P-001 arming gate closes (D-001 owner-ratified dark-ship rule
  // for frontier loops).
  RED_QUEEN: "papercusp-red-queen",
  // self-learning-frontier-2026-06-12 (P-047 / FB-21): audit-as-sensors — five
  // learning-system SLO collectors riding the existing improvement-watchdog
  // tick (triage-distribution entropy, capture-vs-consume flow imbalance,
  // MTTSH regression, governor budget starvation, memory recall zero-hit
  // spike). SQL-only, zero LLM spend, no routine of its own — but a breach
  // FILES into the improvements queue, so it ships dark until the plan's
  // P-001 arming gate closes (D-001: no new capture volume into a drain
  // still being repaired). OFF = every collector reports a 'dark' note and
  // emits nothing.
  LEARNING_SLO_SENSORS: "papercusp-learning-slo-sensors",
  // self-learning-frontier-2026-06-12 (P-045/P-046 / FB-19): the graduation
  // evidence tracker — `system:graduation-scan` counts per-class clean
  // auto-implement passes over the existing outcome rails (resolve evidence,
  // decay verification, dispatch ledger, gym/EKG regressions) and files a
  // "class X is graduation-eligible" OWNER report when a class crosses the
  // threshold. It NEVER edits autoKinds — widening stays a reviewed policy.ts
  // config change riding the release gate (D-008). SQL-only, zero LLM spend,
  // but it FILES into the improvements queue, so it ships dark until the
  // plan's P-001 arming gate closes (D-001).
  GRADUATION_TRACKER: "papercusp-graduation-tracker",
  // queen-autonomous-execution-2026-06-13 B-10 (P-041/P-045): card interception
  // for the Queen hive loop. When ON, a fleet AGENT's (bee / signed-spawn) blocking
  // chat:ask_choice / ctx.askUser is intercepted — routed through the agent-question
  // gate as a durable, routable escalation (category=agent-question, owner-Queue by
  // default; autonomy-policy's classifier injects the rung) instead of a frozen card
  // no human is watching, and the card gets a bounded timeout that degrades to
  // {action:'cancel'} so the bee never spins forever. ON by default (behavior-neutral
  // throughput improvement, D-007): interactive callers (human/operator) are untouched.
  QUEEN_CARD_INTERCEPTION: "papercusp-queen-card-interception",
  // agent-capability-confinement-2026-06-13 B-06 (P-012): ENFORCEMENT of the per-role
  // capability envelope at the dispatch chokepoint. OFF by default — DELIBERATE (not the
  // alpha flags-default-on policy): enabling it would DENY autonomous-fleet MCP tool calls
  // outside the (still-initial) per-role allowlist before the B-18 fleet cutover wires the
  // fleet onto the gated capability defineTools (B-05). When OFF the envelope runs in
  // OBSERVE-ONLY/shadow mode — it evaluates + annotates the ledger posture ('gated' =
  // would-deny) but never blocks — giving B-18 real arming data safely. SU / power-user /
  // non-fleet callers are exempt regardless (D-002). Surfaced loudly in the plan ## Now +
  // the completion report as the pending B-18 flip.
  CAPABILITY_ENVELOPE: "papercusp-capability-envelope",
  // live-configurability-audit-2026-06-20 P-008 — runtime role→capability grant tool
  // (capability:grant_role / capability:revoke_role). DARK by default (owner-authority, D-007):
  // it flag-gates both the loadRoleCapabilities grant-union AND the grant/revoke tools.
  CAPABILITY_GRANT_TOOL: "papercusp-capability-grant-tool",
  // live-configurability-audit-2026-06-20 P-007 — BOINC work-item redundancy master switch
  // (migrated off the PAPERCUSP_WORKITEM_REDUNDANCY env gate). DARK (N× model spend); SYNC-cached
  // because the claim-path read is synchronous (the WORKITEM_CLAIM_LEASE migration pattern).
  WORKITEM_REDUNDANCY: "papercusp-workitem-redundancy",
  // live-configurability-audit-2026-06-20 P-009 — runtime per-role capability-envelope
  // overrides (capability_envelope:set_role / :set_protected). DARK: when ON the D-010
  // sync-cache merges per-role deny/allow overrides OVER the baked ROLE_ENVELOPES and unions
  // tighten-only protected-floor additions, at the dispatch checkCapabilityEnvelope step.
  // OFF (default) ⇒ the sync-cache stays empty ⇒ byte-identical. (Also needs CAPABILITY_ENVELOPE
  // ON for the envelope to actually bite — this flag only governs whether overrides apply.)
  CAPABILITY_ENVELOPE_OVERRIDES: "papercusp-capability-envelope-overrides",
  // live-configurability-audit-2026-06-20 P-020 — runtime dispatch telemetry-buffer config
  // (telemetry:set_buffer: maxPending / debounceMs / maxBatch). Default-ON kill-switch: the
  // override store is empty by default ⇒ baked defaults ⇒ byte-identical; flip OFF to ignore any
  // stored override and force the baked defaults. Operational (not auth/spend), so not dark.
  TELEMETRY_BUFFER_CONFIG: "papercusp-telemetry-buffer-config",
  // live-configurability-audit-2026-06-20 P-020 — runtime per-workspace txn lock_timeout/statement_timeout
  // (db:txn-timeouts) applied by inWorkspaceTxn via the @papercusp/locks getTxnTimeouts seam. Default-ON
  // kill-switch: the override store is empty by default ⇒ baked 5s/5s ⇒ byte-identical; flip OFF to ignore
  // any stored override and force the defaults. Operational (not auth/spend), so not dark.
  TXN_TIMEOUTS_CONFIG: "papercusp-txn-timeouts-config",
  // live-configurability-audit-2026-06-20 P-019 — the §G AUTH/SANDBOX runtime-override umbrella.
  // DARK (owner-authority): when ON, the operator_auth_config store's overrides apply —
  // auth:set_full_access_roles REPLACES the baked TESTING_FULL_ACCESS_ROLES bypass set (the strongest
  // escalation in the system, so the override is gated here), clamp:set_safe_tools NARROWS the
  // scoped-SU cross-workspace allowlist (tighten-only), and exec_sandbox:set_policy ADDS sandbox mask
  // dirs / forces deny-all-egress (tighten-only). It ALSO gates capability_tier:set (P-010) — a
  // runtime capability→tier override consulted by papercuspTierFor before the baked table. OFF
  // (default) ⇒ every §G sync-cache stays empty ⇒ every surface uses its baked literal ⇒
  // byte-identical. The owner flips this ON to ratify the §G auth-config dials.
  AUTH_CONFIG_OVERRIDES: "papercusp-auth-config-overrides",
  // live-configurability-audit-2026-06-20 P-019 — the testing-phase full-access master switch, the
  // env→flag conversion of the PAPERCUSP_TESTING_FULL_ACCESS_ROLES=off kill-switch (gate-bypass.ts).
  // Default-ON = the testing-phase role+capability bypass (operator/queen/bee/overwatch/sentinel/scout)
  // stays enabled exactly as today; flip OFF to globally DISABLE testing-full-access (least-privilege).
  // Not dark — ON reproduces current behaviour; this is just the kill-switch as a runtime flag.
  TESTING_FULL_ACCESS: "papercusp-testing-full-access",
  // agent-capability-confinement-2026-06-13 B-06 (P-011) ⨯ queen-autonomy-policy D-012/P-110:
  // the Queen decision-ledger ACTION-CHOKEPOINT emit — one append-only row per governed
  // (tier != 'low') action by a non-SU principal, from the dispatch postInvoke seam. ON by
  // default: pure additive record-keeping, no LLM spend, a subset of tool_invocations — the
  // same Phase-0-foundation call as CHANGE_LEDGER (rows must accumulate before queen-autonomy
  // B-13's surface + the autonomy gate consume them). OFF is the kill-switch (the emit no-ops).
  DECISION_LEDGER: "papercusp-decision-ledger",
  // queue-authorization-redesign-2026-06-14 (P-004/P-006): the Queue UI redesign —
  // group the pending queue by AUTHORIZER ("Needs your call" vs "Automatable — for
  // now") instead of urgency tiers, surface the per-card why-it's-here line +
  // category badge, and add the "Queen's log" segmented tab. ON by default (alpha
  // flags-default-on): pure presentation over the already-computed whyGated/authorizer
  // fields + the existing decision.ledger read; no new writes. OFF = the prior
  // tier-grouped queue (safe rollback).
  QUEUE_AUTHORIZATION_VIEW: "papercusp-queue-authorization-view",
  // queen-autonomous-execution-2026-06-13 B-09 (P-020/P-021/P-022): the placement
  // completion watchdog for the Queen hive loop. When ON, the 30s routinesTick
  // reconciles each Queen-placed unit (hive_placements, mig 263) against live bee
  // state (hive_placements, mig 263): a non-terminal placed unit whose serving bee
  // died/stalled and is not re-claimed fires ONE recovery wake to the Queen (P-020); after N
  // failed placements the unit flips `cursed` and is escalated to the owner
  // instead of re-placed forever (P-021); a stuck `failing`/`failed` blocker
  // gating downstream work is escalated once (P-022). Behavior-neutral throughput
  // (D-007): the sweep only acts on STARTED hives, and the hive is owner-gated.
  // OFF = the kill-switch (the sweep returns immediately).
  HIVE_PLACEMENT_WATCHDOG: "papercusp-hive-placement-watchdog",
  // queen-autonomy-policy-2026-06-13 B-12 (P-070/P-092): the ARMING GATE for the
  // Queen autonomy decider (lib/autonomy/decider.ts). When OFF the decider returns
  // `gated` for EVERY queue item — autonomy is dark, behavior identical to today
  // (D-007). When ON the D-004 gating function applies, but every category still
  // ships at `never-auto` (D-007), so nothing auto-decides until the owner ALSO
  // lowers a per-category ceiling and a class graduates within it (D-005). OFF by
  // default — DELIBERATE, NOT the alpha flags-default-on policy: flipping it is the
  // owner's P-092 arming act, gated on B-19's behavior-neutral proof + the frontier
  // consume-edges live proof. The decider's default deps fail-DARK on a flag-IO
  // error so a hiccup can never arm autonomy. Surfaced loudly as the pending P-092 flip.
  QUEEN_AUTONOMY_ARMED: "papercusp-queen-autonomy-armed",
  // queen-autonomy-and-selffeed-fix-2026-06-15 Phase 2 (P-001/P-002): the OWNER
  // FULL-AUTONOMY grant — the reversible knob the owner flips to let the Queen
  // auto-decide the ENTIRE residue the per-category ceilings can't reach. When ON,
  // (1) the autonomy decider (lib/autonomy/decider.ts) returns `auto` for the
  // categorical hard-gates too — `authority:'owner'`, protected/locked categories,
  // irreversible actions, above-ceiling — and graduation:* ratification asks, so the
  // Queen widens her own ceilings without pausing; and (2) the self-improvement
  // auto-implement loop's risk-tier policy (harness/improvements/policy.ts) lifts the
  // `protectedPathPatterns` + `protectedKeywords` TCB bars, so a kind=bug touching the
  // deploy gate / flags / capability dispatch / migrations / the loop's own code is
  // auto-implement-eligible (still separately gated by IMPROVEMENT_AUTO_IMPLEMENT,
  // default OFF, + the release-manager at deploy). This is the recursive-self-
  // improvement boundary — the owner was warned it removes the last human check on the
  // system widening its own ceilings and editing its own safety machinery, and chose
  // it (knob scope = "decision gate + implement TCB"). OFF by default — DELIBERATE, NOT
  // the alpha flags-default-on policy; the decider/loop fail-DARK on a flag-IO error.
  // REVERSIBLE: flipping it OFF restores today's gated residue VERBATIM (the safety
  // net for an alpha — pinned both directions in tests). Audited via the flag change +
  // the decision ledger (every auto decision records `owner-full-autonomy-grant`).
  QUEEN_FULL_AUTONOMY: "papercusp-queen-full-autonomy",
  // queen-autonomy-policy-2026-06-13 B-15 (P-030): the owner control surface —
  // /settings/autonomy, where the owner sets per-category risk ceilings / locks
  // and sees the earned graduated + derived effective level. ON by default (alpha
  // flags-default-on policy): the page only reads + writes the already-audited
  // autonomy_policy (every category ships never-auto, and editing a ceiling never
  // ARMS autonomy — that's the separate QUEEN_AUTONOMY_ARMED / P-092 gate). OFF is
  // the kill-switch that hides the nav entry (the page's auto-decisions feed +
  // graduation prompts are still stubbed pending B-16).
  QUEEN_AUTONOMY_SETTINGS: "papercusp-queen-autonomy-settings",
  // storage-settings-page-2026-06-15 (P-002): the Settings → Storage owner
  // surface — live usage by category + user-controlled trim-by-age. ON by default
  // (alpha flags-default-on); keep-all is the default behavior regardless. OFF
  // hides the nav entry (the page never auto-prunes — only an explicit trim runs).
  STORAGE_SETTINGS: "papercusp-storage-settings",
  // storage-settings-page-2026-06-15 P-006 — per-retention disable for the
  // pre-existing background prunes surfaced on the Storage page (D-001: "see the
  // full retention picture and disable if desired"). ON by default = the prune
  // keeps running (current behavior); OFF = the DBOS tick skips it. The tick guard
  // is fail-safe (a flag-read error keeps the prune running).
  STORAGE_RETAIN_TELEMETRY: "papercusp-storage-retain-telemetry",
  STORAGE_RETAIN_SCRATCH: "papercusp-storage-retain-scratch",
  STORAGE_RETAIN_TEST_RUNS: "papercusp-storage-retain-test-runs",
  // agent-capability-confinement-2026-06-13 B-18 (P-020/P-021): the FLEET CUTOVER —
  // when ON, autonomous-fleet (bee/pipeline) claude-code spawns drop the native
  // WRITE/exec tools (Bash/Edit/Write/WebFetch) from `--allowed-tools` and route
  // them to the gated `capability:*` defineTools (B-05), keeping only the read-only
  // natives (Read/Glob/Grep/WebSearch) + the role-scoped `mcp__papercusp` wildcard.
  // OFF by default — DELIBERATE (not the alpha default-on policy): it is the owner
  // arming act (P-023 is an owner item) and removing native exec before capability:*
  // ergonomics are validated on a live bee would strand the fleet. Pairs with
  // CAPABILITY_ENVELOPE (the enforcement gate) + CAPABILITY_EXEC_SANDBOX (re-containment).
  // OFF = today's allowlist (native tools granted), zero live-fleet change.
  FLEET_CAPABILITY_ONLY: "papercusp-fleet-capability-only",
  // agent-capability-confinement-2026-06-13 B-18 (P-022 / D-008): re-apply the OS
  // sandbox to the SERVER-SIDE capability exec path. The capability:bash / capability:git
  // tools spawn real subprocesses in the operator (Hono host) process — OUTSIDE the
  // per-spawn agent sandbox (bwrap+egress) that contains native Bash — so the cutover
  // would move exec from a sandboxed context to an unsandboxed one. When ON (and bwrap
  // is available) those subprocesses are wrapped in bwrap with the fleet-sandbox
  // credential masking + cwd-confinement. FAIL-OPEN: bwrap unavailable / flag OFF ⇒ raw
  // spawn (today's behavior) — it can never break a non-bwrap host. OFF by default until
  // validated end-to-end on a bwrap-capable host (this dev box's userns is restricted).
  CAPABILITY_EXEC_SANDBOX: "papercusp-capability-exec-sandbox",
  // git-sync-content-guard-2026-06-13 (D-006-superseded): the runtime KILL-SWITCH for
  // the git-sync content guard (EI-438) — the pre-commit check that quarantines a dirty
  // file failing a content detector (an .mdx that won't compile, a curly quote used as
  // code) so it never reaches staging, + the content-fixer auto-repair. ON by default
  // (alpha default-on + it's a safety feature). When OFF, git-sync passes the guard an
  // EMPTY detector set, so it commits exactly as before this plan (no quarantine, no
  // escalation, no fixer dispatch) — the instant off-switch if the guard ever
  // mis-quarantines real work on the shared commit path, without waiting for a deploy.
  GIT_SYNC_CONTENT_GUARD: "papercusp-git-sync-content-guard",
  // github-bridge-hive-egress-2026-07-02 P-008: the hive P2P git <-> GitHub bridge —
  // on a BRIDGED hive's git-sync tick, ingress origin branches into the synthetic
  // github-origin namespace (admission-gated) + egress canonical refs FF-only to the
  // resolved remote (fork wins — D-007b), divergence reported-not-applied (P-006).
  // Default ON (derived FLAG_DEFAULTS): inert fleet-wide until a hive's federated
  // `hiveGit.mode` setting is flipped to 'bridged' (the owner-set per-hive activation);
  // this flag is the fleet-wide kill-switch, not the activation surface.
  GITHUB_BRIDGE: "papercusp-github-bridge",
  // p2p-work-distribution-2026-07-02 P-002/P-005: the P2P work-sharing surface —
  // the /settings/p2p page (host opt-in, peers capability matrix, GLOBAL
  // kill-switch) + the foreign-work admission contract Phase-1 consumers read.
  // Default ON (derived FLAG_DEFAULTS), the GITHUB_BRIDGE pattern: this flag is
  // the FLEET-WIDE kill-switch, not the activation surface — activation is the
  // real surface (explicit grants P-001 + host opt-in, zero/empty by default per
  // M11), so inertness is structural and no dark-allowlist entry is needed.
  // P-005 layers the rollout TIERS on top (tier 1 same-owner / tier 2 delegate-
  // capped / tier 3 operator grants).
  P2P: "papercusp-p2p",
  // agent-allocation-framework-2026-07-03 P-008 (D-006): the PER-HOST "accept delegated
  // seats" trust gate. Cross-machine agent-slot delegation = a remote fleet owner (A) asks
  // THIS host (B) to spawn bounded agents joined to A's fleet. Letting a remote owner spawn
  // on your box is a real privilege step, so B must OPT IN. DEFAULT OFF (owner-authority):
  // OFF ⇒ this host honors NO delegated-seat spawn requests (fail-closed, byte-identical to
  // today — the gate simply refuses). The contributing-host owner flips it ON per-host via
  // /res (or /admin/features) to opt in. This is the trust half of P-009's honor path.
  ACCEPT_DELEGATED_SEATS: "papercusp-accept-delegated-seats",
  // git-sync-dx-hardening-2026-06-17 P-004: DERIVED commit attribution — when ON, git-sync
  // groups dirty files by the agent who declared them (coord:declare-intent / lock holder)
  // and makes per-agent commits with the intent message + a Co-Authored-By trailer (catch-all
  // commit for the unattributable remainder), restoring git blame/bisect/review for humans.
  // DEFAULT OFF: it rewrites the commit hot path; OFF = today's single `git add -A` commit,
  // byte-identical. No new agent ceremony (attribution is DERIVED). Owner flips post-review.
  GIT_SYNC_DERIVED_ATTRIBUTION: "papercusp-git-sync-derived-attribution",
  // docs-corpus-audit WS2 P-008 / deterministic-commit-workitem-attribution P-005: the
  // doc-steward — the post-git-sync freshness sweep, on a drifted doc, dispatches a
  // doc-steward agent to re-verify/regenerate it against the current code (the LLM consumer
  // that closes the doc-drift loop). DEFAULT OFF: it auto-edits the doc corpus (owner-authority
  // surface) + spawns an agent per drift — flip ON after the owner-verified end-to-end check.
  DOC_STEWARD: "papercusp-doc-steward",
  // plan-federation-regrain-2026-06-13 P-005/P-006: per-PART plan federation —
  // kills the whole-document LWW clobber where two peers editing DIFFERENT plan
  // items lose one edit (D-009). DEFAULT-OFF: an UNVERIFIED cutover that needs a
  // real two-machine merge proof (P-008) + the existing-plan backfill (P-007)
  // before the flip. When OFF, plans federate EXACTLY as today (the whole
  // harness_plans.content blob, mig 125) and the per-part capture/projection are
  // inert — the live path is byte-identical. The owner flips this ON at cutover.
  PLAN_PART_FEDERATION: "papercusp-plan-part-federation",
  // Plan ownership/attribution badges: owner + last-editor on plan list rows +
  // detail, and per-item author (shared-hive-collaboration-2026-06-14 P-001, B1).
  // DEFAULT-ON: additive surfacing over data that already exists; degrades to
  // handle+initials when no github identity is bound (hive_members empty) and the
  // per-item badge stays dark until real per-op author pubkeys federate.
  PLAN_ATTRIBUTION_BADGES: "papercusp-plan-attribution-badges",
  // shared-hive-collaboration-2026-06-14 B11 / P-014 (D-011): role/permission
  // tiers (owner/collaborator/read-only) derived from the GitHub collaborator
  // graph, gating owner-actions on a SHARED hive (dissolve/leave/teardown). A
  // read-only member can't do owner actions; the local owner's tier is
  // re-derived LIVE from GitHub for these high-stakes actions (never federated
  // state). DEFAULT-ON (owner-directed) — enforces immediately; this key is the
  // kill-switch. OFF = today's behavior (existing root-only/source/confirm gates
  // only); SOLO/unbound hives are never gated (the owner keeps owner tier).
  HIVE_ROLE_TIERS: "papercusp-hive-role-tiers",
  // worker-chunk-loop-operator-hosted-2026-06-14 (P-142 / P-004): route the coding
  // director's worker dispatch to the operator-hosted `worker:chunk-loop` op instead
  // of the subprocess chunk loop. DEFAULT ON, but it is the FIRST of a TWO-gate guard —
  // routing ALSO requires the per-harness `workerChunkLoop` config knob (default false),
  // which is the real cohort/ramp lever (dark-launch → ramp → retire). Flag-ON alone is
  // behavior-neutral: every coding worker stays on the subprocess path until a harness opts in.
  WORKER_CHUNK_LOOP_BLUEPRINT: "papercusp-worker-chunk-loop-blueprint",
  // generic-column-filters-2026-06-14 (Phase 2): gates the generic per-column
  // FILTER BAR on the /adv dock panels (RichGrid + non-grid) — the +Add-filter
  // Select → per-type Popover editor → removable chip row built on
  // @papercusp/grid-core's pure filter engine. When OFF, <ColumnFilterBar/>
  // renders nothing (the panels still list unfiltered rows). DEFAULT ON (alpha
  // flags-default-on policy): the bar is additive surfacing over a tested engine.
  GRID_COLUMN_FILTERS: "papercusp-grid-column-filters",
  // hive-control-surface-2026-06-14: gates the central LOCAL-hive start/stop
  // control — the Hives-tab LocalHivesControl panel + the always-visible header
  // HivesRunningPill ("N running" + click-to-expand per-hive toggles). Reads
  // hive.controlState; writes via pot:start / pot:pause. DEFAULT ON (alpha
  // flags-default-on): additive surfacing over the existing gated controls; OFF
  // = the new surfaces render nothing (per-hive start/stop in AdvNowRunning is
  // unchanged either way).
  HIVE_CONTROL: "papercusp-hive-control",
  // queen-interactive-brain-fresh-context-2026-06-14: when ON (default), the
  // interactive `psu --brain` pane launches FRESH per open (new session + an
  // injected computeQueenWakeBrief) instead of resuming the persistent D-013
  // pinned brain (which grows → Claude compacts → the resume picker). Reverses
  // native-terminal-desktop D-013; OFF = the persistent-resume brain (today's).
  QUEEN_BRAIN_FRESH: "papercusp-queen-brain-fresh",
  // per-hive-learning-loops-2026-06-14 P-070 (D-006/D-007): the deployment-mode
  // knob for the LAYER-3 PLATFORM-IMPROVEMENT loops — the workspace-SINGLETON
  // Class-C frontier/measurement/watchdog set (negative-space, neologism,
  // fleet-ekg, calibration, deferral-interest, graduation, red-queen, regret,
  // transfer, prompt-ablation, change-ledger, iq-battery +
  // improvement-watchdog/triage/implement). When ON the Class-C loops register /
  // materialize at seed time; when OFF they are SKIPPED / seeded-inactive. This
  // gates REGISTRATION ONLY — no loop's logic changes, and the frontier loops
  // each keep their own arming gate on top (the individual dark flags + governor
  // budgets). gym/scout (per-hive Class-B, layers 1-2) are NEVER gated by this.
  // DEFAULT ON: dev / self-host run the full platform loop (this dev workspace
  // is exactly "Papercusp inside Papercusp"). A public RELEASE build keeps it
  // OFF until the user opts into platform mode (D-006) — but the repo has NO
  // dev-vs-release runtime signal yet, so release-off is achieved by the build
  // setting PAPERCUSP_PLATFORM_MODE=off (resolved in @papercusp/flags/server),
  // an OWNER design point flagged in P-070's report (do not invent
  // release-detection infra). OFF = the Class-C loops ship dark.
  PLATFORM_IMPROVEMENT_LOOPS: "papercusp-platform-improvement-loops",
  // directed-wake-honesty-and-spawn-handoff-2026-06-14 P-014/P-021: gates the ONE
  // bounded spawn/wake-hydration block (assembleSpawnHydration) — the volatile-tail
  // `## Handoff` section a freshly-spawned or warm-woken agent opens with
  // (predecessor handoff + hive-roster snapshot + work-item carry-note). When ON
  // (default), the spawn paths (operator-spawn autonomous + bootstrap-role
  // interactive, P-012) precompute the block and thread it to buildPrompt; when OFF
  // the block is skipped and no `## Handoff` section renders. DEFAULT ON (alpha
  // flags-default-on; finished work ships on): each source is fail-soft + bounded,
  // so the block degrades to empty rather than breaking a spawn.
  SPAWN_HANDOFF_HYDRATION: "papercusp-spawn-handoff-hydration",
  // overwatch-role-2026-06-15 (B-10): gates the OVERWATCH role — a new always-on
  // autonomous system-health supervisor (sibling to the Queen). The flag gates
  // (a) the `overwatch` role registration (B-01), (b) the autonomous wake-loop +
  // its routine/rule (B-04), and (c) the Overwatch UI pane (B-08). DEFAULT OFF —
  // DELIBERATE (NOT the alpha flags-default-on policy): a brand-new, not-yet-proven
  // AUTONOMOUS role that nudges the running fleet. A confused overwatch must not be
  // able to thrash the system it protects (D-002/D-004), so it ships dark until
  // B-12's first live run on staging proves it (coherent brief, nudges-not-replaces,
  // observes-not-ideas, no thrash, cross-monitors the Queen). The owner flips it ON
  // after that proof — surfaced loudly in the plan's ## Now + every lane report.
  OVERWATCH: "papercusp-overwatch",
  // sentinel-as-herald-2026-06-21: gates the SENTINEL role — a new always-on
  // autonomous system-health supervisor (sibling to the Queen, mirrors OVERWATCH).
  // The flag gates (a) the `sentinel` role registration, (b) the autonomous wake-loop +
  // its routine/rule, and (c) the Sentinel UI pane. Runtime default ON: the
  // live-run proof landed (sentinel-herald ## Now, verified live 2026-06-24) and
  // the flag was live-enabled; with the derived FLAG_DEFAULTS inversion it is
  // ON-by-default and voice-unified-sentinel-pipeline-2026-07-01 P-011 makes
  // that DELIBERATE — the Sentinel pane is now the one voice brain, so a dark
  // sentinel means a dead voice product. Flip OFF via /admin/features to go dark.
  SENTINEL: "papercusp-sentinel",
  // sentinel-as-herald-2026-06-21 Phase 5 (P-018..P-022): gates the SERVER-SIDE
  // proactive "decide to speak" sweep — the voice-host periodic tick that lets the
  // Sentinel Herald speak out-of-band (a role:'sentinel' converse turn with trigger
  // 'sentinel_scan', TTS'd + pushed via broadcastOpVoice) with NO desktop UI open,
  // or routes a salient alert via attention-push + hindsight when no live voice
  // session exists. Runtime default ON (derived FLAG_DEFAULTS — live-enabled at
  // sentinel-herald ship, made DELIBERATE by voice-unified-sentinel-pipeline
  // P-011). Safe despite being an autonomous speak loop because it is
  // triple-gated on top of the flag: humanFacingRole==='sentinel' AND not
  // DND/paused/over-budget AND the voice-host owns the lease (single-owner) —
  // most ticks are a flag read + no-op. Flip OFF via /admin/features to silence
  // proactive speech entirely.
  SENTINEL_PROACTIVE: "papercusp-sentinel-proactive",
  // scheduled-recurring-plans-2026-06-16 (P-028 → D-019): the global master switch for
  // the scheduled-plan EXECUTION path — the system:plan-run action + arming. DEFAULT ON
  // (owner-directed at ship, D-019). Safe despite being an autonomous executor: the real
  // control is per-plan ARMING (autonomy-gated, schedule-arm never-auto, owner-only);
  // an un-armed feature fires nothing. Flip OFF via /admin/features for dark.
  SCHEDULED_PLANS: "papercusp-scheduled-plans",
  // impartial-benchmark-suite-2026-06-15 (P-005/BRIEF 3): gates the EXTERNAL-BENCH
  // grader adapter + the `external-bench:run` op — the runner that clones a public
  // benchmark task, spins a throwaway coding harness, extracts the diff, and grades
  // it with the benchmark's OFFICIAL external Docker grader (SWE-bench Pro, M1).
  // DEFAULT OFF — DELIBERATE (NOT the alpha flags-default-on policy): the runner is
  // genuinely incomplete (M2 in-container modality unbuilt; the SWE-bench-Pro grader
  // needs a dedicated Docker host + GB-scale image pulls) and infra-heavy (it spins
  // real harnesses + pulls per-instance images). It ships dark until the ~50-task
  // pilot (P-009) proves the end-to-end path. The owner flips it ON after that — the
  // pending flip is surfaced in the plan's ## Now + every lane report.
  EXTERNAL_BENCH: "papercusp-external-bench",
  // system-health-tab-2026-06-15: gates the read-only HEALTH tab (a live
  // at-a-glance dashboard of the whole running system — Queen / bees / work-feed
  // / tokens / deploy / infra) beside Working in /adv, plus its `health.snapshot`
  // sync resolver + the periodic system-health tick. DEFAULT ON (alpha
  // flags-default-on): a purely additive read-only surface over reads that
  // already exist (computeSystemHealth fail-soft per panel). OFF = the tab is
  // hidden + the resolver returns empty + the tick no-ops. The SAME aggregation
  // also feeds the overwatch role (overwatch-role-2026-06-15 C-1, D-001).
  SYSTEM_HEALTH_TAB: "papercusp-system-health-tab",
  // schedule-inventory-and-ephemeral-tier-2026-06-26 P-003: gates the read-only
  // /admin/schedules page + its inventory endpoint (the central view of every
  // scheduled/recurring thing — DBOS crons, system routines, in-process sweeps).
  // DEFAULT ON (alpha flags-default-on): a purely additive read-only diagnostic
  // surface over reads that already exist. OFF = the tab is hidden + the endpoint
  // returns { enabled: false }.
  SCHEDULE_INVENTORY: "papercusp-schedule-inventory",
  // schedule-inventory-and-ephemeral-tier-2026-06-26 P-013 / D-006: gates the
  // blueprint-declared EPHEMERAL cadence tier. Read at MATERIALIZE time (a request
  // context — boot-time getFlag is fragile, see host-bootstrap): OFF ⇒ a blueprint's
  // tier:'ephemeral' schedule entries are NOT materialized into routine rows, so the
  // per-host ephemeral executor arms nothing and the frequent non-DBOS cadence never
  // fires (durable cron + in-process sweeps unaffected). DEFAULT ON (flipped on after
  // the P-013 real-PG live verify — do NOT ship dark).
  EPHEMERAL_CADENCE: "papercusp-ephemeral-cadence",
  // bee-context-efficiency Phase 1 (D-001/D-018/D-019): fresh-context warm-inject.
  // When a DRAINED bee is warm-injected a NEW task, re-invoke with a FRESH session
  // (full bee-prompt re-assembly + the hydration tail) instead of `--resume`-ing the
  // grown transcript (the ~138K/turn dead-transcript carry, D-011). DEFAULT OFF — an
  // unverified HOT-PATH change to live bee re-invocation; flip ON after P-006 live
  // verification (kill-switch: OFF ⇒ legacy `--resume`, behavior-neutral).
  BEE_FRESH_CONTEXT_WARM_INJECT: "papercusp-bee-fresh-context-warm-inject",
  // bee-context-efficiency Phase 2 (P-008/P-009, D-004): inject the precomputed
  // work-item DOSSIER (computeBeeWakeDossier — item text + linked plan item + outgoing
  // `blocks` edges + topics + recent comments + hive-roster snapshot) into the spawn/
  // wake-hydration VOLATILE TAIL, so a (re)spawned agent opens already-briefed and skips
  // the work_items:get / plans:get / coord:presence round-trips. Rides the volatile tail
  // ONLY (never the cacheable preamble, D-004); a sub-feature of SPAWN_HANDOFF_HYDRATION.
  // DEFAULT ON (alpha flags-default-on) — additive, bounded, fail-soft; OFF ⇒ no dossier
  // (the agent falls back to its read tools), behavior otherwise unchanged.
  BEE_WAKE_DOSSIER: "papercusp-bee-wake-dossier",
  // bee-context-efficiency Phase 4 (P-013, D-007): the transcript-cap BACKSTOP. A
  // cadence sweep recycles a bee whose session has carried too many tasks / too large a
  // token-span (force a fresh spawn after a threshold; the work-item checkpoint carries
  // continuity). Only ever recycles an IDLE/drained bee (D-005 — never mid-task). DEFAULT
  // ON (not in DARK_FLAGS — WI-1658: pre-inversion default was already true). The
  // seed-bee-transcript-cap-routine.ts bring-up script still SEEDS its routine row
  // INACTIVE on first insert (a separate, routine-level gate from this flag) —
  // check routines:list/routines:set for its live active state before relying on
  // the sweep actually firing.
  BEE_TRANSCRIPT_CAP: "papercusp-bee-transcript-cap",
  // plan-implementation-framework P-003 (compiled-briefs): when on, plan_items:convert
  // COMPILES the work-item brief from the plan item + plan focus (## Now) + the decisions
  // bearing on the item, instead of leaving payload.brief to a hand-authored overlay.
  COMPILED_BRIEFS: "papercusp-compiled-briefs",
  // plan-implementation-framework P-002 (touch-set-exclusion): when on, the Queen's
  // placement chokepoint (place_batch) drops a ready work_item whose declared file
  // touch-set overlaps a running bee's files or an already-admitted sibling — proactive
  // hive-scoped conflict avoidance (cross-hive collisions stay on reactive git-merge).
  TOUCH_SET_EXCLUSION: "papercusp-touch-set-exclusion",
  // plan-implementation-framework P-004 (workitem-amend): when on, work_items:amend
  // records a non-re-derivable structural decision (split/drop/reapproach/expand/note)
  // durably on a node — the Queen disposes, a bee proposes; the commit-before-dispatch record.
  WORKITEM_AMEND: "papercusp-workitem-amend",
  // plan-implementation-framework P-005 (deferred-expansion): when on, work_items:expand
  // emits child work_items from an expand-here node (bee proposes, Queen disposes) — the
  // record starts shallow and self-elaborates at the point of best context.
  DEFERRED_EXPANSION: "papercusp-deferred-expansion",
  // steering-nested-hive-plan-tree-2026-06-17 (P-003): the 👑 Queen steering panel's
  // NESTED hive→plan picker — hives at top, their plans nested beneath, a plan
  // selectable only under a checked hive. Replaces the two FLAT lists (Eligible
  // hives + Eligible plans) that let you express a contradiction (an eligible plan
  // under an excluded hive — a dead no-op the survey silently drops). DEFAULT ON
  // (alpha flags-default-on): a complete presentation switch over the unchanged
  // persisted (eligibleHives, eligiblePlans) shape (D-001); OFF renders the legacy
  // two flat sections as the fallback.
  STEERING_HIVE_TREE: "papercusp-steering-hive-tree",
  // workspace-data-isolation-leaks-2026-06-17 (F-C1): scope the coordination plane
  // (messages / handoffs / escalations / plan-events via coord_event_log + watermarks)
  // to the ACTIVE workspace instead of the single shared `default` partition. DEFAULT
  // OFF — DELIBERATE (not the alpha default-on policy): flipping it cuts the live fleet's
  // coordination over to per-workspace partitions, so it ships as a reversible kill-switch
  // the owner flips ON (OFF = today's `default`-pinned behavior, byte-identical; the old
  // `default` history is preserved, so flipping OFF fully restores it). Listed in
  // KNOWN_DARK_FLAGS.
  COORD_PER_WORKSPACE: "papercusp-coord-per-workspace",
  // workspace-data-isolation-leaks-2026-06-17 (owner D-001): scope the engineer-issues
  // store (engineer_issues rows + their coord tags/threads/links/subscriptions) to the
  // ACTIVE workspace instead of the single shared `default` coord workspace. EI-<n> ids
  // stay GLOBALLY allocated (nextIssueId), preserving the ObjectRef contract; only the
  // ROWS become per-workspace. DEFAULT OFF — DELIBERATE (not alpha default-on): flipping
  // it cuts the live shared issue bus over to per-workspace partitions, so it ships as a
  // reversible kill-switch the owner flips ON (OFF = today's `default`-pinned behavior,
  // byte-identical; old `default` issues preserved). Listed in KNOWN_DARK_FLAGS.
  ISSUES_PER_WORKSPACE: "papercusp-issues-per-workspace",
  // work-queue-stuck-item-recovery-2026-06-17 P-012 / D-008: the per-Hive authority claim
  // LEASE (decentralized-dispatch-scaling P-004) — migrated off the ad-hoc
  // PAPERCUSP_WORKITEM_CLAIM_LEASE env gate to a runtime-flippable FLAG. DEFAULT ON
  // (graduated 2026-06-23, owner-directed verify+flip, WI-597): the recovery layer the D-008
  // gate waited on is now in place — the stale-claim reaper requeues mid-flight items (GAP 1)
  // and covers the issue family (GAP 2), closing the stuck-item risk regardless of the lease.
  // Verified: lease acquire/heartbeat/expiry-steal + dead-holder reclaim (work-item-claims +
  // work-items-stale-claims integration tests green). On a single box claim_next gates re-claim
  // on work_items.taken_by (liveness-reclaimed), NOT the lease TTL, so the self-selection path's
  // no-heartbeat is benign (worst case: edit-attribution coarseness); cross-Swarm double-claims
  // are reconcile-covered (P-005). Reversible (OFF = local SELECT … FOR UPDATE SKIP LOCKED).
  // Read SYNC-cached (deep in the claim path) via work-item-claim-lease-wiring.ts.
  WORKITEM_CLAIM_LEASE: "papercusp-workitem-claim-lease",
  // cross-machine-coord-parity-and-trust-2026-07-01 P-004 (D-002/D-008): presence rides
  // the EPHEMERAL gossip channel (presence-gossip.ts, papercusp/hive-presence frames)
  // instead of appending beats to the append-only peer-log — beat-like data immortalized
  // in logs is the 256×10 scaling wall (heartbeats ≈ half the hive's write budget).
  // OFF = today's log-append announce loop (wire-presence.ts), byte-identical. ON = the
  // announce loop broadcasts device-signed gossip frames; pot:leave publishes a signed
  // del tombstone frame. CUTOVER flag: every peer must carry the gossip READER before a
  // writer flips (a gossip-only announcer is invisible to a log-only reader), so it ships
  // dark until both dogfood machines updated; owner flips after a 2-machine verify.
  // Listed in KNOWN_DARK_FLAGS (cutover).
  PRESENCE_GOSSIP: "papercusp-presence-gossip",
  // workspace-data-isolation-leaks-2026-06-17 F-E1 (PHASE 1): scope the routines
  // upsert's ON CONFLICT to (workspace_id, install_slug, name) so a hive in workspace
  // B can no longer CLOBBER a same-named routine in workspace A (the latent leak — 0
  // collisions live today). DEFAULT OFF — reversible kill-switch; OFF = today's
  // ON CONFLICT (install_slug, name), byte-identical. Phase 2 (drop the old unique +
  // fold workspace_id into the routine id, to let same-slug routines fully COEXIST
  // across workspaces) is a separate staged migration. Listed in KNOWN_DARK_FLAGS.
  ROUTINES_PER_WORKSPACE: "papercusp-routines-per-workspace",
  // workspace-data-isolation-leaks-2026-06-17 F-M7: when ON, ui:dispatch / ui:get_state /
  // tui:dispatch reject a target ui_client that belongs to a DIFFERENT workspace than the
  // caller's active one (ui_intents keys on client_id with no workspace column; ui_clients
  // carries workspace_id). These tools are SU-only, so this is a guard rail (low exploitability).
  // DEFAULT OFF — reversible; OFF = today's behavior (no check), byte-identical. KNOWN_DARK_FLAGS.
  UI_WORKSPACE_GUARD: "papercusp-ui-workspace-guard",
  // scoped-superuser-workspace-clamp-2026-06-18: bind a psu workspace-scoped superuser
  // session to its launch workspace at the DISPATCH layer (its ctx workspaceId becomes that
  // concrete workspace instead of '*'), engaging the EXISTING effectiveDispatchWorkspace
  // clamp; ALSO deny crossWorkspace:true tools + the harness:'all' global plan escape for a
  // scoped session. DEFAULT OFF — DELIBERATE (not alpha default-on): it changes auth
  // enforcement for every superuser session, so it ships as a reversible kill-switch the
  // owner flips ON after an attended :3170 verification (OFF = today's unscoped '*'
  // superuser, byte-identical). Listed in KNOWN_DARK_FLAGS.
  SCOPED_SUPERUSER_CLAMP: "papercusp-scoped-superuser-clamp",
  // domain-generic-agent-personas-2026-06-17 P-006: resolve the `su` role's persona via the
  // blueprint prompt-resolve chain (blueprints/base/prompts/su.md) instead of the hardcoded
  // papercusp-su playbook. DEFAULT ON (owner-authorized 2026-06-18; the papercup-hive su instance
  // override is seeded — P-008 met). OFF = legacy renderSuPlaybook, byte-identical.
  SU_BLUEPRINT_PERSONA: "papercusp-su-blueprint-persona",
  // domain-generic-agent-personas-2026-06-17 P-013/P-014: deliver the agent prompt by REPLACING
  // the Claude Code base (--system-prompt-file / --system-prompt) instead of append/stdin, so OUR
  // persona is the whole system prompt. DEFAULT ON (owner-authorized 2026-06-18) — OFF =
  // legacy stdin/append, byte-identical. Full per-role×backend e2e smoke infra-gated (EI-1433).
  REPLACE_CLAUDE_BASE: "papercusp-replace-claude-base",
  // watchdog-and-exposed-systems-improvement-2026-06-18 P-009: the watchdog auto-CLOSES
  // an EI whose signal stopped firing for N ran-ticks. DEFAULT OFF — auto-closing real
  // improvement items autonomously is unsafe until the owner reviews; OFF = today's
  // behavior (escalate-only, never auto-resolve), byte-identical. KNOWN_DARK_FLAGS.
  WATCHDOG_AUTO_CLOSE: "papercusp-watchdog-auto-close",
  // shared-hive-rekey-2026-06-19 (C-001 read-plane revocation, S0-for-release): the
  // master gate for the hive epoch RE-KEY — content encrypted under a per-epoch group
  // key so a removed/excluded peer cannot READ post-boundary content. The K-half
  // modules (hive-epoch-* / resolveHiveEpochCrypto) + the boundary + op-path wiring all
  // resolve behind it. DEFAULT ON (graduated 2026-06-29 via the P-011 flag-default
  // inversion — NOT in DARK_FLAGS): the live cut-off witness (P-008 / public-release
  // GATE-1) passed cross-machine on the real binary (shared-hive-public-release D-014)
  // and shipped in desktop alpha.2, so the gate condition is met. ON ⇒ the real
  // per-epoch crypto (encrypt-on-write / decrypt-on-read) for NEW hives; existing hives
  // stay legacy-unencrypted (rekey D-003). Re-add to DARK_FLAGS to fall back to the
  // notImplemented stub (byte-identical to pre-rekey).
  HIVE_REKEY: "papercusp-hive-rekey",
  // hive-seed-bundle-2026-07-04 (P-011): the master gate for the installer-shipped
  // SEED restore — a bundled snapshot of the shared hive (git bundles + federated
  // corestore) that first boot RESTORES so the live join only carries the DELTA.
  // DEFAULT ON (not in DARK_FLAGS — finished work never ships dark): a fresh install
  // with a bundled seed restores it before the (unchanged) join; the real join +
  // admission + delta replication STILL run (D-007 — the seed pre-positions BYTES,
  // it does NOT bypass the join), and every store re-verifies natively (git hashes,
  // corestore merkle/signatures). OFF ⇒ the pure COLD path (whole-history transfer),
  // byte-identical to a --no-seed / no-seed-bundled build — a runtime kill-switch if a
  // seed restore ever misbehaves. Inert on a build with no bundled seed (resolveSeedDir
  // → null ⇒ cold join regardless). Read at the two bootstrap restore call sites
  // (bootstrap-papercusp-hive.ts). NOT in KNOWN_DARK_FLAGS.
  HIVE_SEED_BUNDLE: "papercusp-hive-seed-bundle",
  // loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5 / P-008): the master gate for
  // engine-managed LOOPS — the tracked replacement for Claude /loop (loop:arm re-wakes a
  // warm su session N sec after each turn settles). DEFAULT ON (WI-612): the B-LOOP-1..5
  // chain shipped green, the manual warm-loop e2e passed, and the post-storm live-verify
  // gate (loop-wake-rate-limit-robustness-2026-06-23 D-001) is satisfied — the owner
  // flipped it live-ON 2026-06-23 and it is not in DARK_FLAGS below, so it now also
  // defaults ON for fresh hosts (the derived FLAG_DEFAULTS inversion). OFF would make
  // loop:arm refuse (loop:end/loop:status always work); inert otherwise (no loop rows).
  LOOPS: "papercusp-loops",
  // su-cold-auto-mode-2026-07-03 (P-007): the MASTER AVAILABILITY gate for su COLD-AUTO loops
  // (a loop whose wakes RESET-CONTEXT / periodically RECYCLE to a carry-note instead of a warm
  // in-place turn). DEFAULT ON (not dark) — owner-enabled 2026-07-03. Safe ON because it is only
  // an availability switch: the REAL opt-in is per-loop (`loop:arm { carry:'cold' }`) AND a
  // carry-note must exist (decideColdWake), so NOTHING goes cold until an operator explicitly
  // arms a loop cold. OFF ⇒ every loop wake stays warm regardless of its carry marker. Read at
  // the wake-executor call-site (engine.ts) as the injected coldAutoEnabled dep.
  SU_COLD_AUTO: "papercusp-su-cold-auto",
  // workspace-scoped-coordination-2026-06-20 (D-007): the SHARED master gate for moving the
  // QUEEN + SCOUT (+ later OVERWATCH) from per-HIVE to WORKSPACE scope — ONE central brain per
  // workspace spanning all its hives (P-003 Queen re-key + P-002 Scout re-key both gate on THIS
  // one flag, so the two halves flip together). DEFAULT OFF (dark): the re-key touches the live
  // wake/learning loop on a hot path, so it ships reversible behind one flag and flips ON only
  // after the post-canary verify. OFF ⇒ today's per-hive brains, byte-identical. KNOWN_DARK_FLAGS.
  WORKSPACE_COORDINATION: "papercusp-workspace-coordination",
  // unified-work-item-ledger-2026-06-21 P-003 (D-002): auto-promote a started plan's OPEN
  // items into placeable, UNCLAIMED work-items inside plans:start (the single promotion path;
  // the Queen just calls plans:start). DEFAULT OFF (dark): it mints work-items on the live
  // start path + the Queen frontier, so it ships reversible and flips ON only after an
  // attended integration-verify. OFF ⇒ no promotion (today's behavior, byte-identical).
  // KNOWN_DARK_FLAGS.
  PLAN_WORKITEM_PROMOTION: "papercusp-plan-workitem-promotion",
  // queen-memory-hybrid-2026-07-02 L2 (owner-approved hybrid): queen wakes prefer the
  // wake-executor liveness ladder (inject-if-live / claude --resume-if-exited — the
  // proven B-LOOP-3 machinery) over a cold invoke-once spawn, giving the Queen a WARM
  // session with managed compaction; deterministic REBIRTH (boot-id change / age>24h /
  // anomaly) falls through to the cold spawn (today's behavior, byte-identical).
  // DEFAULT OFF (dark, cutover): flips after an attended A/B verify (tokens/wake,
  // latency, time-to-place, re-derivation count). KNOWN_DARK_FLAGS.
  QUEEN_WARM_SESSION: "papercusp-queen-warm-session",
  // work-queue-completeness-2026-06-21 Phase A (unified-work-item-ledger): ENFORCEMENT —
  // every plan-item claim auto-mints a tracked work-item. When ON, the three bare-claim
  // bypass paths (plan_items:claim, coord:declare-intent { items }, plans:set-status → wip
  // auto-claim) route the claim through convertPlanItem (policy-checked lease → resume-or-mint
  // a work_item → claim it → link it back), so WORKING a plan item never leaves untracked work.
  // DEFAULT OFF (dark, reversible): it mints work-items on every live plan-item claim path; the
  // owner flips it ON after verifying. OFF ⇒ today's bare claimPlanItem (byte-identical). The
  // auto-convert legs in declare-intent / set-status are best-effort (wrapped so a convert
  // failure never breaks the underlying claim). KNOWN_DARK_FLAGS.
  PLAN_ITEM_CLAIM_AUTO_CONVERT: "papercusp-claim-auto-convert",
  // infra-perf-reliability-audit-round4 P-005 (D-005): switch listEscalations({status:'open'})
  // to read the materialized harness_shared.coord_open_escalations projection (mig 355) instead
  // of the unbounded ~35k-event full-surface replay that pg_stat_statements pinned as ~88% of
  // DB exec time. DEFAULT OFF (dark): the projection table+trigger ship via mig 355 (additive,
  // harmless while OFF — the trigger just maintains the table); this flag gates only the READ
  // cutover, flipped ON after the migration+backfill is confirmed applied in prod. OFF ⇒ the
  // authoritative event-fold (today's behavior, byte-identical). KNOWN_DARK_FLAGS.
  COORD_OPEN_ESCALATIONS_PROJECTION: "papercusp-coord-open-escalations-projection",
  // coord-wake-on-reply: by default, when an agent coord:sends a DIRECTED message and
  // a peer REPLIES to it (their coord:send sets related_msg_id to the original msg_id),
  // auto-wake the ORIGINAL sender so they re-invoke the moment the reply lands — the
  // dual of deliver-and-wake (which wakes the RECIPIENT). DEFAULT ON (alpha default-on
  // policy): the reply-wake is OPTIMISTIC + fully fail-soft (a lookup miss / sql hiccup /
  // wake failure is swallowed and never blocks the send), so it only ever adds a
  // best-effort re-invoke. OFF ⇒ no opt-in persisted + no reply-wake fired (today's
  // behavior, byte-identical: a reply just sits in the inbox until the sender's next turn).
  COORD_WAKE_ON_REPLY: "papercusp-coord-wake-on-reply",
  // caching-layer-tag-eca-2026-06-22 P-004: wire the operator cache to the change
  // stream — a `<schema>.<table>.changed` event (emit_change_notify, mig 368 carries
  // args.id + workspace_id) fires the built-in `cache.bumpTags` reaction action, which
  // bumps the per-(workspace, tag) generation for `['<table>', '<table>:<id>']` so every
  // tagged getOrSet entry is lazily stale on its next read. DEFAULT ON (alpha
  // flags-default-on): the action + rule are complete + tested and the bump is a SAFE
  // no-op side effect (it only marks cache generations; with no consumers yet nothing
  // breaks) — the kill-switch is purely precautionary. OFF ⇒ the rule's `when` falls
  // false ⇒ no invalidation (byte-identical to no cache). Reading the live change stream
  // INTO emitSystemEvent is a focused follow (the sync bus's bridge sees only the event
  // name, not args.id/workspace_id) — see the P-004 completion note.
  CACHE_TAG_ECA: "papercusp-cache-tag-eca",
  // caching-layer-tag-eca-2026-06-22 P-018 (operational hardening): the operator
  // L1 cache READ kill-switch (distinct from CACHE_TAG_ECA, which only gates the
  // invalidation ECA rule). DEFAULT ON: the cache serves/single-flights getOrSet
  // entries. OFF ⇒ the singleton's `bypass` returns true ⇒ every getOrSet runs its
  // factory directly (no L1 read/write) — byte-identical to having no cache, the
  // panic switch if a cache consumer ever serves wrong/stale data in prod. Read
  // SYNC-cached (the getOrSet hot path can't await), refreshed on boot + flag change.
  CACHE_LAYER: "papercusp-cache-layer",
  // data-sync-push-completion P-005/D-012: the DEBOUNCED live-invalidation detector for the
  // six APPEND_HEAVY_TABLES (audit_log, agent_runs_consolidated, user_actions, harness_hook_logs,
  // toast_log, feature_audit_consolidated) — which intentionally carry NO per-row change-notify
  // trigger (notify-storm; mig 376 + COVERAGE_EXEMPT). ON ⇒ the host polls max(id) per table and
  // synthesizes a `<table>.changed` invalidation when it advances, so their mapped sync queries
  // (userActions.*, auditLog.*, toastLog.recent, …) push-update without the per-row storm. OFF ⇒
  // no detector; those consumers fall back to their own poll / the 180s drift-repair (the
  // pre-P-005 behavior). DEFAULT ON: the detector + the bus per-call dedupe override are complete
  // + tested; cuttable kill-switch if the synthesized fires ever misbehave.
  APPEND_HEAVY_LIVE_INVALIDATION: "papercusp-append-heavy-live-invalidation",
  // hybrid-bee-scheduler-work-stealing-2026-06-22 — gate the SPEC-driven claim path: ON ⇒
  // scheduler:get_next pulls per the bee's Queen-issued claim spec; OFF ⇒ get_next ignores stored
  // specs and falls back to the DEFAULT ordering (== work_items:claim_next) — a no-breakage
  // kill-switch. DEFAULT ON (alpha flags-default-on; the resolver + spec store are complete + tested).
  SCHEDULER_SPEC_CLAIM: "papercusp-scheduler-spec-claim",
  // work-item-deps-and-readiness-2026-06-22 P-005: the scheduler claim reads the maintained
  // readiness sidecar (work_item_blocked — an indexed anti-join) instead of the inline per-claim
  // NOT EXISTS subquery. Behavior-identical; a performance cutover. DEFAULT ON (derived
  // FLAG_DEFAULTS — graduated out of DARK_FLAGS 2026-06-22 after a sustained live drift=0 verify;
  // requires mig 379). OFF is the reversible kill-switch back to the inline predicate.
  SCHEDULER_MAINTAINED_READY: "papercusp-scheduler-maintained-ready",
  // gateway-priority-tiers-2026-06-22: gates the inference-gateway priority-tier
  // queueing/admission path. DEFAULT OFF — the implementation is in-flight; flips
  // ON at rollout after the :3170 verify. KNOWN_DARK_FLAGS.
  GATEWAY_PRIORITY_TIERS: "papercusp-gateway-priority-tiers",
  // codex-gateway-oauth-proxy-2026-07-04 (WI-2198, owner-chosen Option B): gates the
  // codex ChatGPT-subscription OAuth STREAMING reverse-proxy — the gateway forwards a
  // codex-cli account's native Responses request to chatgpt.com/backend-api/codex with
  // the OAuth bearer injected from ~/.codex/auth.json (vs the one-shot `codex exec`
  // bridge that rejects stream:true). DEFAULT OFF — reversible CUTOVER kill-switch: it
  // routes fleet codex agents through a REVERSE-ENGINEERED proprietary transport that
  // can only be verified by an owner-attended live canary against production ChatGPT;
  // direct native auth (the current fleet path) is the fallback. KNOWN_DARK_FLAGS.
  // OFF ⇒ codex-cli accounts keep the exec bridge (stream:false only).
  CODEX_GATEWAY_OAUTH_PROXY: "papercusp-codex-gateway-oauth-proxy",
  // autonomous-spawn-gateway-dispatch-gate-2026-07-04 (WI-2376): before an
  // AUTONOMOUS durable spawn posts /invoke, read the inference-gateway health
  // predicate and SKIP the dispatch when the Claude gateway is wholesale-throttled
  // (paused/rejected/no priority-tier capacity). DEFAULT ON (derived FLAG_DEFAULTS):
  // it is a conservative load-shed guard for background spawns only; interactive
  // spawns and Codex/OpenAI control-plane spawns are unchanged. OFF is the kill-switch
  // if the health predicate ever false-positives.
  AUTONOMOUS_SPAWN_GATEWAY_DISPATCH_GATE: "papercusp-autonomous-spawn-gateway-dispatch-gate",
  // queen-capacity-aware-dispatch-2026-06-22: gates the Queen's capacity-aware
  // dispatch (placement keyed on live fleet capacity). DEFAULT OFF — the
  // implementation is in-flight; flips ON at rollout after the :3170 verify.
  // KNOWN_DARK_FLAGS.
  QUEEN_CAPACITY_DISPATCH: "papercusp-queen-capacity-dispatch",
  // agent-tool-delta-protocol-2026-06-22 P-016 (D-007/D-008): gates the LLM-facing
  // SEMANTIC-delta opt-in (mode:delta merge responses) — the silent-wrong-merge
  // hazard the owner BUILD decision agreed to retire BY TEST. DEFAULT ON
  // (owner-directed flip 2026-06-22): enables the server capability ahead of the
  // delta-aware client (WI-514 — nothing sends _meta.delta yet, so it's INERT),
  // and the delta-gate (apps/operator/lib/release/delta-gate.ts) stays
  // warn-only/un-armed so it never blocks deploys. OFF ⇒ tools degrade to the
  // unconditionally-safe Lane-B behaviour (full | not_modified), never a semantic
  // delta — a reversible runtime kill-switch (host wiring: operator-core's
  // agent-tools/delta-flag-wiring.ts).
  TOOL_DELTA_PROTOCOL: "papercusp-tool-delta-protocol",
  // agent-tool-delta-protocol-2026-06-22 P-009 (Lane D): gates the SSE state-snapshot
  // DATA-CARRYING delta path (/api/operator/state-snapshot ?delta=1 → per-run card
  // add/update/remove deltas instead of whole snapshots). A DISTINCT surface from
  // TOOL_DELTA_PROTOCOL (the LLM tool-result delta) — proven by the state-delta
  // round-trip test, not the Lane-C LLM scenarios. OFF ⇒ full snapshots (today).
  STATE_SNAPSHOT_DELTAS: "papercusp-state-snapshot-deltas",
  // agent-tool-delta-client-rollout-2026-06-23 P-006: gates the sync RESOURCE rows-delta —
  // the UI's invalidate-driven re-fetch of plans.attention/plans.list sends a cursor and the
  // server replies with only the changed rows (the ~327GB/3d win). A reversible CUTOVER
  // kill-switch: OFF ⇒ no codec injected ⇒ full re-fetch (byte-identical). The owner flips it
  // ON after an attended running-desktop verify (the checksum/keep-stale guard degrades a wrong
  // merge to a refetch, never a wrong view).
  SYNC_RESOURCE_DELTA: "papercusp-sync-resource-delta",
  // queen-bee-spawn-reclaim-relaunch-2026-06-22 (EI-85 restart-kills): the boot
  // spawn-admission reconcile RE-LAUNCHES a reclaimed queen/bee whose durable
  // work-item is non-terminal, instead of marking it `failed` and losing the work.
  // A host restart kills in-flight spawns before their admission-release runs; the
  // reconcile frees the ceiling debit AND re-fires the survivor so a queen/bee
  // survives ANY host restart. DEFAULT ON (alpha flags-default-on) — the relaunch
  // is bounded (only non-terminal work, ceiling-gated re-fire) and reversible; OFF
  // ⇒ the legacy reclaim-to-`failed` behaviour, byte-identical.
  SPAWN_RECLAIM_RELAUNCH: "papercusp-spawn-reclaim-relaunch",
  // code-run-token-frugality (owner directive 2026-06-23): the INLINE batch nudge — when an agent
  // fires the SAME tool repeatedly in a session, attach a one-shot hint to its result steering it to
  // bundle the calls into one code:run. The STRUCTURAL complement to the CODE_RUN_NUDGE prompt prose
  // (hits the decision point, which beats prose for adoption). Additive (only adds a [batch-hint]
  // line, one-shot per session+tool, code:run-capable callers only); DEFAULT ON; OFF ⇒ no hint.
  CODE_RUN_BATCH_NUDGE: "papercusp-code-run-batch-nudge",
  // code-run-token-frugality FAN-OUT upgrade (owner directive 2026-06-26): the INLINE nudge's second
  // trigger — when an agent fires ≥4 DISTINCT tools in a short window (the "many-different-reads-once"
  // fan-out the same-tool-N× trigger was BLIND to; the 2026-06-26 audit found same-tool covered only
  // ~30% of multi-call SU spawns), attach a [batch-hint] with a ready-to-paste Promise.all skeleton
  // over the exact tools seen. Its OWN flag (NOT CODE_RUN_BATCH_NUDGE) so the new trigger is an
  // independent A/B knob: flip OFF and measure the adoption delta via the code-run-adoption metric.
  // Additive + reversible; DEFAULT ON; OFF ⇒ only the same-tool trigger fires.
  CODE_RUN_FANOUT_NUDGE: "papercusp-code-run-fanout-nudge",
  // agent-tooling-token-efficiency P-009 (2026-06-25): the SOFT orient-dedup nudge — when an agent
  // calls coord:plan-events / coord:inbox / memory:search / coord:declare-intent shortly after a
  // successful coord:orient (which already returned + declared exactly those), attach a one-shot
  // [nudge] line pointing it back at orient's payload. Never blocks; additive (only adds a line),
  // one-shot per session+subsumed-tool, time-windowed; DEFAULT ON; OFF ⇒ no nudge.
  ORIENT_DEDUP_NUDGE: "papercusp-orient-dedup-nudge",
  // work-item-deps-and-readiness-2026-06-22 P-007: make ISSUE-family work-items
  // (bug|change|task) self-pickable by the scheduler claim path. Today the
  // decentralized claim (claimNextWorkItem / getNextWorkItem) is feature-family-only —
  // the claim floors hard-code item_kind IN ('feature','research-task','chunk') and
  // UPDATE the feature view, so an issue can BLOCK a feature but can never itself be
  // claimed/placed; the Queen's steer levers (set_priority / co_locate) also report
  // applicable:false for issues. When ON, an ADDITIVE issue-claim branch (a separate
  // query over the work_items base for issue-family kinds, run only when no feature
  // is claimable) lets an UNBLOCKED issue be self-picked (readiness honored by the
  // SAME work_item_deps NOT EXISTS predicate; terminal = resolved/closed), and the
  // steer levers become applicable to issues. DEFAULT OFF — owner-authority: it
  // changes WHAT the autonomous fleet picks up (a brand-new dispatch source), so the
  // owner ratifies the flip. OFF ⇒ byte-identical to today (feature-only). KNOWN_DARK_FLAGS.
  SCHEDULER_ISSUES_CLAIMABLE: "papercusp-scheduler-issues-claimable",
  // psu-in-desktop-builds-2026-06-23 C1: exposes the `psu` superuser CLI as an
  // END-USER feature in the shipped desktop builds (the discoverable launch
  // entry + forcing the scoped `user` profile). DEFAULT OFF — this is the
  // legitimate owner-authority/SECURITY dark case (CLAUDE.md): psu opens a
  // superuser agent session, so the owner must personally ratify the end-user
  // exposure before it defaults on. OFF ⇒ the entry is not offered; the bundled
  // psu shim is inert (dev/internal launch is unchanged). KNOWN_DARK_FLAGS.
  PSU_END_USER: "papercusp-psu-end-user",

  // DEFAULT ON (derived FLAG_DEFAULTS; agent-first-onboarding-2026-07-03 P-003):
  // first-run lands on the agent-chat Onboarding Console (a full-window terminal
  // running the onboarding concierge → tutor handoff) instead of the GUI Setup
  // Wizard. Reversible cutover: OFF ⇒ byte-identical to today (first-run →
  // /setup); the GUI wizard stays reachable at /setup?force=1 either way.
  ONBOARDING_AGENT_FIRST: "papercusp-onboarding-agent-first",

  // DEFAULT OFF (owner-directed 2026-07-04, deterministic-onboarding-tutorial-2026-07-04
  // P-001): the onboarding tutorial references features whose backing implementation is
  // NOT ready yet — telemetry consent (anonymized crash reports), mobile pairing (pair a
  // phone for notifications / remote control), and the auto-update channel. This flag
  // gates those PREVIEW items: OFF ⇒ the tutorial + optional-setup flow omit them entirely
  // (what every fresh install sees), ON ⇒ testers see them to exercise the not-yet-shipped
  // surfaces. KNOWN_DARK_FLAGS (case: incomplete). Flip ON only to test the preview items.
  ONBOARDING_PREVIEW_FEATURES: "papercusp-onboarding-preview-features",

  // DEFAULT ON (owner-directed 2026-06-23, ship-papercusp-as-single-hive): on first
  // boot a PACKAGED desktop install clones github.com/Papercusp/papercup and creates
  // the `papercusp` dogfood hive (Papercusp building itself), then homes on it. Safe
  // default-on — it no-ops without gh auth or a local repo and retries on the next
  // boot, so it can never break a fresh launch. OFF ⇒ the app boots with no default
  // hive (bare onboarding). The repo is too large to bundle (~5GB) → clone-on-boot.
  DOGFOOD_PAPERCUSP_HIVE: "papercusp-dogfood-papercusp-hive",
  // DEFAULT ON (owner-ratified 2026-06-24, after the single-device smoke): announce
  // the dogfood `papercusp` hive as a SHARED P2P hive on install, under a PER-OWNER
  // identity (Solution C). The hive keypair + invite secret live in a per-owner
  // PRIVATE GitHub gist (never baked into the binary — a stranger who installs the
  // app can't get them), are injected into the keychain so all of the owner's
  // devices share ONE hive identity, and an owner-signed allowlist policy admits
  // ONLY the owner's own GitHub login (strangers refused). Best-effort + non-fatal:
  // no gh auth → no-op + retry next boot, so it can never break a fresh launch.
  // Flow: agent-insights/papercusp-shared-hive-per-owner.
  DOGFOOD_PAPERCUSP_HIVE_SHARE: "papercusp-dogfood-papercusp-hive-share",
  // DEFAULT ON (alpha flags-default-on): the shared embed-TPM admission lane
  // (watchdog-and-exposed-systems-improvement-2026-06-18 P-002). Routes BOTH embed paths
  // (search:semantic/work_items:search + memory:*) through ONE RateLimitGovernor whose
  // itpm + concurrency caps hold aggregate OpenAI embed rate UNDER the org 1M-TPM ceiling, so
  // the high-volume bench path can't exhaust the org and starve production memory (the
  // 2026-06-17 incident root cause, D-003). Bench sheds → BM25; memory passes through. Safe
  // default-on — additive + reversible; OFF ⇒ a byte-identical passthrough (ungoverned, the
  // pre-P-002 behaviour). The kill-switch if admission ever mis-paces a hot path.
  EMBED_ADMISSION: "papercusp-embed-admission",
  // DEFAULT OFF (enforce-system-on-generic-work-2026-06-29 P-006): the TEST-COMPLETION GATE on
  // work_items:complete — a feature work-item moved to a terminal state must have its plan-derived
  // test-requiring VALs passing (reuses the harness-test-rollup). SHIPPED DARK until the
  // done-without-test watchdog (P-009) confirms no false refusals on the fleet. OFF ⇒ completion is
  // byte-identical to today (the gate is never consulted). FAIL-OPEN even when ON. KNOWN_DARK_FLAGS.
  TEST_COMPLETION_GATE: "papercusp-test-completion-gate",
  // DEFAULT ON (enforce-system-on-generic-work-2026-06-29 P-019): the per-turn VERIFY-not-CREATE
  // work-item BACKSTOP behind the prompt directive (P-015). When a psu session ENDS A TURN having
  // edited workspace code but holds NO objective in the ledger (no in-execution work-item AND no
  // declared coord intent → coord:glance self.objective empty), the `workitem-verify-nudge` cc-hook
  // emits ONE short reminder to open a work-item (work_items:create / claim a plan item). It NEVER
  // creates anything — only reminds; fail-open + fire-and-forget + psu-gated, and per-TURN (not
  // per-edit — distinct from the rejected per-edit auto-capture hook). Safe default-on: additive +
  // reversible. OFF ⇒ the hook's nudge branch is inert (no reminder ever emitted); the cheap local
  // edit-marker touch is harmless either way. The owner kill-switch for the backstop.
  WORKITEM_VERIFY_NUDGE: "papercusp-workitem-verify-nudge",
  // DEFAULT ON (infra-perf-reliability-audit-round3-2026-06-19 P-013 / WI-345 F12):
  // the KILL leg of the test-webview reaper — actually SIGTERMs then SIGKILLs
  // papercusp-desktop processes whose PAPERCUSP_ADV_SESSION_ID session is ENDED
  // (agent-spawned test desktops that leaked after the test run finished). The detection
  // leg (toast notification) always runs when the routine fires; this flag gates the
  // OS-level process kill. The routine is SEEDED INACTIVE — the double-gate means this
  // flag being ON has no effect until an operator activates the routine. OFF ⇒ the action
  // runs detection-only (toast + log, no kills). The kill-switch if the reaper ever
  // mis-targets a process.
  TEST_WEBVIEW_REAPER: "papercusp-test-webview-reaper",
  // presence-coord-unification-2026-07-01 P-004 (WI-1347): the coord_presence RETENTION
  // reaper — a scheduled DBOS workflow that evicts `harness_shared.coord_presence` rows
  // that are (a) NOT wakeable (deriveSessionState's `ended` — no live standing wake await,
  // the same predicate coord:presence/fleet:status already use to distinguish `ended` from
  // `parked`) AND (b) past the TTL since their last heartbeat. A `parked` row (stale
  // heartbeat but still wakeable) is NEVER reaped regardless of age — only a genuinely
  // dead, unwakeable row is. Long-term history survives the delete via the append-only
  // fleet_membership_events ledger (WI-1345/migration 430) + adv_sessions — this flag only
  // gates the coord_presence ROW eviction. DEFAULT ON (alpha flags-default-on: finished,
  // tested, additive retention hygiene — no user-facing behavior change, only fewer
  // long-dead rows in the live roster). OFF ⇒ the reaper tick no-ops (today's behavior:
  // rows accumulate until the opportunistic 24h sweepStalePresence catches them).
  COORD_PRESENCE_REAPER: "papercusp-coord-presence-reaper",
  // federated-scout-gym-learning-2026-07-02 P-010 (F3-2): the fleet-wide KILL-SWITCH
  // for federated Scout↔gym ELITE/FACT sharing (island-model QD). Default ON (the
  // GITHUB_BRIDGE/P2P pattern — NOT in DARK_FLAGS): activation is STRUCTURAL, not the
  // flag. scout/federation-rollout.ts stages HOW FAR learning propagates in 3 tiers —
  // tier 1 HIVE-MEMBERS-ONLY (the existing F1 hive-scoped admission, the safe default),
  // tier 2 CROSS-HIVE gossip (CROSS_HIVE_GOSSIP_LANDED), tier 3 OPEN network behind the
  // P-009 reputation gate (REPUTATION_GATE_LANDED). Both prereq switches are false until
  // the machinery lands, so a default-ON flag can never over-share; the effective tier
  // clamps to 1 today. OFF ⇒ nothing federates (tier 0) — the instant off-switch.
  FEDERATED_SCOUT_LEARNING: "papercusp-federated-scout-learning",
  // DEFAULT ON (alpha flags-default-on; NOT in DARK_FLAGS). Gates the docs
  // "Ask a question" retrieval-augmented Q&A over the REAL /internal/docs —
  // POST /api/desktop/docs-qa, backing BOTH the terminal onboarding tutorial's
  // "Ask a question" and the Ctrl+/ search palette's ask mode. Replaces the old
  // shell-out-to-a-user-CLI Q&A (which died in a clean build and had no docs
  // tools). Runs server-side on the operator's configured backend + in-process
  // doc retrieval. OFF ⇒ the ask mode is hidden and the endpoint 404s (keyword
  // search still works); a clean instant kill-switch. (WI-2844.)
  DOCS_QA: "papercusp-docs-qa",
  // session-search-scope-2026-07-05: the episodic verbatim transcript index —
  // session_turns ingest (claude/omp/codex JSONL tailers + agent_chat sync,
  // search/session-ingest.ts), the session_turn/coord_message SearchSources,
  // and the fused sessions:search tool with session:'self' compaction
  // recovery. DEFAULT ON (alpha flags-default-on; NOT in DARK_FLAGS —
  // additive index + read tools, no behavior change to existing surfaces).
  // OFF ⇒ the ingest tick no-ops and sessions:search returns
  // feature_disabled; existing search:* scopes are unaffected. The instant
  // kill-switch if ingest volume ever misbehaves on a small host.
  SESSION_SEARCH: "papercusp-session-search",
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const ALL_FLAG_KEYS: readonly FlagKey[] = Object.values(FLAGS);

// ── DARK_FLAGS: the runtime registry of consciously default-OFF flags ─────────
// FLAG-DEFAULT INVERSION (enforce-system-on-generic-work-2026-06-29 P-011): a
// registered flag defaults ON; a flag defaults OFF iff it is listed here. This is
// the one source of truth for the dark set — FLAG_DEFAULTS is DERIVED from it
// (below) and production-defaults.test.ts SOURCES its allowlist from it. A NEWLY
// registered flag added to FLAGS but NOT here now defaults ON (previously a missing
// FLAG_DEFAULTS entry was a compile error). Default-OFF is permitted ONLY for one of
// the four DarkCase reasons — there is deliberately NO "finished, owner flips after
// verifying" case (finished + tested ⇒ ship ON, verify-then-flip in-task).
export type DarkCase = 'incomplete' | 'owner-authority' | 'cutover' | 'parked';
export const DARK_FLAGS: ReadonlyMap<FlagKey, { case: DarkCase; reason: string }> =
  new Map<FlagKey, { case: DarkCase; reason: string }>([
    // parked — deliberately out of V1 scope (built-or-not, simply not shipping yet)
    [FLAGS.CLOUDFLARE_PUBLISH, { case: 'parked', reason: 'cut for V1 — the Cloudflare publish surface is not shipping.' }],
    [FLAGS.HARNESS_PHASES, { case: 'parked', reason: 'cut for V1.' }],
    [FLAGS.DESIGN, { case: 'parked', reason: 'cut for V1.' }],
    [FLAGS.TESTING, { case: 'parked', reason: 'cut for V1.' }],
    [FLAGS.THE_HIVE, { case: 'parked', reason: 'restore-pot-lexicon-public-release-2026-07-04 (owner 2026-07-04): public release ships the Pot (Papercup) lexicon by DEFAULT. The `the-hive`/Swarm skin is BUILT and kept, but cut from public V1 — reachable only via the TESTING-gated BrandSwitcher (P-004). OFF ⇒ the classic/pot pack (the public default); ON ⇒ the bee skin for internal/testing use.' }],
    // TEST_COMPLETION_GATE graduated 2026-07-04 (dark-flag-age review, EI-7280):
    // enforce-system-on-generic-work-2026-06-29 P-014 verified it LIVE + enabled
    // (flags:get confirmed true) with zero blast radius (done-without-test watchdog
    // signalCount:0 across every tick since activation) — default ON.
    // incomplete — the code is not fully working / unverified on a path that matters
    [FLAGS.EXTERNAL_BENCH, { case: 'incomplete', reason: 'the external-bench grader adapter is incomplete (M2 in-container modality unbuilt) + infra-heavy (Docker/GB image pulls); dark until the P-009 ~50-task pilot proves the end-to-end path.' }],
    [FLAGS.CODEX_GATEWAY_OAUTH_PROXY, { case: 'incomplete', reason: 'WI-2198: the codex ChatGPT-subscription OAuth streaming reverse-proxy routes fleet codex agents through a REVERSE-ENGINEERED proprietary transport (chatgpt.com/backend-api/codex + auth.openai.com/oauth/token) that can only be verified by an owner-attended live canary against production ChatGPT. Dark until that canary passes; direct native auth is the live fallback. OFF ⇒ codex-cli accounts keep the exec bridge (byte-identical).' }],
    [FLAGS.ONBOARDING_PREVIEW_FEATURES, { case: 'incomplete', reason: 'owner-directed 2026-07-04 (deterministic-onboarding-tutorial P-001): gates onboarding-tutorial items whose backing feature is NOT ready — telemetry consent, mobile pairing (phone notifications / remote control), auto-update channel. OFF ⇒ a fresh install never sees them (the intended default); ON ⇒ testers exercise the preview surfaces. Graduates per-item as each backing feature ships.' }],
    // PER_HIVE_RELEASE_GATE graduated 2026-07-03 (per-hive-git D-008 canary met:
    // oddsmith green-checkpoint went green and FF'd oddsmith main — pipeline_events
    // 'advanced' 2026-07-03T15:16Z): default ON. A hive's gate engages only when
    // enabled AND a repo is configured, so hives without per-hive git stay byte-identical.
    // cutover — the flip needs every peer on the new wire first
    [FLAGS.PRESENCE_GOSSIP, { case: 'cutover', reason: 'presence moves off the peer-log onto ephemeral gossip (P-004, cross-machine-coord-parity). A gossip-only announcer is INVISIBLE to a log-only reader, so every hive peer must carry the reader before a writer flips. Owner flips after both dogfood machines update + a 2-machine presence-federation verify.' }],
    // QUEEN_WARM_SESSION graduated 2026-07-02 (owner flip directive): default ON —
    // queen wakes prefer the wake-executor warm resume with deterministic rebirth.
    // owner-authority — a privilege / security / destructive / autonomy surface the owner ratifies
    [FLAGS.OPEN_SIGNUP, { case: 'owner-authority', reason: 'SECURITY: /auth/signup is internet-reachable (cloudflared tunnel) — open signup mints real accounts. The zero-active-users bootstrap path keeps fresh installs working; owner flips ON after the auth-tier rollout.' }],
    [FLAGS.AUTH_CONFIG_OVERRIDES, { case: 'owner-authority', reason: 'OWNER-AUTHORITY escalation surface — auth:set_full_access_roles can WIDEN the all-gates bypass set. OFF ⇒ the auth-config sync-cache stays empty ⇒ every surface uses its baked literal (byte-identical); owner flips ON to ratify the dials.' }],
    [FLAGS.ACCEPT_DELEGATED_SEATS, { case: 'owner-authority', reason: 'OWNER-AUTHORITY / trust surface (agent-allocation-framework P-008, D-006) — lets a REMOTE fleet owner spawn agents on THIS host (within the host capability envelope). OFF ⇒ this host honors NO delegated-seat spawn requests (fail-closed; byte-identical to today). The contributing-host owner flips it ON per-host via /res or /admin/features to opt in. Permanently default-OFF (per-host opt-in), NOT a pending flip.' }],
    [FLAGS.WATCHDOG_AUTO_CLOSE, { case: 'owner-authority', reason: 'EI-7230: restores the flag\'s OWN documented intent (watchdog-and-exposed-systems-improvement-2026-06-18 P-009 — "DEFAULT OFF — auto-closing real improvement items autonomously is unsafe until the owner reviews"), which the P-011 flag-default-inversion migration (2026-06-29) silently flipped to effectively ON by omitting it from this allowlist — auto-close.ts\'s own live getFlag check meant the watchdog could have been silently auto-closing real improvement items in production with no owner review. OFF ⇒ escalate-only (today\'s intended, safe behavior); owner flips ON after reviewing the auto-close criteria.' }],
    [FLAGS.SUBSTRATE_SIDECAR, { case: 'incomplete', reason: 'WI-1994: same EI-7230/WATCHDOG_AUTO_CLOSE bug-fix class — this flag\'s OWN code comment above has always said "DEFAULT OFF — staged on :3170 FIRST; never :3070 until integration-verified... Listed in KNOWN_DARK_FLAGS" but was never actually added here, so post the 2026-06-29 P-011 inversion it silently derived default-ON. Live-evidenced harm (WI-1910): a fresh containerized-rig frame boots the dark substrate-sidecar path and the sidecar process dies exit 1 right after joining its topic (crash-loop respawn), the mechanism behind WI-1910\'s 0 peer_connected. WI-604 (the "complete + flip" umbrella feature) was separately deprecated 2026-07-03 — the full sidecar was never built out (stubbed replication spike only) — so there is no live plan driving this to a real default-ON graduation; it stays dark until one exists. OFF ⇒ in-process substrate boot, today\'s actually-running behavior on :3070.' }],
  ]);

// ── The dark allowlist's HYGIENE BOUNDS (re-review deadline + size ceiling) ────
// Promoted here from production-defaults.test.ts (enforce-system-on-generic-work-
// 2026-06-29 P-013) so SHIPPABLE code — the operator dark-flag-age watchdog — reads
// the same source of truth the guard test asserts against. The test still owns the
// ASSERTIONS (review-by not past, size <= watermark); it now IMPORTS these instead of
// re-declaring them, so the watchdog and the CI guard reason over one set of numbers.
//
//   DARK_FLAGS_REVIEW_BY    — the date the allowlist must be RE-REVIEWED by. Past it,
//                             walk every dark flag: flip what's ready (remove it from
//                             DARK_FLAGS), THEN push this date out with a fresh look —
//                             the bump is the LAST step, never the only one.
//   DARK_FLAGS_HIGH_WATERMARK — the post-sweep size ceiling; the dark set may only
//                             SHRINK below it. Raising it needs explicit owner sign-off.
//
// 2026-07-04 review (EI-7280, pushed the date out — the review is the point, not the
// bump): walked every non-owner-authority dark flag against its stated graduation
// condition. Ready + graduated: TEST_COMPLETION_GATE (verified live+enabled, zero
// blast radius). Checked + still genuinely not ready: EXTERNAL_BENCH (grader
// adapter incomplete, M2 unbuilt), CODEX_GATEWAY_OAUTH_PROXY (WI-2198, owner-
// attended canary not yet run), ONBOARDING_PREVIEW_FEATURES (backing features —
// telemetry consent, mobile pairing, auto-update channel — not shipped), PRESENCE_GOSSIP
// (cross-machine-coord-parity-and-trust-2026-07-01 P-108 replication-layer bug still
// WIP, blocking the D6 flip). owner-authority entries are the owner's call, not swept here.
export const DARK_FLAGS_REVIEW_BY = '2026-08-01';
export const DARK_FLAGS_HIGH_WATERMARK = 22;

// FLAG_DEFAULTS — DERIVED, not hand-written (P-011 inversion). Every registered flag
// defaults ON unless it is in DARK_FLAGS. Resolvers (server.ts getFlag / client.ts /
// resolveWithDefaults) read FLAG_DEFAULTS[key] unchanged.
export const FLAG_DEFAULTS: Record<FlagKey, boolean> = Object.fromEntries(
  ALL_FLAG_KEYS.map((k) => [k, !DARK_FLAGS.has(k)]),
) as Record<FlagKey, boolean>;

export type FlagValues = Record<FlagKey, boolean>;

export type FlagPayload = {
  flags: FlagValues;
  evaluatedAt: number;
  source: "posthog" | "defaults" | "override";
};

export function resolveWithDefaults(
  partial: Partial<Record<FlagKey, boolean>>,
): FlagValues {
  const out = { ...FLAG_DEFAULTS };
  for (const key of ALL_FLAG_KEYS) {
    const v = partial[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

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
  // channel (the participant-grid VideoGrid). OFF by default — ships dark until
  // the live two-instance camera E2E (P-010) passes on the real Tauri webview.
  VIDEO_CHANNELS: "papercusp-video-channels",
  // holepunch-voice-channels-2026-06-05 (P-015/D-014): gates the desktop P2P
  // VOICE-channel surface (VoiceChannelPanel — channel list/join/mute/meter +
  // mic capture/mix playback over the desktop voice bridge). OFF by default —
  // ships dark until the supervised live Tauri+mic pass (D-014) lands.
  VOICE_CHANNELS: "papercusp-voice-channels",
  // the-hive-lexicon-2026-06-06: selects the active brand pack for the
  // user-facing LEXICON layer (display strings only — code/DB/MCP/repos are
  // unchanged, D-001). ON (default, owner-activated 2026-06-09) = the `the-hive`
  // bee pack (Pot→Hive, Fleet→Colony, Queen=brain, Swarm = a deployment-to-instance
  // unit; D-007); OFF = the `classic` Papercusp pack. Fully reversible presentation
  // switch; @papercusp/lexicon resolves it.
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
  // fleet:spawn `tier` picks are honored (resolved + clamped to [role floor,
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
  // operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007): the idle-session
  // reaper. When ON, a periodic sweep marks DEAD-process open adv_sessions ended
  // (owner stopped heartbeating past the liveness grace), reclaiming the live
  // roster + unblocking session-dir-gc for them. DEFAULT OFF until proven on the
  // fleet (it ends session rows). Slice 1 only touches already-dead sessions; it
  // never terminates a live process (that's the follow-on slice).
  IDLE_SESSION_REAPER: "papercusp-idle-session-reaper",
  // operator-memory-and-psu-resilience-2026-06-14 P-011 / WI-152 (D-007): the
  // idle-session reaper's WRITE half — actually TERMINATING a LIVE-but-idle
  // session (the D-007 event-loop-saturation cohort: alive + heartbeating but no
  // genuine activity for the idle threshold, holding LISTEN conns + polling).
  // DOUBLE-GATED: the terminate sweep no-ops unless BOTH this flag AND the
  // sibling IDLE_SESSION_REAPER are on. DEFAULT OFF — DELIBERATE (the
  // explicit-owner-ask exception to alpha flags-default-on): this is a
  // DESTRUCTIVE, not-yet-proven reaper that Ctrl-C's then SIGKILLs a live
  // process; the slice-1 sibling is also dark. It only ever targets genuinely-
  // idle sessions (busy owners — claim / in-flight wake / running bee — are
  // excluded); a terminated wake-armed session is safe because the wake-executor
  // --resumes it. OFF ⇒ a pure no-op. Owner flips ON only after a live
  // --dry-run proof on the fleet. Listed in KNOWN_DARK_FLAGS.
  IDLE_SESSION_REAPER_TERMINATE: "papercusp-idle-session-reaper-terminate",
  // EI-316 (hive completion split-brain): when ON, work_items:create refuses a
  // title that embeds an existing OPEN work-item id (the "WI-118: …" mirror
  // signal) — the creator must work the given id, not fork a duplicate it then
  // completes while the original strands in `validating`. force:true overrides
  // per-call. OFF = the kill-switch if the guard ever false-positives.
  WORK_ITEM_MIRROR_GUARD: "papercusp-work-item-mirror-guard",
  // EI-309 (Queen frontier-blind wake wedge): when ON, hive:declare-wake refuses
  // an event-only/none declaration (no time component) while the home harness has
  // unplaced todo work items — forcing the Queen to place them or arm a time-wake
  // instead of sleeping on phantom self-claim. force:true overrides per-call.
  // OFF = the kill-switch if the guard ever wrongly blocks a declaration.
  HIVE_WAKE_FRONTIER_GUARD: "papercusp-hive-wake-frontier-guard",
  // learning-packs-2026-06-11 (P-005): seeding a new hive's mem0 store with the
  // selected learning pack at hive:create, plus the learning_packs:* management
  // verbs and the Learnings UI surfaces. OFF skips seeding + hides pack
  // management; the hive:<slug> memory scope itself stays live (recall of an
  // unseeded pool is harmless).
  LEARNING_PACKS: "papercusp-learning-packs",
  // per-hive-learning-loops-2026-06-14 (P-020, D-003/D-008): provisioning a
  // per-HIVE learning loop at hive:create — a DARK gym_autoloop_config row
  // (enabled:false, budget:null) + an INACTIVE scout routine under the hive's
  // own install_slug (NOT @singleton). Both ship inert: the gym tick doubly
  // refuses a disabled+unbudgeted row, and an inactive routine never fires —
  // the owner arms each via the gym/routines UI. Flag-gated + best-effort: a
  // provision failure warns and reports, never fails the create. OFF skips
  // provisioning (a hive still works; it just has no per-hive loop until armed
  // by hand). The matching hive:dissolve teardown is P-021.
  PER_HIVE_LEARNING_LOOPS: "papercusp-per-hive-learning-loops",
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
  // hive.controlState; writes via hive:start / hive:pause. DEFAULT ON (alpha
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
  // its routine/rule, and (c) the Sentinel UI pane. DEFAULT OFF —
  // DELIBERATE (NOT the alpha flags-default-on policy): a brand-new, not-yet-proven
  // AUTONOMOUS role that nudges the running fleet. A confused sentinel must not be
  // able to thrash the system it protects, so it ships dark until its first live run
  // on staging proves it. The owner flips it ON after that proof — surfaced loudly in
  // the plan's ## Now + every lane report.
  SENTINEL: "papercusp-sentinel",
  // sentinel-as-herald-2026-06-21 Phase 5 (P-018..P-022): gates the SERVER-SIDE
  // proactive "decide to speak" sweep — the voice-host periodic tick that lets the
  // Sentinel Herald speak out-of-band (a role:'sentinel' converse turn with trigger
  // 'sentinel_scan', TTS'd + pushed via broadcastOpVoice) with NO desktop UI open,
  // or routes a salient alert via attention-push + hindsight when no live voice
  // session exists. DEFAULT OFF — DELIBERATE (mirrors SENTINEL; NOT the alpha
  // flags-default-on policy): a brand-new autonomous speak loop that must not thrash
  // the user. Triple-gated on top of the flag: humanFacingRole==='sentinel' AND not
  // DND/paused/over-budget AND the voice-host owns the lease (single-owner). OFF ⇒
  // the sweep no-ops every tick (live voice + browser-provider proactive ticks are
  // byte-for-byte unchanged). The owner flips it ON after its first live staging run.
  // KNOWN_DARK_FLAGS.
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
  // OFF + the routine is seeded INACTIVE (double-gated, like idle-session-reaper): an
  // unverified bee-lifecycle change; bring up dry-run first, then flip.
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
  // resolve behind it. DEFAULT OFF (dark): OFF ⇒ the notImplemented crypto stub, no
  // encryption, byte-identical to today. KNOWN_DARK_FLAGS. Owner flips ON only after the
  // live cut-off witness (P-008) passes on the real binary.
  HIVE_REKEY: "papercusp-hive-rekey",
  // loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5 / P-008): the master gate for
  // engine-managed LOOPS — the tracked replacement for Claude /loop (loop:arm re-wakes a
  // warm su session N sec after each turn settles). DEFAULT OFF (dark) because the loop
  // engine is multi-part (B-LOOP-1 schema + B-LOOP-2 completion-rebase + B-LOOP-3 warm-wake
  // fire) and the end-to-end warm-wake round-trip is not yet verified green — arming a loop
  // before the fire lands would create a routine that never wakes. OFF ⇒ loop:arm refuses
  // (loop:end/loop:status always work); inert otherwise (no loop rows exist). KNOWN_DARK_FLAGS.
  // Owner flips ON once the B-LOOP-1..5 chain is green + the manual warm-loop e2e passes.
  LOOPS: "papercusp-loops",
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
  // NOT EXISTS subquery. Behavior-identical; a performance cutover. DEFAULT OFF: the sidecar is built +
  // live + verified, but default-ON makes work_item_blocked a HARD claim dependency (any env without
  // mig 379 errors), so the flip is a coordinated cutover. KNOWN_DARK_FLAGS 'cutover'.
  SCHEDULER_MAINTAINED_READY: "papercusp-scheduler-maintained-ready",
  // gateway-priority-tiers-2026-06-22: gates the inference-gateway priority-tier
  // queueing/admission path. DEFAULT OFF — the implementation is in-flight; flips
  // ON at rollout after the :3170 verify. KNOWN_DARK_FLAGS.
  GATEWAY_PRIORITY_TIERS: "papercusp-gateway-priority-tiers",
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
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  // DEFAULT ON (alpha flags-default-on): the shared embed-TPM admission lane (P-002). Additive +
  // reversible; OFF ⇒ ungoverned passthrough (pre-P-002 behaviour). See FLAGS.EMBED_ADMISSION.
  [FLAGS.EMBED_ADMISSION]: true,
  // DEFAULT ON (alpha flags-default-on): the bee fresh-context warm-inject fork — a
  // drained bee warm-injected a NEW work-item re-routes to a FRESH spawn (fresh session
  // + dossier + checkpoint hydration tail) instead of `--resume`-ing its ~138K/turn grown
  // transcript (bee-context-efficiency-2026-06-14 P-005 / D-018/D-021; WI-593). Flipped ON
  // 2026-06-23 after live verification (real executeWake + real getFlag → channel
  // fresh-context-warm-inject, never --resume; carry-seam oracle + 14 fork tests green).
  // Fail-soft: any spawn over-cap / error falls through to legacy `--resume` (never strands
  // a wake); within-task wakes PARK upstream so the fork only ever fires at a task boundary.
  [FLAGS.BEE_FRESH_CONTEXT_WARM_INJECT]: true,
  // DEFAULT ON (alpha flags-default-on) — additive precomputed work-item dossier in the
  // spawn/wake-hydration volatile tail (P-008/P-009). Bounded + fail-soft; OFF ⇒ no
  // dossier section (the agent uses its read tools), otherwise behavior-neutral.
  [FLAGS.BEE_WAKE_DOSSIER]: true,
  // DEFAULT OFF (P-013): the bee transcript-cap recycle sweep — an unverified bee-lifecycle
  // change, double-gated (this flag OFF + the routine seeded INACTIVE). OFF ⇒ a no-op
  // (the sweep logs the over-cap cohort but recycles nothing). KNOWN_DARK_FLAGS.
  [FLAGS.BEE_TRANSCRIPT_CAP]: true,
  // DEFAULT OFF (P-009): the watchdog auto-close sweep. OFF ⇒ escalate-only (today's
  // behavior, byte-identical). Owner flips ON after reviewing the guards. KNOWN_DARK_FLAGS.
  [FLAGS.WATCHDOG_AUTO_CLOSE]: true,
  // DEFAULT ON — owner-authorized 2026-06-18 (re-flipped once the P-008 prerequisite was MET).
  // su persona via the blueprint prompt-resolve chain (P-006): base/su.md + client overlay + the
  // spliced CLAUDE.md + the papercup-hive su INSTANCE OVERRIDE (source: apps/operator/prompts/
  // hive-instances/papercup-hive.su.md, seeded to hive_settings promptOverride.su) carrying the
  // Papercusp operational specifics (workspace map / :3070-:3170 / tool surface / named workflows).
  // OFF ⇒ legacy renderSuPlaybook (byte-identical). The seeded instance override is what makes default-ON safe.
  [FLAGS.SU_BLUEPRINT_PERSONA]: true,
  // DEFAULT ON — owner-authorized 2026-06-18 (runtime-flipped + "proceed with all deferred items").
  // Replace the Claude base via --system-prompt-file (P-013/P-014); resolveReplacementSystemPrompt
  // composition-tested + validated by live runtime spawns (a queen ran a 224s real turn with it on).
  // OFF ⇒ legacy stdin/append (byte-identical). Full e2e smoke infra-gated (EI-1433); reversible.
  [FLAGS.REPLACE_CLAUDE_BASE]: true,
  // DEFAULT ON — activated 2026-06-15 (owner authorization, plan-implementation-framework P-010).
  // The convert-at-pickup compiled-brief path (P-003). The framework bake-off runs concurrently to
  // validate it; a 'regressed' verdict auto-reverts it off (autoRevertOnRegression / P-015).
  [FLAGS.COMPILED_BRIEFS]: true,
  // DEFAULT ON — activated 2026-06-15 (owner authorization). Proactive placement admission (P-002).
  // The bake-off validates concurrently; a 'regressed' verdict auto-reverts it off (P-015).
  [FLAGS.TOUCH_SET_EXCLUSION]: true,
  // DEFAULT ON — an additive OPT-IN tool (work_items:amend): enabling exposes the tool; it changes
  // NO existing behavior (an agent must call it). Activated 2026-06-15 (owner authorization,
  // plan-implementation-framework P-010). The bake-off still measures it; it does not GATE an
  // additive surface. (The behavior-CHANGING bets — compiled-briefs / touch-set-exclusion — stay
  // dark until the owner runs the bake-off.)
  [FLAGS.WORKITEM_AMEND]: true,
  // DEFAULT ON — an additive OPT-IN tool (work_items:expand): same rationale as work_items:amend —
  // enabling exposes the tool, changes no existing behavior. Activated 2026-06-15.
  [FLAGS.DEFERRED_EXPANSION]: true,
  // DEFAULT ON (alpha flags-default-on) — additive hive-control surfacing.
  [FLAGS.HIVE_CONTROL]: true,
  // DEFAULT ON (alpha flags-default-on) — additive read-only Health dashboard +
  // its fail-soft `health.snapshot` resolver/tick (system-health-tab-2026-06-15).
  [FLAGS.SYSTEM_HEALTH_TAB]: true,
  // DEFAULT ON (alpha flags-default-on) — additive read-only /admin/schedules
  // inventory view (schedule-inventory-and-ephemeral-tier-2026-06-26 P-003).
  [FLAGS.SCHEDULE_INVENTORY]: true,
  // DEFAULT ON — fresh-context interactive brain (reversible to D-013).
  [FLAGS.QUEEN_BRAIN_FRESH]: true,
  // DEFAULT ON (alpha flags-default-on) — a complete presentation switch: the nested
  // hive→plan steering picker over the unchanged persisted shape. OFF = legacy flat lists.
  [FLAGS.STEERING_HIVE_TREE]: true,
  // DEFAULT ON (graduated 2026-06-23, WI-599) — the per-workspace coordination
  // cutover (F-C1). Reversible kill-switch; OFF = the legacy `default`-pinned coord
  // (byte-identical, old history preserved). Flipping the CODE DEFAULT is the actual
  // fix for the live writes-to-'default' symptom: log.ts caches coordPerWorkspaceOn
  // at boot via getFlag(systemDistinctId), which fell through to this false default
  // (D-006); with it true the boot resolution is true so coord routes per active
  // workspace. Migrations 361 + 391 re-stamp the 'default' coord history onto
  // papercusp-workspace so the cutover restart doesn't strand in-flight
  // inboxes/read-positions/escalations. Set false to revert.
  [FLAGS.COORD_PER_WORKSPACE]: true,
  // DEFAULT ON (flipped 2026-06-22, owner-directed): per-workspace engineer-issues cutover.
  // Reversible kill-switch; the old `default`-partition issues are preserved so a flip-off restores them.
  [FLAGS.ISSUES_PER_WORKSPACE]: true,
  // DEFAULT ON (graduated 2026-06-23, owner-directed verify+flip WI-597): lease mechanism
  // (acquire/heartbeat/expiry-steal) + recovery layer (stale-claim reaper requeues mid-flight
  // items + covers the issue family) verified green; reversible kill-switch (OFF = local
  // SELECT … FOR UPDATE SKIP LOCKED). Removed from KNOWN_DARK_FLAGS per the shrink-only rule.
  [FLAGS.WORKITEM_CLAIM_LEASE]: true,
  // DEFAULT ON (graduated 2026-06-23, owner-attended cutover) — routines upsert arbitrates ON
  // CONFLICT on the (id) PK when ON vs the equivalent (install_slug,name) unique when OFF. Since
  // id is derived deterministically from (install_slug,name), the two are byte-identical +
  // idempotent + both preserve workspace_id (the EI-2019 anti-clobber fix). Reversible.
  [FLAGS.ROUTINES_PER_WORKSPACE]: true,
  // DEFAULT OFF (deliberate) — ui:dispatch/get_state cross-workspace guard, reversible;
  // OFF = today's behavior (no check), byte-identical. KNOWN_DARK_FLAGS.
  [FLAGS.UI_WORKSPACE_GUARD]: true,
  // DEFAULT OFF (deliberate, NOT alpha default-on) — the scoped-superuser workspace clamp
  // changes auth enforcement for every superuser session; reversible kill-switch the owner
  // FLIPPED ON 2026-06-23 (owner-directed, psu-in-desktop-builds D-002): a full-tool
  // end-user psu session must stay confined to its own workspace, and the clamp is the
  // only boundary once the scoped profile is dropped. Was the reversible cutover
  // kill-switch (default-off); the owner flipped it. Reversible — set false to revert.
  [FLAGS.SCOPED_SUPERUSER_CLAMP]: true,
  // DEFAULT OFF (deliberate, NOT alpha default-on) — the shared workspace-scoped-coordination
  // re-key (Queen + Scout per-hive→workspace) is a hot-path live-loop change; reversible
  // workspace-scoped Queen+Scout+Overwatch. Graduated to default-ON 2026-06-23 (owner-directed flip)
  // after Phase A/B/C built + unit-tested (OFF was byte-identical). Hot-path cutover — watched live.
  [FLAGS.WORKSPACE_COORDINATION]: true,
  [FLAGS.CLOUDFLARE_PUBLISH]: false,
  [FLAGS.HARNESS_PHASES]: false,
  [FLAGS.DESIGN]: false,
  [FLAGS.TESTING]: false,
  // DEFAULT ON (WI-594, 2026-06-23): inbox-cards-unification Phase D is IMPLEMENTED + wired
  // end-to-end (onCard → openEscalation durable PG write → coord:resolve → unblockLinkedCard
  // resumes the blocked agent) and live-verified (plan D-009 round-trip; ran ON in
  // papercusp-workspace via a stored runtime override). Flipped to default-ON, removed from
  // KNOWN_DARK_FLAGS. OFF would revert to the in-memory-only ctx.askUser card (lost on restart).
  [FLAGS.INBOX_DURABLE_ESCALATIONS]: true,
  // DEFAULT OFF — unverified cutover (needs the 2-machine merge proof, P-008). Off = plans federate as today.
  [FLAGS.PLAN_PART_FEDERATION]: true,
  [FLAGS.PLAN_ATTRIBUTION_BADGES]: true,
  // DEFAULT-ON (owner-directed): the hive role-tier owner-action gate enforces
  // immediately. Kill-switch — OFF reverts to the prior root-only/source gates.
  [FLAGS.HIVE_ROLE_TIERS]: true,
  // OFF by default — the self-improvement loop captures + triages with this off;
  // auto-implementation only begins once an owner flips it (see the flag note above).
  [FLAGS.IMPROVEMENT_AUTO_IMPLEMENT]: true,
  // ON by default (alpha flags-default-on policy) — pure observability: a
  // status chip + transition-only notifications; nothing else rides it.
  [FLAGS.LEARNING_INFRA_HEALTH]: true,
  // ON by default — owner-activated 2026-06-09 (alpha flags-default-on policy);
  // the live two-instance camera E2E (holepunch-video P-010) is still outstanding
  // but the owner chose to run it live (same call as VOICE_CHANNELS below).
  [FLAGS.VIDEO_CHANNELS]: true,
  // ON by default — owner-activated 2026-06-09 (alpha flags-default-on policy);
  // the supervised live Tauri+mic pass (holepunch-voice-channels D-014) is still
  // outstanding but the owner chose to run it live.
  [FLAGS.VOICE_CHANNELS]: true,
  // ON by default — owner-activated 2026-06-09 (alpha flags-default-on policy):
  // the bee lexicon (the-hive-lexicon-2026-06-06) is the live identity; classic
  // remains the flag-off fallback. Presentation only, fully reversible.
  [FLAGS.THE_HIVE]: true,
  // ON by default — owner-activated 2026-06-09 (alpha flags-default-on policy);
  // the schema-driven BlueprintSettingsPanel (blueprint-aware-harness-ui P-008)
  // goes live ahead of the Tauri visual pass; the legacy panel remains behind flag-off.
  [FLAGS.BLUEPRINT_AWARE_SETTINGS]: true,
  // ON by default — owner-activated 2026-06-09 (alpha flags-default-on policy);
  // Prompt Studio (blueprint-aware-harness-ui P-011) is mounted + hardened
  // (loopback + 512KB cap + whitelist); the Tauri visual pass is still outstanding.
  [FLAGS.PROMPT_STUDIO]: true,
  // ON by default — owner-activated 2026-06-09 (alpha flags-default-on policy).
  // Phases 2-5 of hive-agent-tabs-psu-tui-2026-06-09 are still building; the
  // shipped flag-gated paths (taxonomy/roster stamping/session-id) go live now.
  [FLAGS.HIVE_AGENT_TABS]: true,
  // OFF by default — DELIBERATE (not the alpha flags-default-on policy). Enabling this
  // reroutes every bee's inference egress through the gateway service; flipping it before
  // the service is deployed would break the whole fleet's auth. Owner flips it ON after
  // deploy + the P-015 load test passes. Surfaced loudly in the plan's Now + completion report.
  [FLAGS.INFERENCE_GATEWAY]: true,
  // OFF by default — DELIBERATE (inference-gateway-multi-credential-routing P-009):
  // multi-credential routing changes egress/credential selection; the flip is gated
  // on billed API keys registered + a real multi-key run (D-001). OFF = the single
  // bound-credential gateway, byte-identical to today.
  [FLAGS.INFERENCE_GATEWAY_MULTI_ACCOUNT]: true,
  // ON by default — owner decision D-006 (2026-06-11): wedge auto-reap ships live.
  [FLAGS.WEDGE_AUTO_REAP]: true,
  // ON by default (alpha flags-default-on policy): the credential reconciler is
  // the fix for the live every-terminal-relogin cascade; it is monotonic
  // (newest-wins, never deletes) and a converged tree produces zero writes.
  [FLAGS.CLAUDE_CRED_SYNC]: true,
  // OFF by default — SECURITY exception to the alpha default-ON policy: open
  // signup on an internet-facing box mints real accounts. The zero-active-users
  // bootstrap path in the signup route keeps fresh installs working regardless.
  [FLAGS.OPEN_SIGNUP]: false,
  // ON by default (alpha flags-default-on policy / hive-from-github-url P-011):
  // the backend (P-006..P-010) shipped tested; the picker entry goes live with
  // it. OFF = the GitHub-URL card reverts to the coming-soon stub.
  [FLAGS.HIVE_FROM_GITHUB_URL]: true,
  // ON by default (owner-approved Wave-1 rollout 2026-06-10): loopback-tier
  // enforcement at the route dispatch chokepoint. OFF = emergency revert.
  [FLAGS.ENDPOINT_AUTH_TIERS]: true,
  // ON by default (alpha flags-default-on policy): the queen's tier picks are
  // floor/ceiling-clamped, so the safety envelope holds with the flag on; OFF
  // is the kill-switch if her judgment misfires.
  [FLAGS.QUEEN_TIER_SELECTION]: true,
  // ON by default (alpha flags-default-on policy + EI-322 security fix): the
  // transport ALWAYS signs and cross-machine authority RPC is not yet wired in
  // production (no peer addressing), so enabling enforcement now hardens the
  // surface with zero live-traffic risk. OFF is the cross-machine rollout lever
  // (deploy signing everywhere, THEN this stays/comes on) and the emergency
  // revert if a real unsigned peer must be tolerated.
  [FLAGS.AUTHORITY_RPC_SIGNED]: true,
  // DEFAULT ON (graduated 2026-06-23, WI-607): the option-(c) Hyperswarm-mux RPC
  // transport is wired AND its cross-machine lock-serialization path is now proven
  // over a REAL Hyperswarm wire — two real peers on a real testnet DHT, the
  // papercusp/authority-rpc protomux channel on the same real per-socket muxer as
  // announce, a contended lock serialized at ONE authority NOT fail-open
  // (authority-rpc-swarm-real-wire.test.ts, clearing the P-003 / D-003 gate). The
  // identical Hyperswarm connection + muxer stack is already proven cross-host for
  // the sibling channels (announce two-peer, cross-hive, the Hetzner eviction over
  // the same connection). Composes with the HTTP transport (addressable peers) and
  // fails open (D-004), so any residual cross-host latency is merge-churn-only,
  // never data loss.
  [FLAGS.AUTHORITY_RPC_PROTOMUX]: true,
  // DEFAULT OFF (dark): the φ+SWIM eviction probe's live cross-machine path rides
  // the (also-dark) protomux transport and is real-hardware-unverified (D-003,
  // P-003 two-machine proof). OFF = staleness-only authority selection,
  // byte-identical to pre-P-016. Listed in KNOWN_DARK_FLAGS; flip gated on the
  // two-machine eviction proof.
  [FLAGS.AUTHORITY_EVICTION_PROBE]: true,
  // DEFAULT ON (alpha flags-default-on): the peer-log compaction mechanism +
  // fold-from-snapshot correctness are proven single-box AND the real-wire
  // replay-cost saving (Hypercore sparse-fetch) + cross-machine convergence are
  // now proven on real 2-machine Hetzner frames (substrate-peer-log-compaction
  // -2026-06-13 D-008: a fresh joiner converged with contiguousLength=0 vs the
  // from-start reader's full 4602 over real NAT/WAN/holepunch). P-008 gate cleared.
  [FLAGS.SUBSTRATE_LOG_SNAPSHOT]: true,
  // DEFAULT ON (2026-06-25) — P-009 substrate sidecar verified on the packaged
  // 2-machine fed-a/fed-b rig: the relocated engine spawns + hosts the substrate
  // (no in-process fallback) on both peers. The packaged-build non-engagement bug
  // (CWD-relative socket + npx-tsx-in-bundle) is fixed in substrate-sidecar-spawn.ts.
  [FLAGS.SUBSTRATE_SIDECAR]: true,
  // DEFAULT OFF — P-011 idle-session reaper ends adv_session rows; off until proven on the fleet.
  [FLAGS.IDLE_SESSION_REAPER]: true,
  // DEFAULT OFF — P-011 / WI-152 (D-007) terminate half: Ctrl-C + SIGKILL of a LIVE-but-idle
  // session. Destructive + double-gated (no-op unless IDLE_SESSION_REAPER is ALSO on); off until
  // a live --dry-run proof. The explicit-owner-ask exception to alpha flags-default-on.
  [FLAGS.IDLE_SESSION_REAPER_TERMINATE]: true,
  // ON by default (alpha flags-default-on policy + EI-316 correctness fix): the
  // guard fires only on a title that embeds an id resolving to a live OPEN
  // work-item — a near-zero-false-positive signal — and force:true is the
  // per-call escape hatch. OFF is the fleet-wide kill-switch.
  [FLAGS.WORK_ITEM_MIRROR_GUARD]: true,
  // ON by default (alpha flags-default-on policy + EI-309 correctness fix): the
  // guard fires only when a no-time-component wake is declared with a non-empty
  // unplaced frontier — a genuine wedge condition — and force:true overrides.
  // OFF is the kill-switch.
  [FLAGS.HIVE_WAKE_FRONTIER_GUARD]: true,
  // ON by default (alpha flags-default-on policy + owner-ratified D-003 on
  // slash-exposure-tool-catalog-2026-06-12): the full visible tool catalog
  // projects as slash commands; per-tool expose.slash:false and this flag are
  // the two scale-down levers.
  [FLAGS.SLASH_EXPOSURE]: true,
  // ON by default (alpha flags-default-on policy, learning-packs D-007 plan):
  // new hives seed the selected learning pack; OFF skips seeding + hides the
  // pack-management surfaces.
  [FLAGS.LEARNING_PACKS]: true,
  // ON by default (alpha flags-default-on policy): the work is finished, and what
  // it provisions ships DARK — a disabled+unbudgeted gym row + an inactive scout
  // routine, both inert until the owner arms them (D-003). So this is NOT under
  // the frontier D-001 dark-ship rule (that gates loops that would SPEND on flip);
  // flipping THIS flip only governs whether the inert rows get laid down at
  // create. OFF skips per-hive provisioning entirely.
  [FLAGS.PER_HIVE_LEARNING_LOOPS]: true,
  // ON by default — Phase 0 foundation record-keeping (self-learning-frontier
  // P-004/FB-02): append-only attribution rows, no LLM spend, no queue filing.
  // Deliberately NOT under the plan's D-001 dark-ship rule (that covers the
  // frontier LOOPS; the EKG/ablation need this history accumulating before
  // they arm). OFF is the kill-switch.
  [FLAGS.CHANGE_LEDGER]: true,
  // OFF by default — DELIBERATE (the frontier program's D-001 owner-ratified
  // exception to the alpha default-ON policy): every frontier learning loop
  // ships built + tested + DARK, arming only when self-learning-frontier
  // P-001 closes (consume-edges P-013 live proof + owner ratification). The
  // pending flip is surfaced in the plan's ## Now + every lane report.
  // ON by default (owner-directed flip 2026-06-23, after verify) — the master
  // "reclaim STALLED, not just dead" switch, now arming BOTH legs:
  //   (a) work-item claims — frees a LIVE-but-non-progressing holder's claim
  //       (agent-activity-liveness-truth P-003, reconciler `includeStalled`); and
  //   (b) spawned_agents rows — durably reaps a supervised-LIVE-but-stream-silent
  //       WEDGED bee (BRIEF D: the DB-truth `reclaimWedgedSpawns` floor over the
  //       in-memory wedge reaper, action threshold WEDGE_REAP_SILENT_MS=30min).
  // Both are reversible kill-switches: OFF returns to the dead-holder +
  // confirmed-terminal-spawn legs only (byte-identical to the pre-flip behaviour).
  // The wedged leg matches the already-live in-memory reaper's threshold, so the
  // incremental risk of ON is bounded; flip OFF at /admin/features if it misbehaves.
  [FLAGS.RECLAIM_STALLED]: true,
  // DEFAULT ON (WI-596, 2026-06-23) — lazy/bounded substrate boot, v1. When ON, the
  // eviction reaper (substrate-eviction-reaper.ts) tears down idle, INERT private
  // (swarm-less, peerless) harness engines via the pure planSubstrateEviction policy,
  // bounding operator RSS sub-linearly in harness count. SAFE-BY-CONSTRUCTION: a harness
  // with a live swarm (`handle.swarm != null`) or any admitted remote peer is treated as
  // pinned/active-peer and is NEVER evicted, so v1 can never strand a federating harness
  // (the EI-126 data-divergence class is off the table for v1) — and an evicted engine
  // re-boots on access (getBootedHarness reboot-on-access) or on its next boot-all
  // reconcile. The harder slice — evicting idle SHARED harnesses while a lightweight
  // swarm-presence keepalive re-boots them on a later peer connection (D-004) — is the
  // v2 follow-up and is OUT of v1's eviction set. OFF = byte-identical eager boot.
  [FLAGS.LAZY_SUBSTRATE_BOOT]: true,
  [FLAGS.NEGATIVE_SPACE_MINER]: true,
  // OFF by default — same D-001 dark-ship rule as NEGATIVE_SPACE_MINER above:
  // frontier learning loops arm only when self-learning-frontier P-001 closes
  // (the flag flip + an owner-set governor budget are the arming acts).
  [FLAGS.NEOLOGISM_MINER]: true,
  // OFF by default — same D-001 dark-ship rule as the miners above: the
  // replay harness is a frontier learning loop (LLM spend); flag flip + an
  // owner-set governor budget (registerReplayLoop) are the P-001 arming acts.
  [FLAGS.REPLAY_HARNESS]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: regret
  // mining is a frontier learning loop (its replay leg spends LLM tokens);
  // the flag flip + an owner-set governor budget on loop `regret-mining`
  // are the P-001 arming acts.
  [FLAGS.REGRET_MINING]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: the
  // transfer harness is a frontier learning loop (distillation + replay
  // batteries spend LLM tokens); the flag flip + an owner-set governor budget
  // on loop `frontier:transfer-harness` are the P-001 arming acts.
  [FLAGS.TRANSFER_HARNESS]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: the Fleet
  // EKG is a frontier loop (zero LLM spend, but its alarm side files into the
  // attention rail); the flag flip + an owner-set governor budget on loop
  // `fleet-ekg` are the P-001 arming acts.
  [FLAGS.FLEET_EKG]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: prompt
  // sedimentology is a frontier loop spending real LLM tokens per weekly
  // cycle (SUT + sim + judge across both arms); the flag flip + an owner-set
  // per-cycle governor budget on loop `prompt-ablation` + activating the
  // seeded-inactive routine are the P-001 arming acts. Shadow-only either
  // way: this lane never mutates live prompts.
  [FLAGS.PROMPT_ABLATION]: true,
  // OFF by default — D-001 dark-ship: the Scout→experiment rail forks testable
  // proposals into DRY-RUN experiment specs only (no spend, no change to gym routing)
  // until the owner flips it (experiment-registry-invocation-api #2). Double-gated by
  // papercusp-replay-harness + the governor.
  [FLAGS.SCOUT_EXPERIMENT_RAIL]: true,
  // DEFAULT ON (flipped 2026-06-22, owner-directed): the Scout `rubric` rail auto-authors a
  // template:rubric draft per detected gap. Drafts stay Queen-gated (invisible to rubrics:list
  // until promoted), so this is reversible + low-blast.
  [FLAGS.SCOUT_RUBRIC_RAIL]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: the
  // deferral-interest refit is a frontier learning loop (SQL-only, zero LLM
  // spend); the flag flip + an owner-set per-cycle governor budget on loop
  // `deferral-interest-refit` + activating the seeded-inactive routine are
  // the P-001 arming acts.
  [FLAGS.DEFERRAL_INTEREST]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: the
  // owner-preference ranking feature re-orders the owner's live queue, so it
  // arms only at P-001 (the flag flip is the arming act — no routine, no
  // governor budget: it computes inline in the digest read path, SQL-only).
  // Interaction capture stays on either way (substrate, not a loop).
  [FLAGS.OWNER_PREFERENCE_RANKING]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: calibration
  // markets is a frontier learning loop (SQL-only, zero LLM spend) whose flag
  // gates both the capture seams and the resolution sweep; the flag flip + an
  // owner-set per-cycle governor budget on loop `calibration-markets` +
  // activating the seeded-inactive routine are the P-001 arming acts.
  [FLAGS.CALIBRATION_MARKETS]: true,
  // ON by default (NOT a dark frontier loop): memory-precision monitoring is a
  // cheap (~$0.05 embeddings/run, no LLM), read-only WEEKLY measurement of an
  // already-solved floor (D-007) — finished monitoring, not incomplete/unsafe
  // work, so it ships enabled. The @singleton routine row is materialized by the
  // seed CLI post-deploy (singletonActive:true → seeds ACTIVE).
  [FLAGS.MEMORY_PRECISION_BENCH]: true,
  // DEFAULT ON (owner-directed flip 2026-06-25): workspace-scoped memory recall — the
  // reversible cutover kill-switch (data-scoping-audit P-006 / D-012). The owner attended
  // the flip directly (the live recall-hit-rate A/B is the watch, not a pre-gate); the
  // filter is conservative + NULL-safe + unit-tested. OFF reverts to global recall (the
  // kill-switch) if hit-rate regresses. Graduated out of KNOWN_DARK_FLAGS per the rule.
  [FLAGS.MEMORY_WORKSPACE_SCOPED_RECALL]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: the Red
  // Queen plants synthetic frictions and files origin=drill captures (new
  // capture volume, even though the drill lane never reaches organic
  // learners); the flag flip + an owner-set per-cycle governor budget on
  // loop `red-queen` + activating the seeded-inactive routine are the P-001
  // arming acts. The flag also arms the out-of-band engine-death sentinel
  // (checked per pass — no restart needed).
  [FLAGS.RED_QUEEN]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: the SLO
  // sensors are new CAPTURE SOURCES (a breach files into the improvements
  // queue) even though they ride the existing watchdog routine and spend
  // nothing; the flag flip is the ONLY P-001 arming act (no routine to
  // activate, no governor budget — SQL-only on the watchdog's cadence).
  [FLAGS.LEARNING_SLO_SENSORS]: true,
  // OFF by default — same D-001 dark-ship rule as the loops above: the
  // graduation tracker files owner ratification reports into the improvements
  // queue (new capture volume); the flag flip + an owner-set per-cycle
  // governor budget on loop `graduation-tracker` (0 is honest — SQL-only) +
  // activating the seeded-inactive routine are the P-001 arming acts.
  [FLAGS.GRADUATION_TRACKER]: true,
  // ON by default — Phase 0 foundation, same call as CHANGE_LEDGER above
  // (self-learning-frontier P-003/FB-01): the governor SPENDS nothing and
  // FILES nothing — it is the refusal gate D-004 wants live, and ON starts
  // the gym/scout one-ledger spend visibility now. The D-001 dark-ship rule
  // covers the frontier LOOPS, each individually flag-gated + unbudgeted
  // (⇒ refused by THIS gate) until the P-001 arming act. OFF is the
  // kill-switch (mirrors no-op; preflight refuses 'governor-dark').
  [FLAGS.LEARNING_GOVERNOR]: true,
  // ON by default (alpha flags-default-on) — finished, safe work (bounded under the
  // user's concurrency cap, self-recovering). P5-2 kill-switch.
  [FLAGS.LOOP_PRESSURE_GOVERNOR]: true,
  // ON by default (alpha flags-default-on) — finished, safe work: sheds agent concurrency
  // only at ≥90% PG saturation (rare with PgBouncer on), no-op without a finite cap,
  // self-recovering. backend-connection-scaling C5-1 kill-switch.
  [FLAGS.CONNECTION_PRESSURE_GOVERNOR]: true,
  // ON by default (alpha flags-default-on) — infra-perf-reliability-audit-round4 P-013:
  // the perf/reliability regression rig. Finished, additive, read-mostly monitoring
  // (snapshots SLO metrics + files on a budget breach); flipping it OFF only blinds
  // the regression watch. The flag-ON IS the arming act — there is no separate routine
  // or governor budget (it rides the existing improvement-watchdog tick, SQL-only).
  [FLAGS.PERF_REGRESSION_RIG]: true,
  // ON by default (alpha flags-default-on) — B-GW-4 opus-budget pacing. Safe always-on:
  // only sheds a non-critical opus ESCALATION to sonnet under 5h budget pressure, never
  // below a role floor; self-healing as the window decays. Escape hatch flag.
  [FLAGS.OPUS_BUDGET_PACING]: true,
  // ON by default (alpha flags-default-on policy) — queen-autonomous-execution
  // B-10 (P-041/P-045). Behavior-neutral throughput improvement (D-007): it only
  // changes what happens to a FLEET AGENT's otherwise-frozen card (route to a
  // routable owner-Queue escalation + bounded timeout). Interactive human/operator
  // callers are untouched. OFF = the legacy un-intercepted ctx.askUser path.
  [FLAGS.QUEEN_CARD_INTERCEPTION]: true,
  // ON by default (alpha flags-default-on) — queue-authorization-redesign P-004/P-006:
  // pure presentation over the whyGated/authorizer fields + the decision.ledger read;
  // no new writes. OFF = the prior tier-grouped queue (safe rollback).
  [FLAGS.QUEUE_AUTHORIZATION_VIEW]: true,
  // ON by default (alpha flags-default-on) — storage-settings-page-2026-06-15:
  // exposes the Settings → Storage page. Keep-all stays the default behavior; the
  // page only prunes on an explicit user trim. OFF hides the nav entry.
  [FLAGS.STORAGE_SETTINGS]: true,
  // ON by default (current behavior) — storage-settings-page-2026-06-15 P-006:
  // the pre-existing background prunes keep running unless the owner disables one
  // from the Storage page. OFF makes its DBOS tick skip (fail-safe).
  [FLAGS.STORAGE_RETAIN_TELEMETRY]: true,
  [FLAGS.STORAGE_RETAIN_SCRATCH]: true,
  [FLAGS.STORAGE_RETAIN_TEST_RUNS]: true,
  // ON by default (graduated 2026-06-23, su — owner-directed arming of agent-capability-
  // confinement B-06/P-012, WI-601). Envelope ENFORCEMENT at the dispatch chokepoint: the
  // B-18 cutover + B-05 capability tools have shipped, so enforcement no longer strands the
  // fleet. The only active denies are the universal protected floor (secrets:* /
  // processes:kill) for every fleet role + the sentinel/overwatch fs-write/bash denies —
  // capabilities those roles don't hold anyway. Live-validated: the fleet ran enforced
  // (operator_flag_overrides) for days with 0 envelope-caused failures. OFF = the
  // observe-only/shadow kill-switch.
  [FLAGS.CAPABILITY_ENVELOPE]: true,
  // DEFAULT ON (flipped 2026-06-22 — owner ratified the owner-authority surface in-session):
  // gates the loadRoleCapabilities grant-union (capability:grant_role / revoke_role).
  [FLAGS.CAPABILITY_GRANT_TOOL]: true,
  // DEFAULT ON (flipped 2026-06-22, owner-directed): enables the work-item redundancy capability.
  // N× model spend is per-item opt-in (set_redundancy), not automatic on every item.
  [FLAGS.WORKITEM_REDUNDANCY]: true,
  // DEFAULT ON (flipped 2026-06-22 — owner ratified in-session): runtime per-role capability-envelope
  // overrides (D-010). No-op until an override is set (the sync-cache starts empty).
  [FLAGS.CAPABILITY_ENVELOPE_OVERRIDES]: true,
  // P-020 — telemetry-buffer config is operational + safe (empty store = byte-identical); ships
  // ON per the default-on policy, as a kill-switch (OFF forces the baked telemetry-buffer defaults).
  [FLAGS.TELEMETRY_BUFFER_CONFIG]: true,
  // P-020 — txn-timeouts config is operational + safe (empty store = byte-identical 5s/5s); ships
  // ON per the default-on policy, as a kill-switch (OFF forces the baked 5s/5s txn timeouts).
  [FLAGS.TXN_TIMEOUTS_CONFIG]: true,
  // P-019 — the §G auth/sandbox override umbrella is DARK (default OFF, KNOWN_DARK_FLAGS): it gates an
  // OWNER-AUTHORITY escalation surface (auth:set_full_access_roles can widen the all-gates bypass set).
  // OFF ⇒ the sync-cache stays empty ⇒ every surface uses its baked literal ⇒ byte-identical. The owner
  // flips it ON to ratify the auth dials.
  [FLAGS.AUTH_CONFIG_OVERRIDES]: false,
  // P-019 — testing-full-access master switch is ON by default (the env→flag conversion preserves the
  // current testing-phase bypass exactly); OFF is the kill-switch (testing-full-access globally off).
  [FLAGS.TESTING_FULL_ACCESS]: true,
  // ON by default — Phase-0 foundation record-keeping (B-06 / P-011), same call as
  // CHANGE_LEDGER: append-only governed-action rows, no LLM spend, subset of tool_invocations.
  // OFF is the kill-switch (the emit no-ops).
  [FLAGS.DECISION_LEDGER]: true,
  // ON by default — behavior-neutral throughput (B-09 / D-007): the placement
  // completion watchdog only acts on STARTED hives. OFF = the kill-switch.
  [FLAGS.HIVE_PLACEMENT_WATCHDOG]: true,
  // OFF by default — DELIBERATE (queen-autonomy-policy B-12 / P-092): the autonomy
  // decider ARMING GATE. OFF ⇒ the decider gates EVERY item (autonomy dark,
  // behavior-neutral, D-007). The owner's P-092 act flips it ON — and even then
  // every category ships never-auto (D-005), so arming alone auto-decides nothing.
  [FLAGS.QUEEN_AUTONOMY_ARMED]: true,
  // OFF by default — DELIBERATE (queen-autonomy-and-selffeed-fix Phase 2): the OWNER
  // FULL-AUTONOMY grant. ON lets the Queen auto-decide the categorical residue
  // (owner-authority / protected / irreversible / graduation:*) AND lifts the auto-
  // implement loop's protected-path TCB. Recursive-self-improvement boundary — owner
  // flips it deliberately; reversible (OFF restores today's gates verbatim).
  [FLAGS.QUEEN_FULL_AUTONOMY]: true,
  // ON by default (alpha flags-default-on policy) — the owner control surface
  // (B-15) reads + writes the already-audited never-auto policy and arms nothing;
  // OFF hides the /settings/autonomy nav entry.
  [FLAGS.QUEEN_AUTONOMY_SETTINGS]: true,
  // ON by default (graduated 2026-06-23, su — owner-directed arming of agent-capability-
  // confinement B-18/P-020, WI-602). The fleet cutover drops native write/exec tools from
  // autonomous spawns and routes them to the gated capability:* defineTools. Live-validated
  // on this box (operator_flag_overrides ON for days): bees+queen made hundreds of
  // successful capability:bash/edit/git/write calls with 0 errors — capability:* ergonomics
  // confirmed on live agents. Pairs with CAPABILITY_ENVELOPE (enforcement) +
  // CAPABILITY_EXEC_SANDBOX (re-containment, still default-OFF pending bwrap-host validation
  // — WI-608; on a fresh bwrap host flip exec-sandbox too so capability:bash isn't
  // unsandboxed). OFF = today's native-tool allowlist (kill-switch).
  [FLAGS.FLEET_CAPABILITY_ONLY]: true,
  // ON by default — capability-confinement B-18 / P-022 / D-008, validated end-to-end
  // on a bwrap+srt-capable host (WI-608: an AppArmor profile granting /usr/bin/bwrap the
  // `userns` permission lets Ubuntu 24.04's restricted userns sandbox). FAIL-OPEN
  // (bwrap-unavailable ⇒ raw spawn), so it never breaks a host without a working bwrap;
  // where bwrap works, capability:bash/git run srt-preferred (fs + credential +
  // domain-allowlist egress) or bwrap-fallback (fs + credential) — re-containing the
  // operator-side exec the B-18 cutover routes off native Bash onto capability:*.
  [FLAGS.CAPABILITY_EXEC_SANDBOX]: true,
  // ON by default (alpha flags-default-on policy) — the content guard is a SAFETY
  // feature (broken docs never reach staging) that fails open per-detector + is a
  // verified no-op on a clean tree. ON ships it; OFF is the instant kill-switch if it
  // ever mis-quarantines on the shared git-sync commit path. A flag-infra error keeps
  // it ON (getFlag falls back to this default), so the safety stays on when PostHog is
  // unreachable — the opposite of a closed gate.
  [FLAGS.GIT_SYNC_CONTENT_GUARD]: true,
  // DEFAULT OFF (git-sync-dx-hardening P-004) — rewrites the commit hot path (per-agent
  // attributed commits). OFF = today's single `git add -A` commit, byte-identical. Owner
  // flips post-review (also listed in KNOWN_DARK_FLAGS).
  [FLAGS.GIT_SYNC_DERIVED_ATTRIBUTION]: true,
  // DEFAULT ON (docs-corpus WS2 P-008): the doc-steward — the post-git-sync freshness sweep
  // dispatches a doc-steward agent to re-sync a drifted doc to the current code. Owner-ratified
  // ON 2026-06-22 (auto-doc-editing surface). Thoroughly tested (dispatch + blueprint + flag);
  // best-effort + flag-gated so it can never wedge git-sync.
  [FLAGS.DOC_STEWARD]: true,
  // DEFAULT ON (P-142, owner-directed flags-default-on sweep 2026-06-23; the runtime
  // override was already ON in both workspaces). The master flag is the FIRST of a TWO-gate
  // guard (orchestrator-runner.ts useWorkerChunkLoopOp): routing a coding worker turn to the
  // operator-hosted worker:chunk-loop op ALSO requires the per-harness `workerChunkLoop`
  // config knob (default false). So default-ON is behavior-NEUTRAL — no harness opts in yet,
  // every coding worker still runs the subprocess path. The per-harness knob is the real
  // cohort/ramp lever for the owner-watched dark-launch → 25/50/100 ramp → retire
  // (worker-chunk-loop-operator-hosted-2026-06-14 P-010+): finished work no longer ships dark
  // while critical harnesses stay protected by the second gate.
  [FLAGS.WORKER_CHUNK_LOOP_BLUEPRINT]: true,
  // ON by default (alpha flags-default-on policy) — generic-column-filters Phase 2:
  // the filter bar is additive surfacing over the tested @papercusp/grid-core engine
  // (Phase 1). OFF = the bar renders nothing; panels list unfiltered rows.
  [FLAGS.GRID_COLUMN_FILTERS]: true,
  // DEFAULT ON (per-hive-learning-loops P-070) — dev / self-host run the full
  // layer-3 platform-improvement loop (this workspace IS "Papercusp inside
  // Papercusp"). NOT a dark ship: the gate is registration-only and each frontier
  // loop keeps its own arming gate. A public RELEASE build flips it off via
  // PAPERCUSP_PLATFORM_MODE=off (no dev-vs-release runtime signal exists yet —
  // OWNER design point, see P-070). Default-ON ⇒ not in KNOWN_DARK_FLAGS.
  [FLAGS.PLATFORM_IMPROVEMENT_LOOPS]: true,
  // DEFAULT ON (directed-wake-honesty-and-spawn-handoff P-014) — finished work
  // ships on. The spawn/wake-hydration block is fail-soft per source + bounded
  // (P-013), so default-on degrades to an empty section, never a broken spawn.
  // Default-ON ⇒ not in KNOWN_DARK_FLAGS.
  [FLAGS.SPAWN_HANDOFF_HYDRATION]: true,
  // OFF by default — DELIBERATE (overwatch-role-2026-06-15 B-10 / D-002 / D-004):
  // the OVERWATCH autonomous role ships dark. It is a brand-new, not-yet-proven
  // autonomous supervisor that nudges the live fleet; a confused overwatch must not
  // be able to thrash the system it protects, so it stays off until B-12's live
  // staging run proves it. The owner flips it ON after that proof. The flag gates
  // the role registration (B-01), the wake-loop/routine (B-04), and the UI pane
  // (B-08). Pending flip surfaced in the plan's ## Now + every lane report.
  [FLAGS.OVERWATCH]: true,
  // OFF by default — DELIBERATE (sentinel-as-herald-2026-06-21, mirrors OVERWATCH):
  // the SENTINEL autonomous role ships dark. It is a brand-new, not-yet-proven
  // autonomous supervisor that nudges the live fleet; a confused sentinel must not
  // be able to thrash the system it protects, so it stays off until its first live
  // staging run proves it. The owner flips it ON after that proof. The flag gates
  // the role registration, the wake-loop/routine, and the UI pane. Pending flip
  // surfaced in the plan's ## Now + every lane report. KNOWN_DARK_FLAGS.
  [FLAGS.SENTINEL]: true,
  // OFF by default — DELIBERATE (sentinel-as-herald-2026-06-21 Phase 5, mirrors SENTINEL):
  // the server-side proactive "decide to speak" sweep ships dark. A brand-new autonomous
  // speak loop; OFF ⇒ the sweep no-ops every tick (live voice + the browser-provider
  // proactive ticks are byte-for-byte unchanged). Triple-gated on top of the flag
  // (humanFacingRole==='sentinel' + not DND/paused/over-budget + voice-host owns the
  // lease). Owner flips ON after its first live staging run. KNOWN_DARK_FLAGS.
  [FLAGS.SENTINEL_PROACTIVE]: true,
  // DEFAULT ON (scheduled-recurring-plans-2026-06-16 D-019, owner-directed at ship): the
  // scheduled-plan execution path is enabled in prod. Safe despite being an autonomous
  // executor — the real control is per-plan ARMING (autonomy-gated, schedule-arm
  // never-auto, owner-only); an un-armed feature fires nothing. (Supersedes P-028's dark default.)
  [FLAGS.SCHEDULED_PLANS]: true,
  // DEFAULT OFF — DELIBERATE (see the flag note): the external-bench grader adapter
  // is incomplete (M2 unbuilt) + infra-heavy (Docker/GB image pulls); ships dark
  // until the P-009 pilot proves it. Owner flips ON after — pending flip surfaced.
  [FLAGS.EXTERNAL_BENCH]: false,
  // DEFAULT ON — GRADUATED 2026-06-25 (owner ratification, shared-hive-public-release-2026-06-22
  // GATE-3). shared-hive-rekey-2026-06-19: the hive epoch re-key master gate. ON ⇒
  // resolveHiveEpochCrypto returns the real createHiveEpochCrypto (XChaCha20-Poly1305 AEAD,
  // per-epoch key, K-CUT wrapped to remaining members only); encrypt-on-write + decrypt-on-read
  // are live. Code-complete + unit-proven (read-cut-witness + crypto-impl + op-gate + boundary,
  // 32/32). RESIDUAL: the live cross-MACHINE K-CUT-on-content witness (WI-560) is still in flight
  // on the fed-a/fed-b rig; the owner ratified graduation ahead of it (security-cutover authority).
  [FLAGS.HIVE_REKEY]: true,
  // DEFAULT OFF (dark) — loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5): the
  // engine-managed-loop master gate. OFF ⇒ loop:arm refuses with loops_disabled (the
  // feature is inert — no loop rows exist; loop:end/loop:status are ungated). The loop
  // engine (fire + completion-rebase) is in-flight, so the warm-wake round-trip is
  // unverified; owner flips ON after the B-LOOP-1..5 chain is green + the manual e2e
  // passes. KNOWN_DARK_FLAGS.
  [FLAGS.LOOPS]: true,
  // DEFAULT ON: mints work-items on the live plans:start path (unified-work-item-ledger P-003 /
  // D-002). Dogfood-verified (D-007 backfilled 14 work-items); flipped default-ON 2026-06-22
  // (owner-directed — finished work ships ON, not dark).
  [FLAGS.PLAN_WORKITEM_PROMOTION]: true,
  // DEFAULT ON (work-queue-completeness Phase A): routes every plan-item claim through
  // convertPlanItem so the claim auto-mints + assigns a tracked work-item — closes the gap where
  // plan-item claims orphaned their work-items from the Queen frontier (double-placement). 48 tests
  // green; flipped default-ON 2026-06-22 (owner-directed — finished work ships ON, not dark).
  [FLAGS.PLAN_ITEM_CLAIM_AUTO_CONVERT]: true,
  // DEFAULT ON (flipped 2026-06-22, owner-directed after a verify): gates the listEscalations read
  // cutover onto the coord_open_escalations projection. mig 355 verified applied — the table +
  // trigger exist + are live in harness_shared (the read now folds the projection, not the event log).
  [FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION]: true,
  // DEFAULT ON (coord-wake-on-reply, alpha default-on policy): auto-wake the original
  // sender of a DIRECTED coord:send when a peer replies (related_msg_id chain). The
  // reply-wake is optimistic + fail-soft, so it only ever adds a best-effort re-invoke;
  // OFF restores today's behavior (a reply waits in the inbox until the sender's next turn).
  [FLAGS.COORD_WAKE_ON_REPLY]: true,
  // DEFAULT ON (caching-layer-tag-eca-2026-06-22 P-004): the cache↔change-stream ECA rule.
  // The action + rule are complete + tested and a tag-generation bump is a safe no-op side
  // effect (no consumers yet ⇒ nothing breaks); OFF ⇒ the rule no-ops (byte-identical). The
  // live change-stream → emitSystemEvent wiring is a focused follow (see types.ts comment).
  [FLAGS.CACHE_TAG_ECA]: true,
  // DEFAULT ON (caching-layer-tag-eca-2026-06-22 P-018): the operator L1 cache read
  // kill-switch. ON ⇒ getOrSet uses L1; OFF ⇒ getOrSet bypasses straight to the factory
  // (byte-identical to no cache). Default-on per alpha policy — the bypass is the panic
  // switch, not a dark gate.
  [FLAGS.CACHE_LAYER]: true,
  // DEFAULT ON (data-sync-push-completion P-005/D-012): the debounced append-heavy
  // change-detector. Complete + tested (the detector + the bus per-call dedupe override);
  // OFF ⇒ no detector, append-heavy consumers fall back to their own poll / 180s drift-repair.
  [FLAGS.APPEND_HEAVY_LIVE_INVALIDATION]: true,
  // hybrid-bee-scheduler-work-stealing-2026-06-22: spec-driven claim ON (default); OFF degrades
  // scheduler:get_next to the default ordering (no breakage). Resolver + spec store complete + tested.
  [FLAGS.SCHEDULER_SPEC_CLAIM]: true,
  // DEFAULT ON (work-item-deps-and-readiness-2026-06-22 P-005, owner-directed flip 2026-06-23): the claim
  // reads readiness from the maintained work_item_blocked sidecar (an indexed anti-join kept exact by the
  // wir_* triggers) instead of the inline per-claim NOT EXISTS. Verified: live reconciliation drift=0
  // sustained + the flag-ON claim path green end-to-end (claim-respects-blocking 9/9, both entry points).
  // Cutover prerequisite MET: mig 379 is on the shared dev DB AND folded into the shared claim-test fixture
  // (WORK_ITEM_DEPS_DDL) so every claim test has the maintained sidecar. OFF is the reversible kill-switch
  // back to the byte-identical inline predicate.
  [FLAGS.SCHEDULER_MAINTAINED_READY]: true,
  // DEFAULT ON (gateway-priority-tiers-2026-06-22): per-tier admission caps + a reserved tier-1 floor
  // (queen/scout/interactive never crowded out by batch bees). Complete + tested (19 module tests +
  // gateway suite green, flag-OFF byte-identical); flipped ON per owner directive 2026-06-22.
  [FLAGS.GATEWAY_PRIORITY_TIERS]: true,
  // DEFAULT ON (queen-capacity-aware-dispatch-2026-06-22): the Queen clamps fresh-bee placement to what the
  // inference pool can sustain (gateway /stats oracle), so it stops flooding a saturated pool. Complete +
  // tested (13 module tests + 24 placement tests green; flag-OFF + gateway-unreachable byte-identical, fail-
  // safe, minHeadroom floor lets high-priority work flow). Flipped ON per owner directive 2026-06-22.
  [FLAGS.QUEEN_CAPACITY_DISPATCH]: true,
  // DEFAULT ON (agent-tool-delta-protocol-2026-06-22, owner-directed flip 2026-06-22): the
  // LLM-facing semantic-delta opt-in. INERT until a delta-aware CLIENT exists (WI-514 — nothing
  // sends _meta.delta yet), so ON enables the server capability ahead of the client; the
  // delta-gate stays warn-only/un-armed so it never blocks deploys. Reversible (flip OFF).
  [FLAGS.TOOL_DELTA_PROTOCOL]: true,
  // DEFAULT ON (agent-tool-delta-protocol P-009, owner-directed flip 2026-06-22): the SSE
  // state-snapshot DATA-delta path. Round-trip-proven (state-delta + reducer + server-policy
  // tests); the desktop's use-state-snapshots is the LIVE client (always sends ?delta=1, applies
  // deltas with a checksum/keep-stale fallback). Reversible kill-switch — OFF reverts to full snapshots.
  [FLAGS.STATE_SNAPSHOT_DELTAS]: true,
  // DEFAULT ON (agent-tool-delta-client-rollout-2026-06-23 P-006, owner-directed flip 2026-06-23):
  // the sync resource rows-delta. ON ⇒ the SyncDeltaCodec is injected ⇒ plans.attention/plans.list
  // re-fetch as row deltas (the ~327GB/3d win) instead of full row sets. Round-trip-proven
  // (negotiateRowsDelta + SyncDeltaCodec + batch-fetcher, 588 delta tests). The merge is done in
  // CODE (DeltaToolClient.ingest), guarded by a checksum that refetches FULL on any mismatch — a
  // wrong merge degrades to a refetch, never a wrong view. Reversible kill-switch: OFF ⇒ no codec
  // ⇒ full re-fetch (byte-identical). NO LLM is in this path — it is server↔desktop transport only.
  [FLAGS.SYNC_RESOURCE_DELTA]: true,
  // DEFAULT ON (queen-bee-spawn-reclaim-relaunch-2026-06-22, EI-85): the boot reconcile
  // re-launches a reclaimed queen/bee whose durable work-item is non-terminal so the
  // work survives a host restart. Bounded (non-terminal work only, ceiling-gated re-fire)
  // and reversible; OFF ⇒ legacy reclaim-to-`failed`, byte-identical.
  [FLAGS.SPAWN_RECLAIM_RELAUNCH]: true,
  // DEFAULT ON (work-item-deps-and-readiness-2026-06-22 P-007, OWNER-RATIFIED 2026-06-23): ISSUE-family
  // work-items (bug/change/task) are self-pickable by the scheduler claim — the fleet's dispatch backlog
  // now includes issues, not just features. The owner personally ratified this dispatch-source expansion.
  // Additive: the feature claim is untouched; the issue-claim branch runs only on a feature-miss; issue
  // readiness uses the inline work_item_deps predicate (the maintained sidecar is feature-only). OFF is the
  // reversible kill-switch back to feature-only (byte-identical).
  [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
  // DEFAULT ON (code-run-token-frugality 2026-06-23): the inline same-tool-N× batch nudge. Additive
  // + reversible (adds a one-shot [batch-hint] line to a result for a code:run-capable caller); OFF
  // ⇒ no hint, byte-identical to before.
  [FLAGS.CODE_RUN_BATCH_NUDGE]: true,
  // DEFAULT ON (code-run-token-frugality fan-out upgrade 2026-06-26): the fan-out trigger of the
  // inline nudge (≥4 distinct tools in a window → a Promise.all skeleton). Additive + reversible (its
  // own flag so it can be A/B'd against the adoption metric); OFF ⇒ only the same-tool trigger fires.
  [FLAGS.CODE_RUN_FANOUT_NUDGE]: true,
  // DEFAULT ON (agent-tooling-token-efficiency P-009 2026-06-25): the soft orient-dedup nudge.
  // Additive + reversible (adds a one-shot [nudge] line when a subsumed fetch follows a successful
  // orient); OFF ⇒ no nudge, byte-identical to before.
  [FLAGS.ORIENT_DEDUP_NUDGE]: true,
  // FLIPPED ON 2026-06-23 (owner-directed, psu-in-desktop-builds): psu is verified
  // shipping in real mac + windows builds (mac: psu.mjs in the installed .app
  // sidecar; windows: vm-smoke-windows.sh 9/9 incl the psu shim check). The
  // discoverable superuser-session entry is now live. Reversible — set false to revert.
  [FLAGS.PSU_END_USER]: true,
  // DEFAULT ON (owner-directed 2026-06-23): clone-on-first-boot of the `papercusp`
  // dogfood hive. Best-effort + non-fatal (no gh auth → no-op + retry next boot).
  [FLAGS.DOGFOOD_PAPERCUSP_HIVE]: true,
  // DEFAULT ON (owner-ratified 2026-06-24): per-owner SHARED papercusp hive on
  // install (Solution C). See the FLAGS comment. Best-effort + non-fatal.
  [FLAGS.DOGFOOD_PAPERCUSP_HIVE_SHARE]: true,
};

export const ALL_FLAG_KEYS: readonly FlagKey[] = Object.values(FLAGS);

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

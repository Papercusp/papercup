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
  // inference gateway routes each request to one of N registered credentials by the
  // `x-papercusp-account` header (billed-API multi-credential — rate-limit-pool
  // isolation / cost attribution / failover), and the spawn chokepoint assigns a
  // cache-affinity credential per bee. DEFAULT OFF — DELIBERATE (not the alpha
  // default-on policy): it changes credential routing/egress and needs billed API
  // keys registered + a real multi-key run before the flip (D-001). OFF = the
  // single bound-credential gateway, byte-identical to today. Listed in KNOWN_DARK_FLAGS.
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
  // queen-autonomy-policy-2026-06-13 B-15 (P-030): the owner control surface —
  // /settings/autonomy, where the owner sets per-category risk ceilings / locks
  // and sees the earned graduated + derived effective level. ON by default (alpha
  // flags-default-on policy): the page only reads + writes the already-audited
  // autonomy_policy (every category ships never-auto, and editing a ceiling never
  // ARMS autonomy — that's the separate QUEEN_AUTONOMY_ARMED / P-092 gate). OFF is
  // the kill-switch that hides the nav entry (the page's auto-decisions feed +
  // graduation prompts are still stubbed pending B-16).
  QUEEN_AUTONOMY_SETTINGS: "papercusp-queen-autonomy-settings",
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
  // of the subprocess chunk loop. DEFAULT OFF — the staged hot-path rollout's gate
  // (dark → ramp → retire); OFF = today's subprocess path, unchanged.
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
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  // DEFAULT ON (alpha flags-default-on) — additive hive-control surfacing.
  [FLAGS.HIVE_CONTROL]: true,
  // DEFAULT ON (alpha flags-default-on) — additive read-only Health dashboard +
  // its fail-soft `health.snapshot` resolver/tick (system-health-tab-2026-06-15).
  [FLAGS.SYSTEM_HEALTH_TAB]: true,
  // DEFAULT ON — fresh-context interactive brain (reversible to D-013).
  [FLAGS.QUEEN_BRAIN_FRESH]: true,
  [FLAGS.CLOUDFLARE_PUBLISH]: false,
  [FLAGS.HARNESS_PHASES]: false,
  [FLAGS.DESIGN]: false,
  [FLAGS.TESTING]: false,
  [FLAGS.INBOX_DURABLE_ESCALATIONS]: false,
  // DEFAULT OFF — unverified cutover (needs the 2-machine merge proof, P-008). Off = plans federate as today.
  [FLAGS.PLAN_PART_FEDERATION]: false,
  [FLAGS.PLAN_ATTRIBUTION_BADGES]: true,
  // DEFAULT-ON (owner-directed): the hive role-tier owner-action gate enforces
  // immediately. Kill-switch — OFF reverts to the prior root-only/source gates.
  [FLAGS.HIVE_ROLE_TIERS]: true,
  // OFF by default — the self-improvement loop captures + triages with this off;
  // auto-implementation only begins once an owner flips it (see the flag note above).
  [FLAGS.IMPROVEMENT_AUTO_IMPLEMENT]: false,
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
  [FLAGS.INFERENCE_GATEWAY]: false,
  // OFF by default — DELIBERATE (inference-gateway-multi-credential-routing P-009):
  // multi-credential routing changes egress/credential selection; the flip is gated
  // on billed API keys registered + a real multi-key run (D-001). OFF = the single
  // bound-credential gateway, byte-identical to today.
  [FLAGS.INFERENCE_GATEWAY_MULTI_ACCOUNT]: false,
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
  // DEFAULT OFF (dark): the option-(c) Hyperswarm-mux RPC transport is wired but
  // its cross-machine path has never been verified on real hardware (P-003). OFF
  // is byte-identical to today (HTTP-only addressing); the flip is gated on the
  // two-machine serialization proof. Listed in KNOWN_DARK_FLAGS.
  [FLAGS.AUTHORITY_RPC_PROTOMUX]: false,
  // DEFAULT OFF (dark): the φ+SWIM eviction probe's live cross-machine path rides
  // the (also-dark) protomux transport and is real-hardware-unverified (D-003,
  // P-003 two-machine proof). OFF = staleness-only authority selection,
  // byte-identical to pre-P-016. Listed in KNOWN_DARK_FLAGS; flip gated on the
  // two-machine eviction proof.
  [FLAGS.AUTHORITY_EVICTION_PROBE]: false,
  // DEFAULT ON (alpha flags-default-on): the peer-log compaction mechanism +
  // fold-from-snapshot correctness are proven single-box AND the real-wire
  // replay-cost saving (Hypercore sparse-fetch) + cross-machine convergence are
  // now proven on real 2-machine Hetzner frames (substrate-peer-log-compaction
  // -2026-06-13 D-008: a fresh joiner converged with contiguousLength=0 vs the
  // from-start reader's full 4602 over real NAT/WAN/holepunch). P-008 gate cleared.
  [FLAGS.SUBSTRATE_LOG_SNAPSHOT]: true,
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
  [FLAGS.NEGATIVE_SPACE_MINER]: false,
  // OFF by default — same D-001 dark-ship rule as NEGATIVE_SPACE_MINER above:
  // frontier learning loops arm only when self-learning-frontier P-001 closes
  // (the flag flip + an owner-set governor budget are the arming acts).
  [FLAGS.NEOLOGISM_MINER]: false,
  // OFF by default — same D-001 dark-ship rule as the miners above: the
  // replay harness is a frontier learning loop (LLM spend); flag flip + an
  // owner-set governor budget (registerReplayLoop) are the P-001 arming acts.
  [FLAGS.REPLAY_HARNESS]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: regret
  // mining is a frontier learning loop (its replay leg spends LLM tokens);
  // the flag flip + an owner-set governor budget on loop `regret-mining`
  // are the P-001 arming acts.
  [FLAGS.REGRET_MINING]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: the
  // transfer harness is a frontier learning loop (distillation + replay
  // batteries spend LLM tokens); the flag flip + an owner-set governor budget
  // on loop `frontier:transfer-harness` are the P-001 arming acts.
  [FLAGS.TRANSFER_HARNESS]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: the Fleet
  // EKG is a frontier loop (zero LLM spend, but its alarm side files into the
  // attention rail); the flag flip + an owner-set governor budget on loop
  // `fleet-ekg` are the P-001 arming acts.
  [FLAGS.FLEET_EKG]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: prompt
  // sedimentology is a frontier loop spending real LLM tokens per weekly
  // cycle (SUT + sim + judge across both arms); the flag flip + an owner-set
  // per-cycle governor budget on loop `prompt-ablation` + activating the
  // seeded-inactive routine are the P-001 arming acts. Shadow-only either
  // way: this lane never mutates live prompts.
  [FLAGS.PROMPT_ABLATION]: false,
  // OFF by default — D-001 dark-ship: the Scout→experiment rail forks testable
  // proposals into DRY-RUN experiment specs only (no spend, no change to gym routing)
  // until the owner flips it (experiment-registry-invocation-api #2). Double-gated by
  // papercusp-replay-harness + the governor.
  [FLAGS.SCOUT_EXPERIMENT_RAIL]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: the
  // deferral-interest refit is a frontier learning loop (SQL-only, zero LLM
  // spend); the flag flip + an owner-set per-cycle governor budget on loop
  // `deferral-interest-refit` + activating the seeded-inactive routine are
  // the P-001 arming acts.
  [FLAGS.DEFERRAL_INTEREST]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: the
  // owner-preference ranking feature re-orders the owner's live queue, so it
  // arms only at P-001 (the flag flip is the arming act — no routine, no
  // governor budget: it computes inline in the digest read path, SQL-only).
  // Interaction capture stays on either way (substrate, not a loop).
  [FLAGS.OWNER_PREFERENCE_RANKING]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: calibration
  // markets is a frontier learning loop (SQL-only, zero LLM spend) whose flag
  // gates both the capture seams and the resolution sweep; the flag flip + an
  // owner-set per-cycle governor budget on loop `calibration-markets` +
  // activating the seeded-inactive routine are the P-001 arming acts.
  [FLAGS.CALIBRATION_MARKETS]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: the Red
  // Queen plants synthetic frictions and files origin=drill captures (new
  // capture volume, even though the drill lane never reaches organic
  // learners); the flag flip + an owner-set per-cycle governor budget on
  // loop `red-queen` + activating the seeded-inactive routine are the P-001
  // arming acts. The flag also arms the out-of-band engine-death sentinel
  // (checked per pass — no restart needed).
  [FLAGS.RED_QUEEN]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: the SLO
  // sensors are new CAPTURE SOURCES (a breach files into the improvements
  // queue) even though they ride the existing watchdog routine and spend
  // nothing; the flag flip is the ONLY P-001 arming act (no routine to
  // activate, no governor budget — SQL-only on the watchdog's cadence).
  [FLAGS.LEARNING_SLO_SENSORS]: false,
  // OFF by default — same D-001 dark-ship rule as the loops above: the
  // graduation tracker files owner ratification reports into the improvements
  // queue (new capture volume); the flag flip + an owner-set per-cycle
  // governor budget on loop `graduation-tracker` (0 is honest — SQL-only) +
  // activating the seeded-inactive routine are the P-001 arming acts.
  [FLAGS.GRADUATION_TRACKER]: false,
  // ON by default — Phase 0 foundation, same call as CHANGE_LEDGER above
  // (self-learning-frontier P-003/FB-01): the governor SPENDS nothing and
  // FILES nothing — it is the refusal gate D-004 wants live, and ON starts
  // the gym/scout one-ledger spend visibility now. The D-001 dark-ship rule
  // covers the frontier LOOPS, each individually flag-gated + unbudgeted
  // (⇒ refused by THIS gate) until the P-001 arming act. OFF is the
  // kill-switch (mirrors no-op; preflight refuses 'governor-dark').
  [FLAGS.LEARNING_GOVERNOR]: true,
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
  // OFF by default — DELIBERATE (capability-confinement B-06 / P-012): envelope ENFORCEMENT
  // would deny fleet tool calls before the B-18 cutover + B-05 capability tools exist. OFF =
  // observe-only/shadow (evaluate + annotate, never block). The B-18 flip is the arming act.
  [FLAGS.CAPABILITY_ENVELOPE]: false,
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
  [FLAGS.QUEEN_AUTONOMY_ARMED]: false,
  // ON by default (alpha flags-default-on policy) — the owner control surface
  // (B-15) reads + writes the already-audited never-auto policy and arms nothing;
  // OFF hides the /settings/autonomy nav entry.
  [FLAGS.QUEEN_AUTONOMY_SETTINGS]: true,
  // OFF by default — DELIBERATE (capability-confinement B-18 / P-020): the fleet
  // cutover removes native write/exec tools from autonomous spawns. The owner arms
  // it (P-023 is an owner item) after capability:* ergonomics are validated on a live
  // bee. OFF = today's allowlist, zero live-fleet change. Listed in KNOWN_DARK_FLAGS.
  [FLAGS.FLEET_CAPABILITY_ONLY]: false,
  // OFF by default — DELIBERATE (capability-confinement B-18 / P-022 / D-008): the
  // server-side capability-exec sandbox. FAIL-OPEN (bwrap-unavailable ⇒ raw spawn), so
  // it is safe, but the bwrap argv path needs end-to-end validation on a bwrap-capable
  // host (this box's unprivileged userns is AppArmor-restricted). Owner arms after that
  // validation. OFF = today's raw operator-side spawn. Listed in KNOWN_DARK_FLAGS.
  [FLAGS.CAPABILITY_EXEC_SANDBOX]: false,
  // ON by default (alpha flags-default-on policy) — the content guard is a SAFETY
  // feature (broken docs never reach staging) that fails open per-detector + is a
  // verified no-op on a clean tree. ON ships it; OFF is the instant kill-switch if it
  // ever mis-quarantines on the shared git-sync commit path. A flag-infra error keeps
  // it ON (getFlag falls back to this default), so the safety stays on when PostHog is
  // unreachable — the opposite of a closed gate.
  [FLAGS.GIT_SYNC_CONTENT_GUARD]: true,
  // DEFAULT OFF (P-142 / D-003) — genuinely incomplete-until-ramped: the operator-hosted
  // worker:chunk-loop is the coding HOT PATH and ships dark, then dark-launch → 25/50/100
  // ramp → retire (worker-chunk-loop-operator-hosted-2026-06-14). OFF = the subprocess
  // chunk loop, unchanged. Flip per-cohort only as the parity metrics confirm at each step.
  [FLAGS.WORKER_CHUNK_LOOP_BLUEPRINT]: false,
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
  [FLAGS.OVERWATCH]: false,
  // DEFAULT OFF — DELIBERATE (see the flag note): the external-bench grader adapter
  // is incomplete (M2 unbuilt) + infra-heavy (Docker/GB image pulls); ships dark
  // until the P-009 pilot proves it. Owner flips ON after — pending flip surfaced.
  [FLAGS.EXTERNAL_BENCH]: false,
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

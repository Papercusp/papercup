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
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  [FLAGS.CLOUDFLARE_PUBLISH]: false,
  [FLAGS.HARNESS_PHASES]: false,
  [FLAGS.DESIGN]: false,
  [FLAGS.TESTING]: false,
  [FLAGS.INBOX_DURABLE_ESCALATIONS]: false,
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
  // ON by default — Phase 0 foundation, same call as CHANGE_LEDGER above
  // (self-learning-frontier P-003/FB-01): the governor SPENDS nothing and
  // FILES nothing — it is the refusal gate D-004 wants live, and ON starts
  // the gym/scout one-ledger spend visibility now. The D-001 dark-ship rule
  // covers the frontier LOOPS, each individually flag-gated + unbudgeted
  // (⇒ refused by THIS gate) until the P-001 arming act. OFF is the
  // kill-switch (mirrors no-op; preflight refuses 'governor-dark').
  [FLAGS.LEARNING_GOVERNOR]: true,
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

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
  // hive-agent-tabs-psu-tui-2026-06-09: gates the unified agent-tabs dock where
  // EVERY agent surface (Queen · Bee · Sentinel · Planner) is a real psu/Claude
  // TUI session, plus the per-agent wake-mode gate, per-type color/grouping, and
  // per-frame tabs. OFF (default) = the current dock (pui chat-pane operator +
  // read-only watch-pane bees) is unchanged. Flip ON once the new renderer is
  // Tauri-verified. Reversible — the legacy surfaces stay until Phase 5 retires them.
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

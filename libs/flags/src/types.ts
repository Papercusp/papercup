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
  ORACLE: "papercusp-oracle",
  RUST_PORT_UI: "papercusp-rust-port-ui",
  HARNESS_PHASES: "papercusp-harness-phases",
  DESIGN: "papercusp-design",
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
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  [FLAGS.CLOUDFLARE_PUBLISH]: false,
  [FLAGS.ORACLE]: false,
  [FLAGS.RUST_PORT_UI]: false,
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

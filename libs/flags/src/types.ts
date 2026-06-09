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
  // unchanged, D-001). OFF (default) = the `classic` Papercusp pack = V1 ship
  // state; ON = the `the-hive` bee pack (Pot→Hive, Fleet→Colony, Queen=brain,
  // Swarm = a deployment-to-instance unit; D-007). Fully reversible presentation
  // switch; @papercusp/lexicon resolves it.
  THE_HIVE: "papercusp-the-hive",
  // psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 (P-008): gates the new
  // SCHEMA-DRIVEN harness settings panel (BlueprintSettingsPanel) that renders
  // controls from the harness blueprint's declared `params` (P-006), replacing the
  // hardcoded coding-pipeline form. OFF (default) = the legacy HarnessSettingsPanel.
  // Flip ON once the panel is visually verified in the Tauri shell + folded over the
  // legacy panel's residual sections (Discord/telemetry). Reversible presentation switch.
  BLUEPRINT_AWARE_SETTINGS: "papercusp-blueprint-aware-settings",
  // psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 (P-011): gates the Prompt
  // Studio surface (edit the renderSuPlaybook SOURCES — base playbooks / per-client
  // overlays / project-guide — with a live assembled-prompt preview). OFF (default)
  // until it's mounted in the settings nav (coordinated with the in-flight /settings
  // restructure) + Tauri-verified. The /api/prompt-studio/* routes are gated on this flag
  // TOO (security review — closed-gate default; the prompt-source backend never ships dark).
  PROMPT_STUDIO: "papercusp-prompt-studio",
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
  // OFF by default — desktop video ships dark behind the live-camera E2E (P-010).
  [FLAGS.VIDEO_CHANNELS]: false,
  // OFF by default — desktop voice channels ship dark behind the supervised
  // live Tauri+mic pass (holepunch-voice-channels D-014).
  [FLAGS.VOICE_CHANNELS]: false,
  // OFF by default — classic Papercusp is the V1 ship state; flip on to adopt
  // the bee lexicon (the-hive-lexicon-2026-06-06). Presentation only.
  [FLAGS.THE_HIVE]: false,
  // OFF by default — the legacy hardcoded HarnessSettingsPanel ships until the
  // schema-driven BlueprintSettingsPanel (P-008) is Tauri-verified. Flip on to adopt.
  [FLAGS.BLUEPRINT_AWARE_SETTINGS]: false,
  // OFF by default — the Prompt Studio (P-011) ships dark until mounted in the settings
  // nav + Tauri-verified. The /api/prompt-studio/* routes are flag-gated on it too.
  [FLAGS.PROMPT_STUDIO]: false,
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

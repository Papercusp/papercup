// Single source of truth for Papercusp feature flag keys, defaults, and shape.
// Adding a flag: append here, then create the matching definition in PostHog
// (key MUST match the string literal exactly). Defaults are V1 ship-state (off).

export const FLAGS = {
  SNAPSHOTS: "papercusp-snapshots",
  // TEMPLATES + MARKETPLACE retired (revive-cupboard-distribution D-004): the
  // legacy :3057 marketplace + /templates routes/UI are deleted; distribution
  // lives in the (ungated) Cupboard.
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
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  // Snapshots are ON by default: they are the Cupboard's `kind=snapshot`
  // fork-source (revive-cupboard-distribution-2026-06-04 P1 / D-002). Capture +
  // local instantiate are verified working; the prod CF-worker deploy + the live
  // PostHog flip on the shared service stay federation-owner actions.
  [FLAGS.SNAPSHOTS]: true,
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

// Single source of truth for Papercusp feature flag keys, defaults, and shape.
// Adding a flag: append here, then create the matching definition in PostHog
// (key MUST match the string literal exactly). Defaults are V1 ship-state (off).

export const FLAGS = {
  SNAPSHOTS: "papercusp-snapshots",
  TEMPLATES: "papercusp-templates",
  MARKETPLACE: "papercusp-marketplace",
  CLOUDFLARE_PUBLISH: "papercusp-cloudflare-publish",
  ORACLE: "papercusp-oracle",
  RUST_PORT_UI: "papercusp-rust-port-ui",
  HARNESS_PHASES: "papercusp-harness-phases",
  DESIGN: "papercusp-design",
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  [FLAGS.SNAPSHOTS]: false,
  [FLAGS.TEMPLATES]: false,
  [FLAGS.MARKETPLACE]: false,
  [FLAGS.CLOUDFLARE_PUBLISH]: false,
  [FLAGS.ORACLE]: false,
  [FLAGS.RUST_PORT_UI]: false,
  [FLAGS.HARNESS_PHASES]: false,
  [FLAGS.DESIGN]: false,
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

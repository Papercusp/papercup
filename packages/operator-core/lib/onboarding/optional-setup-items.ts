/**
 * Canonical Phase-A optional-setup items for onboarding
 * (deterministic-onboarding-tutorial-2026-07-04 P-002).
 *
 * ONE list, consumed by BOTH onboarding paths:
 *  - the deterministic tutorial runner (offers each item, collects a value, applies it);
 *  - the fallback agent tutor (renders these into its Phase-A prompt via a token).
 *
 * `preview: true` items have a backing feature that is NOT ready yet — telemetry
 * consent, mobile pairing, the auto-update channel (owner-directed 2026-07-04). They are
 * gated behind FLAGS.ONBOARDING_PREVIEW_FEATURES (default OFF): a fresh install never
 * sees them; a tester flips the flag ON to exercise the not-yet-shipped surfaces. As each
 * backing feature ships, drop that item's `preview` tag (and eventually retire the flag).
 *
 * `input` tells the deterministic runner HOW to collect the value:
 *  - 'confirm'  → a yes/no
 *  - 'text'     → a free-text value (may be masked for secrets)
 *  - 'terminal' → spawn an interactive terminal command (its spec comes from
 *                 /api/desktop/setup-pty-commands, e.g. `gh auth login`)
 *  - 'preview'  → not-ready: informational only, no write wired yet
 */
export type OptionalSetupInput = 'confirm' | 'text' | 'terminal' | 'preview';

export interface OptionalSetupItem {
  /** Stable id (used by the runner + progress). */
  key: string;
  /** Short display name. */
  label: string;
  /** One-line "why" the runner/tutor shows. */
  why: string;
  /** How the runner collects the value. */
  input: OptionalSetupInput;
  /**
   * true ⇒ the backing feature is NOT ready; shown only when
   * FLAGS.ONBOARDING_PREVIEW_FEATURES is ON. Default installs never see these.
   */
  preview: boolean;
}

export const OPTIONAL_SETUP_ITEMS: readonly OptionalSetupItem[] = [
  {
    key: 'git-identity',
    label: 'Git identity',
    why: 'the name/email stamped on every commit agents make for you',
    input: 'text',
    preview: false,
  },
  {
    key: 'github',
    label: 'GitHub sign-in',
    why: 'lets agents clone and push your private repos',
    input: 'terminal',
    preview: false,
  },
  {
    key: 'backups',
    label: 'Backups',
    why: 'local snapshots that protect against agent mistakes',
    input: 'confirm',
    preview: false,
  },
  {
    key: 'api-keys',
    label: 'More API keys',
    why: 'optional pay-per-use model providers',
    input: 'text',
    preview: false,
  },
  // ── Preview items — backing feature NOT ready; gated behind ONBOARDING_PREVIEW_FEATURES ──
  {
    key: 'telemetry',
    label: 'Telemetry consent',
    why: 'an explicit yes/no on anonymized crash reports',
    input: 'preview',
    preview: true,
  },
  {
    key: 'mobile-pairing',
    label: 'Mobile pairing',
    why: 'pair your phone to get notifications / remote control',
    input: 'preview',
    preview: true,
  },
  {
    key: 'update-channel',
    label: 'Auto-update channel',
    why: 'alpha = freshest, stable = calmest',
    input: 'preview',
    preview: true,
  },
];

/** The keys of every item whose backing feature is not ready (gated by the preview flag). */
export const PREVIEW_ITEM_KEYS: readonly string[] = OPTIONAL_SETUP_ITEMS.filter(
  (i) => i.preview,
).map((i) => i.key);

/**
 * The items to actually offer, given whether preview features are enabled.
 * previewEnabled=false (the default a fresh install sees) drops every `preview` item.
 */
export function visibleOptionalSetupItems(previewEnabled: boolean): OptionalSetupItem[] {
  return OPTIONAL_SETUP_ITEMS.filter((i) => previewEnabled || !i.preview);
}

/** Render the flag-filtered items as a markdown table row set for the fallback tutor prompt. */
export function optionalSetupItemsMarkdown(previewEnabled: boolean): string {
  const rows = visibleOptionalSetupItems(previewEnabled)
    .map((i) => `| ${i.label} | ${i.why} |`)
    .join('\n');
  return `| Step | The one-line why |\n|---|---|\n${rows}`;
}

/**
 * share-wizard-step-types — state machine types for the Phase 5a
 * P-029 share-this-harness wizard per papercusp-dogfood-v5 §5.
 *
 * Types-only and PURE. No React, no Octokit, no PG.
 *
 * Twenty-first module in the dogfood-arc types-only spine.
 *
 * Per v5 §5 nine-step flow:
 *
 *   1. Confirm GitHub remote (OAuth-gated if missing)
 *   2. Resolve canonical repo id + lookup binding (§5.1)
 *   3. Create unclaimed binding if absent
 *   4. Generate Hyperswarm topic (32 random bytes)
 *   5. Choose Discord channel (optional)
 *   6. Choose privacy (shared-private / shared-public)
 *   7. Privacy confirm-modal (D-013)
 *   8. Backfill PG → Hyperbee + GIT (§7.3)
 *   9. Write .papercusp/shared.json + display harness link
 *
 * The UI implementer drops this in when paperclip-zone work
 * resumes; the state machine + transition rules are testable
 * here in isolation.
 */

import {
  HARNESS_SHARED_PRIVACY_LEVELS,
  type HarnessSharedPrivacy,
} from './harness-shared-config-types';

/**
 * Step enum per v5 §5. Each kebab-case name is the step's URL
 * fragment (e.g. `#step=confirm-remote`) — nuqs-backed per the
 * "almost all state in nuqs" rule.
 */
export const SHARE_WIZARD_STEPS = [
  'confirm-remote',
  'lookup-binding',
  'create-binding',
  'generate-topic',
  'choose-discord',
  'choose-privacy',
  'privacy-confirm',
  'backfill',
  'write-shared-json',
] as const;
export type ShareWizardStep = (typeof SHARE_WIZARD_STEPS)[number];

/**
 * Map each step to its 1-indexed position per v5 §5 numbering.
 * UI uses this for "step 3 of 9" indicator copy.
 */
export const SHARE_WIZARD_STEP_INDEX: Record<ShareWizardStep, number> = {
  'confirm-remote': 1,
  'lookup-binding': 2,
  'create-binding': 3,
  'generate-topic': 4,
  'choose-discord': 5,
  'choose-privacy': 6,
  'privacy-confirm': 7,
  backfill: 8,
  'write-shared-json': 9,
};

export const SHARE_WIZARD_STEP_COUNT = SHARE_WIZARD_STEPS.length;

/**
 * The first step. Useful for the "Start the wizard" entry.
 */
export const SHARE_WIZARD_FIRST_STEP: ShareWizardStep = 'confirm-remote';

/**
 * The last step. The next-action after this one is "exit the wizard
 * with the harness link displayed."
 */
export const SHARE_WIZARD_LAST_STEP: ShareWizardStep = 'write-shared-json';

/**
 * Per-step accumulated state. As the user moves forward, each step
 * adds to the wizard's overall state. Backward navigation does NOT
 * clear state (per v5 §5: "each can be back-stepped without losing
 * prior input" — P-029a sub-acceptance).
 */
export interface ShareWizardState {
  /** Step 1 — once user confirms remote present. */
  github_remote?: string;
  /** Step 2 — resolved id + existing-binding lookup result. */
  github_repository_id?: number;
  existing_binding_found?: boolean;
  /** Step 2 — the resolved repo's GitHub visibility, captured at binding-resolve
   *  so the privacy step can reject shared-public on a private repo UP FRONT
   *  (Cupboard, the public registry, refuses a private repo — catching it here
   *  avoids walking all 9 steps only to fail the publish at finalize).
   *  `undefined` = unknown (don't gate; the finalize/backend still guards). */
  repo_private?: boolean;
  /** Step 4 — generated topic. */
  topic?: string;
  /** Step 5 — optional. */
  discord_channel?: string;
  /** Step 6 — privacy choice. */
  privacy?: HarnessSharedPrivacy;
  /** Step 7 — explicit privacy-modal confirmation. */
  privacy_confirmed?: boolean;
  /** Step 8 — backfill completion timestamp. */
  backfill_completed_ts?: number;
  /** Step 9 — final harness link. */
  harness_link?: string;
}

/**
 * Discriminated next-step result. Three outcomes:
 *
 *   `next`            — advance to the specified step.
 *   `complete`        — wizard finished; close + show harness link.
 *   `block`           — current step's preconditions not met; do not
 *                       advance. UI keeps user on the current step.
 */
export type WizardTransition =
  | { kind: 'next'; step: ShareWizardStep }
  | { kind: 'complete' }
  | { kind: 'block'; reason: BlockReason };

export type BlockReason =
  | 'no_github_remote'
  | 'binding_lookup_pending'
  | 'binding_exists_should_join'
  | 'topic_not_generated'
  | 'privacy_not_chosen'
  | 'shared_public_requires_public_repo'
  | 'privacy_not_confirmed'
  | 'backfill_not_completed';

/**
 * Pure forward-transition function. Given the current step + state,
 * returns the next step (or block/complete).
 *
 * Encodes v5 §5 sub-acceptances:
 *   - P-029b: step 2 sees existing-binding → block with `binding_exists_should_join`
 *     (UI offers "Join existing" instead of continuing wizard).
 *   - Step 7 requires explicit confirm before step 8.
 *   - Step 8 must complete before step 9.
 */
export function nextStep(
  current: ShareWizardStep,
  state: ShareWizardState,
): WizardTransition {
  switch (current) {
    case 'confirm-remote':
      if (!state.github_remote) return { kind: 'block', reason: 'no_github_remote' };
      return { kind: 'next', step: 'lookup-binding' };

    case 'lookup-binding':
      // A real positive numeric repo id is required — boot keys the swarm on
      // github_repository_id (derive-swarm-topic), so a 0/NaN id must not
      // advance (it would finalize into a swarm-null harness). Matches
      // isStateCompleteForFinalize's `> 0` requirement.
      if (
        state.github_repository_id === undefined ||
        !Number.isInteger(state.github_repository_id) ||
        state.github_repository_id <= 0
      ) {
        return { kind: 'block', reason: 'binding_lookup_pending' };
      }
      if (state.existing_binding_found === true) {
        return { kind: 'block', reason: 'binding_exists_should_join' };
      }
      return { kind: 'next', step: 'create-binding' };

    case 'create-binding':
      return { kind: 'next', step: 'generate-topic' };

    case 'generate-topic':
      if (!state.topic) return { kind: 'block', reason: 'topic_not_generated' };
      return { kind: 'next', step: 'choose-discord' };

    case 'choose-discord':
      // Discord step is optional — caller can advance with empty state.
      return { kind: 'next', step: 'choose-privacy' };

    case 'choose-privacy':
      if (!state.privacy) return { kind: 'block', reason: 'privacy_not_chosen' };
      // shared-public lists on the PUBLIC Cupboard registry, which refuses a
      // private repo. Caught here (step 6) rather than at the finalize publish.
      if (state.privacy === 'shared-public' && state.repo_private === true) {
        return { kind: 'block', reason: 'shared_public_requires_public_repo' };
      }
      return { kind: 'next', step: 'privacy-confirm' };

    case 'privacy-confirm':
      if (state.privacy_confirmed !== true) {
        return { kind: 'block', reason: 'privacy_not_confirmed' };
      }
      return { kind: 'next', step: 'backfill' };

    case 'backfill':
      if (state.backfill_completed_ts === undefined) {
        return { kind: 'block', reason: 'backfill_not_completed' };
      }
      return { kind: 'next', step: 'write-shared-json' };

    case 'write-shared-json':
      return { kind: 'complete' };
  }
}

/**
 * Pure backward-transition. State is preserved (P-029a). Returns
 * `null` when on step 1 (can't go back further).
 */
export function previousStep(current: ShareWizardStep): ShareWizardStep | null {
  const idx = SHARE_WIZARD_STEPS.indexOf(current);
  if (idx <= 0) return null;
  return SHARE_WIZARD_STEPS[idx - 1] ?? null;
}

/**
 * Predicate: is the wizard state "complete enough" to write
 * .papercusp/shared.json? Used by step 9 to validate before
 * committing.
 */
export function isStateCompleteForFinalize(state: ShareWizardState): boolean {
  return (
    typeof state.github_remote === 'string' &&
    state.github_remote.length > 0 &&
    typeof state.github_repository_id === 'number' &&
    state.github_repository_id > 0 &&
    typeof state.topic === 'string' &&
    state.topic.length > 0 &&
    state.privacy !== undefined &&
    (HARNESS_SHARED_PRIVACY_LEVELS as readonly string[]).includes(state.privacy) &&
    // never finalize shared-public on a private repo (Cupboard would reject it)
    !(state.privacy === 'shared-public' && state.repo_private === true) &&
    state.privacy_confirmed === true &&
    typeof state.backfill_completed_ts === 'number' &&
    state.backfill_completed_ts > 0
  );
}

/**
 * Step 2 (lookup-binding): when the resolved repo is PRIVATE on GitHub, the
 * wizard surfaces an explainer + an in-wizard "Share as a private harness"
 * action — right at the URL/lookup step — rather than letting the user walk
 * all the way to step 6 only to dead-end on shared-public (the public Cupboard
 * registry refuses a private repo). True → render the offer.
 *
 * `undefined` visibility (unknown) does NOT gate — the finalize/backend still
 * guards, and we don't want to mislabel a repo whose visibility we couldn't
 * resolve.
 */
export function shouldOfferPrivateShare(state: ShareWizardState): boolean {
  return state.repo_private === true;
}

/**
 * The "Share as a private harness" action: pre-selects `shared-private` so the
 * remaining steps are the private workflow (the choose-privacy step shows it
 * pre-selected, with shared-public disabled). Pure — returns a new state,
 * preserving all prior input (P-029a back-step invariant).
 */
export function flipToPrivateShare(state: ShareWizardState): ShareWizardState {
  return { ...state, privacy: 'shared-private' };
}

/**
 * Empty starting state — caller initializes the wizard with this.
 */
export function emptyShareWizardState(): ShareWizardState {
  return {};
}

/**
 * Pure step-position helper for progress UI rendering. Returns
 * `{ current, total }` based on 1-indexed positions. Useful for
 * "Step 3 of 9" indicators.
 */
export function getStepPosition(step: ShareWizardStep): { current: number; total: number } {
  return {
    current: SHARE_WIZARD_STEP_INDEX[step],
    total: SHARE_WIZARD_STEP_COUNT,
  };
}

/**
 * Returns the percentage progress (0-100) for a step. Drives the
 * wizard progress bar.
 */
export function getStepProgressPercent(step: ShareWizardStep): number {
  const pos = SHARE_WIZARD_STEP_INDEX[step];
  return Math.round((pos / SHARE_WIZARD_STEP_COUNT) * 100);
}

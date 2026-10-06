/**
 * P-017 (pot-review-integration-mode-2026-10-05, D-007): the ONE creation-time
 * question that decides where a pot's agents' work goes. Users see this single
 * question — never separate git settings; the system derives the fork, the push
 * target and the standing-PR behaviour from the answer (choosePotIntegrationMode).
 *
 * Pure: wording + option building + availability. Every create path (the
 * pot:create_from_repo tool, the desktop new-pot form) and the pot settings
 * control render from here so the owner-approved wording cannot drift.
 */
import type { PotIntegrationMode } from './pot-integration-mode';

/** Owner-approved prompt (D-007). */
export const INTEGRATION_MODE_QUESTION = "Where should the agents' work go?";

/** Option label / description templates; `<repo>` is substituted with the repo label. */
export const INTEGRATION_MODE_OPTION_TEXT: Readonly<
  Record<PotIntegrationMode, { label: string; description: string }>
> = {
  direct: {
    label: 'Straight into <repo>',
    description: 'Agents commit directly, as today.',
  },
  review: {
    label: 'Into a working copy of <repo>',
    description:
      'Agents work freely there, and their combined work reaches <repo> only through PRs you (or a reviewer) approve.',
  },
};

export interface IntegrationModeOption {
  value: PotIntegrationMode;
  label: string;
  description: string;
  /** False when this answer cannot be chosen for this pot right now. */
  available: boolean;
  /** Why the option is unavailable (plain language), when it is. */
  unavailableReason?: string;
}

export interface IntegrationModeQuestion {
  prompt: string;
  options: IntegrationModeOption[];
  /** The answer used when the user does not choose: today's behaviour. */
  defaultValue: PotIntegrationMode;
}

export interface IntegrationModeQuestionInput {
  /** How the main repository is named to the user, e.g. "acme/widgets". */
  repoLabel: string;
  /**
   * Whether the pot has a real test suite (release.greenCmd / testCommand —
   * resolvePotSuiteCommand). Unknown (`undefined`) leaves the working copy
   * selectable; the create step re-checks and reports a refusal.
   */
  hasTestSuite?: boolean;
}

function fill(template: string, repoLabel: string): string {
  return template.split('<repo>').join(repoLabel);
}

/** Build the question with the repo name substituted and option availability. */
export function integrationModeQuestion(input: IntegrationModeQuestionInput): IntegrationModeQuestion {
  const repo = input.repoLabel.trim() || 'the main repository';
  const options = (['direct', 'review'] as const).map((value): IntegrationModeOption => {
    const text = INTEGRATION_MODE_OPTION_TEXT[value];
    const opt: IntegrationModeOption = {
      value,
      label: fill(text.label, repo),
      description: fill(text.description, repo),
      available: true,
    };
    if (value === 'review' && input.hasTestSuite === false) {
      opt.available = false;
      opt.unavailableReason =
        'This repository has no test suite, so a PR could not show the work passed tests. Add a test command first.';
    }
    return opt;
  });
  return { prompt: INTEGRATION_MODE_QUESTION, options, defaultValue: 'direct' };
}

/** Parse a user/tool answer; anything that is not a known mode reads as `null` (unanswered). */
export function parseIntegrationModeAnswer(v: unknown): PotIntegrationMode | null {
  return v === 'direct' || v === 'review' ? v : null;
}

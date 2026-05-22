'use client';

/**
 * Setup Wizard — sign-in step. Two cards: Anthropic (Claude) and
 * ChatGPT (via omp). All UI lives in the shared AuthSignInCards
 * component so /settings/api-keys can mount the same cards.
 */
import { AuthSignInCards } from '../AuthSignInCards';

export function StepLogins() {
  return (
    <AuthSignInCards
      intro={
        "Sign in to your accounts. Clicking a button opens that provider's " +
        'OAuth flow in a terminal right here — the CLI prints a link, you ' +
        'sign in in your browser, and it captures the token automatically.'
      }
    />
  );
}

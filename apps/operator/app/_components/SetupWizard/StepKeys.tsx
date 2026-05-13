'use client';

import RouteLink from '../RouteLink';

export function StepKeys() {
  return (
    <div className="pc-step">
      <div className="pc-warn-banner">
        <strong>This app is alpha.</strong> It can have significant bugs that cause unexpected API
        usage. Please set spending limits on each provider's website so a runaway loop can't eat
        your spend.
      </div>

      <KeyCard
        title="OpenAI — embeddings"
        required
        description={
          <>
            Powers semantic search across your harnesses, memory, and code. Uses{' '}
            <code>text-embedding-3-small</code> — very low cost per call (under $0.02 per million
            tokens at the time of writing).
          </>
        }
        unlocks="Semantic search in chat and harnesses, embeddings-backed memory recall."
        cost="Pennies per month for typical usage."
        howToGet={
          <>
            Create one at{' '}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
              platform.openai.com/api-keys ↗
            </a>{' '}
            and set a monthly spend limit at{' '}
            <a href="https://platform.openai.com/account/limits" target="_blank" rel="noreferrer">
              platform.openai.com/account/limits ↗
            </a>
            .
          </>
        }
      />

      <KeyCard
        title="ElevenLabs — voice (optional)"
        description={<>Powers spoken voice modes. <strong>Skip this if you don't want voice.</strong></>}
        unlocks="High-quality TTS for the operator and harness narration."
        cost={
          <ul className="pc-cost-modes">
            <li>
              <strong>Single-utterance</strong>: cheapest. Voice only fires when you say something
              and waits for you to push-to-talk. Typical cost: cents per session.
            </li>
            <li>
              <strong>Hybrid</strong>: moderate. Picovoice wake-word listens locally; only audio
              after wake-word goes to ElevenLabs. Typical cost: low single-digit $ per day of active
              use.
            </li>
            <li>
              <strong>Continuous</strong>: most expensive. Mic streams while the app is open. Best
              for hands-free workflows. Typical cost: $5–20+ per day of active use.
            </li>
          </ul>
        }
        howToGet={
          <>
            Create one at{' '}
            <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">
              elevenlabs.io/app/settings/api-keys ↗
            </a>{' '}
            and set a monthly cap in their billing page.
          </>
        }
      />

      <p className="pc-step__hint">
        Manage these and others (Anthropic, Google, Picovoice, etc.) at{' '}
        <RouteLink href="/settings/api-keys" style={{ color: 'var(--accent)' }}>
          Settings → API keys
        </RouteLink>
        .
      </p>
    </div>
  );
}

function KeyCard({
  title,
  description,
  unlocks,
  cost,
  howToGet,
  required,
}: {
  title: string;
  description: React.ReactNode;
  unlocks: string;
  cost: React.ReactNode;
  howToGet: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div className="pc-key-card">
      <div className="pc-key-card__head">
        <h3>{title}</h3>
        {required && <span className="pc-badge pc-badge--required">Required for semantic search</span>}
        {!required && <span className="pc-badge pc-badge--optional">Optional</span>}
      </div>
      <p className="pc-key-card__desc">{description}</p>
      <dl className="pc-key-card__dl">
        <dt>What it unlocks</dt>
        <dd>{unlocks}</dd>
        <dt>Expected cost</dt>
        <dd>{cost}</dd>
        <dt>How to obtain</dt>
        <dd>{howToGet}</dd>
      </dl>
    </div>
  );
}

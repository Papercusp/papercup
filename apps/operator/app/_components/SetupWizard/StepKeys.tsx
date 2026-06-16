'use client';

import { useEffect, useState } from 'react';
import RouteLink from '../RouteLink';
import { useLexicon } from '@/lib/useLexicon';

export function StepKeys() {
  const t = useLexicon();
  const [loaded, setLoaded] = useState(false);
  const [openaiMasked, setOpenaiMasked] = useState<string | null>(null);
  const [openaiInput, setOpenaiInput] = useState('');
  const [savingOpenai, setSavingOpenai] = useState(false);
  const [openaiSaved, setOpenaiSaved] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    void (async () => {
      try {
        const credsRes = await fetch('/api/credentials', { cache: 'no-store' });
        if (credsRes.ok) {
          const j = (await credsRes.json()) as { openai_api_key?: string | null };
          setOpenaiMasked(j.openai_api_key ?? null);
        }
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const saveOpenaiKey = async () => {
    const v = openaiInput.trim();
    if (!v) return;
    setSavingOpenai(true);
    setOpenaiSaved('idle');
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ openai_api_key: v }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = (await res.json()) as { openai_api_key?: string | null };
      setOpenaiMasked(j.openai_api_key ?? null);
      setOpenaiInput('');
      setOpenaiSaved('saved');
    } catch {
      setOpenaiSaved('error');
    } finally {
      setSavingOpenai(false);
    }
  };

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
        unlocks={`Semantic search in chat and ${t('pot', { plural: true, lower: true })}, embeddings-backed memory recall.`}
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
      >
        <div className="pc-key-card__input" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>API key</span>
            {openaiMasked && (
              <span
                style={{
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 12,
                  color: 'var(--fg-mute, #888)',
                  background: 'var(--bg-2, rgba(0,0,0,0.08))',
                  padding: '2px 6px',
                  borderRadius: 3,
                }}
              >
                saved: {openaiMasked}
              </span>
            )}
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={openaiMasked ? 'paste a new key to replace' : 'sk-…'}
              value={openaiInput}
              onChange={(e) => {
                setOpenaiInput(e.target.value);
                if (openaiSaved !== 'idle') setOpenaiSaved('idle');
              }}
              disabled={!loaded || savingOpenai}
              style={{
                flex: '1 1 280px',
                minWidth: 200,
                padding: '6px 10px',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 13,
                border: '1px solid var(--border, #ccc)',
                borderRadius: 4,
                background: 'var(--bg, #fff)',
                color: 'var(--fg, #111)',
              }}
            />
            <button
              type="button"
              onClick={() => void saveOpenaiKey()}
              disabled={!loaded || savingOpenai || !openaiInput.trim()}
              style={{
                padding: '6px 14px',
                fontSize: 13,
                fontWeight: 600,
                border: 'none',
                borderRadius: 4,
                background: 'var(--accent, #5e6ad2)',
                color: 'white',
                cursor: savingOpenai || !openaiInput.trim() ? 'not-allowed' : 'pointer',
                opacity: savingOpenai || !openaiInput.trim() ? 0.6 : 1,
              }}
            >
              {savingOpenai ? 'Saving…' : openaiMasked ? 'Replace' : 'Save'}
            </button>
            {openaiSaved === 'saved' && (
              <span style={{ color: 'var(--good, #3fb950)', fontSize: 12 }}>Saved.</span>
            )}
            {openaiSaved === 'error' && (
              <span style={{ color: 'var(--bad, #f85149)', fontSize: 12 }}>Save failed — try again.</span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--fg-mute, #888)' }}>
            Stored in your local workspace credentials. Never broadcast over WebSocket.
          </p>
        </div>
      </KeyCard>

      <KeyCard
        title="ElevenLabs — voice (optional)"
        description={<>Powers spoken voice modes. <strong>Skip this if you don't want voice.</strong></>}
        unlocks={`High-quality TTS for the operator and ${t('pot', { lower: true })} narration.`}
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
  children,
}: {
  title: string;
  description: React.ReactNode;
  unlocks: string;
  cost: React.ReactNode;
  howToGet: React.ReactNode;
  required?: boolean;
  children?: React.ReactNode;
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
      {children}
    </div>
  );
}

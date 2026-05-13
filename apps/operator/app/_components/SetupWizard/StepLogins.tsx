'use client';

import { useEffect, useState } from 'react';
import { commands } from '@/lib/tauri-bindings';
import { isTauri } from './tauri-detect';

interface Provider {
  readonly id: 'claude' | 'openai';
  readonly title: string;
  readonly summary: string;
  readonly cmd: string;
}

const PROVIDERS: readonly Provider[] = [
  {
    id: 'claude',
    title: 'Claude account',
    summary:
      "If you have a Claude Pro or Max plan, sign in once and your subscription covers Claude Code usage — no per-token API charges. (Papercusp uses Meridian to route Claude traffic; if your shell isn't already configured for that, the login still works but goes direct to Anthropic.)",
    cmd: 'claude /login',
  },
  {
    id: 'openai',
    title: 'OpenAI account',
    summary:
      "If you have a ChatGPT Plus, Team, or Pro plan, sign in once and your subscription covers Codex usage. No per-token API charges.",
    cmd: 'omp /login',
  },
];

export function StepLogins() {
  const [tauri, setTauri] = useState(false);
  const [busy, setBusy] = useState<Provider['id'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTauri(isTauri());
  }, []);

  const launch = async (p: Provider) => {
    setBusy(p.id);
    setError(null);
    try {
      const envelopeRes = await fetch('/api/desktop/agent-login-envelope', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: p.id }),
      });
      if (!envelopeRes.ok) throw new Error(`envelope: ${envelopeRes.status}`);
      const envelope = await envelopeRes.json();
      const result = await commands.consoleLaunch(envelope);
      if (result.status === 'err') throw new Error(result.error);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Each coding agent has two ways to authenticate: <strong>account login</strong> (uses your
        existing subscription — no per-token cost) or <strong>API key</strong> (pay-per-use; covered
        in the next step). Account login is preferred when available.
      </p>
      <p className="pc-step__hint">
        You'll always find these buttons on this screen — they're not just for first-run. Switching
        accounts or re-authenticating later is one click away.
      </p>
      <div className="pc-provider-grid">
        {PROVIDERS.map((p) => (
          <div key={p.id} className="pc-provider-card">
            <h3 className="pc-provider-card__title">{p.title}</h3>
            <p className="pc-provider-card__summary">{p.summary}</p>
            {tauri ? (
              <button
                type="button"
                className="pc-btn pc-btn--primary"
                disabled={busy !== null}
                onClick={() => void launch(p)}
              >
                {busy === p.id ? 'Opening terminal…' : `Sign in to ${p.title.replace(' account', '')}`}
              </button>
            ) : (
              <>
                <p className="pc-provider-card__instructions">
                  Run this in a terminal — the CLI opens a browser tab for OAuth and captures the
                  token automatically.
                </p>
                <pre className="pc-code">{p.cmd}</pre>
              </>
            )}
          </div>
        ))}
      </div>
      {error && (
        <div className="pc-step__progress" data-status="error" style={{ marginTop: 8 }}>
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Couldn't open terminal.</strong>
            <span>{error}</span>
          </div>
        </div>
      )}
    </div>
  );
}

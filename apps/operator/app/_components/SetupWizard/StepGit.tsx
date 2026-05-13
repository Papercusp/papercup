'use client';

import { useEffect, useState } from 'react';
import { commands } from '@/lib/tauri-bindings';
import { isTauri } from './tauri-detect';

interface GitIdentity {
  name?: string;
  email?: string;
  source?: 'global' | 'system' | 'none';
}

export function StepGit() {
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [tauri, setTauri] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTauri(isTauri());
    void (async () => {
      try {
        const r = await fetch('/api/desktop/git-identity', { cache: 'no-store' });
        if (r.ok) {
          const j = (await r.json()) as GitIdentity;
          setIdentity(j);
        } else {
          setIdentity({ source: 'none' });
        }
      } catch {
        setIdentity({ source: 'none' });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signInGitHub = async () => {
    setSigningIn(true);
    setError(null);
    try {
      const envelopeRes = await fetch('/api/desktop/agent-login-envelope', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github' }),
      });
      if (!envelopeRes.ok) throw new Error(`envelope: ${envelopeRes.status}`);
      const envelope = await envelopeRes.json();
      const result = await commands.consoleLaunch(envelope);
      if (result.status === 'err') throw new Error(result.error);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSigningIn(false);
    }
  };

  const configured = Boolean(identity?.name && identity?.email);

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Every commit Papercusp makes — on your behalf or via an agent — needs a name and email. We
        read these from your existing <code>git config</code>; nothing to set up if you've used git
        before.
      </p>
      <div className="pc-step__progress" data-status={loading ? 'loading' : configured ? 'ok' : 'missing'}>
        <div className="pc-step__progress-dot" />
        <div className="pc-step__progress-text">
          {loading && <span>Checking…</span>}
          {!loading && configured && (
            <>
              <strong>Ready.</strong>
              <span>
                {identity?.name} &lt;{identity?.email}&gt; (from {identity?.source ?? 'config'})
              </span>
            </>
          )}
          {!loading && !configured && (
            <>
              <strong>Not configured.</strong>
              <span>Run the commands below in a terminal.</span>
            </>
          )}
        </div>
      </div>
      {!configured && !loading && (
        <pre className="pc-code">{`git config --global user.name "Your Name"
git config --global user.email "you@example.com"`}</pre>
      )}

      <div className="pc-divider" />

      <h3 className="pc-consent__heading">GitHub (optional)</h3>
      <p className="pc-step__hint">
        Pushing to private repos + opening PRs needs a GitHub auth. The simplest path is the
        GitHub CLI — <code>gh auth login</code> stores a token in your system keychain that{' '}
        <code>git</code> picks up automatically.
      </p>
      {tauri ? (
        <div className="pc-step__actions">
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            onClick={() => void signInGitHub()}
            disabled={signingIn}
          >
            {signingIn ? 'Opening terminal…' : 'Sign in to GitHub'}
          </button>
        </div>
      ) : (
        <pre className="pc-code">gh auth login</pre>
      )}
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

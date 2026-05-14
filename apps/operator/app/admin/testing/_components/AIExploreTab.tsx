'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import Button from '../../../harness/Button';

interface MaskedCoreCredentials {
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  github_pat: string | null;
  updated_at: string | null;
  path: string;
}

export default function AIExploreTab() {
  const [creds, setCreds] = useState<MaskedCoreCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [showInput, setShowInput] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/credentials')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setCreds(d); })
      .catch(() => { /* leave creds null — treat as not configured */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function saveKey() {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      const r = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anthropic_api_key: keyInput.trim() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: MaskedCoreCredentials = await r.json();
      setCreds(d);
      setKeyInput('');
      setShowInput(false);
      toast.success(`Saved to ${d.path}`);
    } catch (err) {
      toast.error(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  const hasKey = !!creds?.anthropic_api_key;

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">AI Explore</h1>
          <p className="pc-test-tab-intro">
            Goal-directed exploration via Stagehand + Anthropic. Describe what a user is trying
            to do; the LLM drives Playwright against the dev webapp and records perf metrics for
            each step. Slower than Chaos but finds workflow breakage that random clicks miss.
          </p>
        </div>
      </header>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Anthropic API key</h2>
        {loading ? (
          <p style={{ color: 'var(--fg-mute)', margin: 0 }}>Loading…</p>
        ) : hasKey && !showInput ? (
          <>
            <div className="pc-test-card-row">
              <span className="pc-test-badge is-good">configured</span>
              <code style={{ fontSize: 12, color: 'var(--fg-mute)' }}>{creds!.anthropic_api_key}</code>
              {creds?.updated_at && (
                <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                  updated {new Date(creds.updated_at).toLocaleString()}
                </span>
              )}
            </div>
            <div className="pc-test-card-row">
              <Button variant="ghost" onClick={() => setShowInput(true)}>Replace key</Button>
              <a href="/settings/api-keys" style={{ fontSize: 12, color: 'var(--accent)' }}>
                Manage in Settings →
              </a>
            </div>
          </>
        ) : (
          <>
            {!hasKey && (
              <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 0 }}>
                Not configured. Paste an Anthropic API key below — it's stored at{' '}
                <code>{creds?.path ?? '~/.papercusp/credentials.json'}</code>, file-mode 600.
              </p>
            )}
            <div className="pc-test-card-row">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-ant-…"
                style={{ flex: 1, minWidth: 320, fontFamily: 'ui-monospace, monospace' }}
                disabled={saving}
              />
              <Button variant="primary" onClick={saveKey} disabled={saving || !keyInput.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {showInput && (
                <Button variant="ghost" onClick={() => { setShowInput(false); setKeyInput(''); }}>
                  Cancel
                </Button>
              )}
            </div>
            <p style={{ fontSize: 11, color: 'var(--fg-mute)', margin: '8px 0 0' }}>
              Key is sent server-side over loopback only. Same store as the rest of the operator
              (<a href="/settings/api-keys" style={{ color: 'var(--accent)' }}>/settings/api-keys</a>).
            </p>
          </>
        )}
      </div>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Run (not wired yet)</h2>
        <p style={{ margin: 0, color: 'var(--fg-mute)' }}>
          Stagehand 3.4.0 is installed. Still needs: server route to spawn the Playwright
          subprocess, env-var plumbing for the saved key, a per-run cost cap. Tracked in
          <code> apps/operator/docs/plans/tests-page-2026-05-14.md</code>.
        </p>
      </div>
    </>
  );
}

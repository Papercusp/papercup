'use client';

import { useState, useCallback } from 'react';
import { parseHarnessLink, formatParseError } from '@papercusp/operator-core/lib/harness/harness-link-types';
// Import the step vocabulary from the dependency-free leaf, NOT join-shared-harness
// (which pulls node:child_process/fs/os + the identity chain into the SPA bundle).
import { ALL_STEP_IDS } from '@papercusp/operator-core/lib/harness/join-steps';
import type { JoinStepState, JoinStepStatus } from '@papercusp/operator-core/lib/harness/join-steps';
import { JoinProgress } from './JoinProgress';

interface Props {
  onBack: () => void;
  onCreated: (harnessSlug: string) => void;
}

type Phase = 'input' | 'preview' | 'joining' | 'done' | 'error';

function initialSteps(): JoinStepState[] {
  return ALL_STEP_IDS.map((id) => ({ id, status: 'pending' as JoinStepStatus }));
}

export function EntryHarnessLinkForm({ onBack, onCreated }: Props) {
  const [url, setUrl] = useState('');
  const [parseError, setParseError] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [steps, setSteps] = useState<JoinStepState[]>(initialSteps());
  const [insightsPath, setInsightsPath] = useState<string | undefined>();
  const [fatalError, setFatalError] = useState('');

  const parsed = url.trim() ? parseHarnessLink(url.trim()) : null;

  const handlePreview = useCallback(() => {
    if (!url.trim()) return;
    const result = parseHarnessLink(url.trim());
    if (!result.ok) {
      setParseError(formatParseError(result.error));
      return;
    }
    setParseError('');
    setPhase('preview');
  }, [url]);

  const handleJoin = useCallback(async () => {
    if (!parsed?.ok) return;
    const slug = parsed.payload.github_repo;
    setPhase('joining');
    setSteps(initialSteps());
    setFatalError('');

    try {
      const res = await fetch('/api/harness/join-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          harnessLinkUrl: url.trim(),
          // Identity (token, githubUserId, githubLogin) is resolved server-side
          // by the endpoint from the local `gh` CLI auth state (Task 7, D-004).
          // Do NOT send credentials from the UI — the server returns 401
          // gh_auth_required when `gh` is not authenticated.
        }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Surface the error with as much step context as possible.
        const code: string = (body as { code?: string }).code ?? '';
        const errMsg: string = (body as { error?: string }).error ?? `HTTP ${res.status}`;

        if (res.status === 401 || code === 'gh_auth_required') {
          setFatalError(
            'GitHub authentication required. Run `gh auth login` in your terminal, then retry.',
          );
          setSteps((prev) =>
            prev.map((s) =>
              s.id === 'oauth_attest'
                ? { id: s.id, status: 'error', detail: 'Not authenticated', errorCode: 'gh_auth_required' }
                : s,
            ),
          );
        } else if (code === 'slug_conflict') {
          setFatalError(`Harness slug '${slug}' is already registered in this workspace.`);
        } else if (!body.state) {
          // Pre-step error (bad input, etc.)
          setFatalError(errMsg);
          // Mark oauth_attest as error so user sees where it stopped.
          setSteps((prev) =>
            prev.map((s) =>
              s.id === 'oauth_attest'
                ? { id: s.id, status: 'error', detail: errMsg, errorCode: code }
                : s,
            ),
          );
        } else {
          // Step-level error — use the returned state to show progress.
          const state = body.state as { steps?: Record<string, JoinStepState> };
          if (state.steps) {
            setSteps(ALL_STEP_IDS.map((id) => state.steps![id] ?? { id, status: 'pending' as JoinStepStatus }));
          }
          setFatalError(errMsg);
        }
        setPhase('error');
        return;
      }

      // Success path.
      const state = body.state as { steps?: Record<string, JoinStepState>; insightsPath?: string };
      if (state.steps) {
        setSteps(ALL_STEP_IDS.map((id) => state.steps![id] ?? { id, status: 'pending' as JoinStepStatus }));
      }
      const iPath = state.insightsPath ?? `/harness/${encodeURIComponent(slug)}/insights`;
      setInsightsPath(iPath);
      setPhase('done');
      onCreated(slug);
    } catch (err: unknown) {
      setFatalError((err as Error).message ?? 'Network error');
      setPhase('error');
    }
  }, [parsed, url, onCreated]);

  if (phase === 'joining' || phase === 'done' || phase === 'error') {
    return (
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>
          {phase === 'joining' ? 'Joining harness…' : phase === 'done' ? 'Joined!' : 'Join failed'}
        </h2>
        {parsed?.ok && (
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--fg-dim)' }}>
            {parsed.payload.github_owner}/{parsed.payload.github_repo}
          </p>
        )}
        <JoinProgress steps={steps} insightsPath={insightsPath} fatalError={fatalError || undefined} />
        {phase === 'error' && (
          <div style={{ marginTop: 14, textAlign: 'right' }}>
            <button
              type="button"
              onClick={onBack}
              style={{ fontSize: 12, padding: '5px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', color: 'var(--fg-dim)' }}
            >
              Back
            </button>
          </div>
        )}
      </div>
    );
  }

  if (phase === 'preview' && parsed?.ok) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setPhase('input')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-dim)', fontSize: 12, padding: '0 0 12px', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          ← Back
        </button>
        <h2 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600 }}>Confirm join</h2>
        <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
          <p style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>
            {parsed.payload.github_owner}/{parsed.payload.github_repo}
          </p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-dim)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            topic: {parsed.payload.topic.slice(0, 16)}…
          </p>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
          This will clone the repository and register your device as a contributor.
          GitHub authentication is required.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={() => setPhase('input')}
            style={{ padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: 'pointer' }}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => void handleJoin()}
            style={{ padding: '7px 16px', fontSize: 13, background: 'var(--accent, #6366f1)', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 500 }}
          >
            Join harness
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-dim)', fontSize: 12, padding: '0 0 12px', display: 'flex', alignItems: 'center', gap: 4 }}
      >
        ← Back
      </button>
      <h2 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600 }}>Harness link</h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
        Paste a <code style={{ fontFamily: 'monospace', fontSize: 12 }}>papercusp://harness?…</code> link shared by a harness owner.
      </p>
      <div style={{ marginBottom: 4 }}>
        <label htmlFor="harness-link-input" style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 6, color: 'var(--fg-dim)' }}>
          Harness link
        </label>
        <textarea
          id="harness-link-input"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setParseError(''); }}
          rows={3}
          placeholder="papercusp://harness?topic=…&github=owner/repo&repo_id=…"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            fontFamily: 'monospace',
            fontSize: 12,
            padding: '8px 10px',
            border: parseError ? '1px solid var(--red, #ef4444)' : '1px solid var(--border)',
            borderRadius: 5,
            background: 'var(--bg)',
            color: 'var(--fg)',
            resize: 'vertical',
          }}
        />
        {parseError && (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--red, #ef4444)' }}>{parseError}</p>
        )}
      </div>
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: 'pointer' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handlePreview}
          disabled={!url.trim()}
          style={{ padding: '7px 16px', fontSize: 13, background: url.trim() ? 'var(--accent, #6366f1)' : 'var(--bg-2)', color: url.trim() ? '#fff' : 'var(--fg-dim)', border: 'none', borderRadius: 5, cursor: url.trim() ? 'pointer' : 'not-allowed', fontWeight: 500 }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

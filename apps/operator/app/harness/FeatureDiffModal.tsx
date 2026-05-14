'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';

interface Props {
  slug: string;
  featureId: string;
  onClose: () => void;
}

export default function FeatureDiffModal({ slug, featureId, onClose }: Props) {
  const [data, setData] = useState<{ stat: string; diff: string; base: string; branch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/harness/${slug}/features/${featureId}/diff`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `${r.status}`);
      }
      setData(await r.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [slug, featureId]);

  useEffect(() => { load(); }, [load]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Feature diff`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '88vw', maxWidth: 1200, height: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: 'var(--fg)' }}
    >
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Feature diff — {featureId}</strong>
          {data && (
            <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>
              {data.base}...{data.branch}
            </span>
          )}
          <button
            onClick={load}
            style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.75rem' }}
          >
            refresh
          </button>
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '2rem', color: 'var(--fg-mute)' }}>loading…</div>
        ) : error ? (
          <div style={{ padding: '1rem', color: '#f87171', fontSize: '0.8rem' }}>
            <div><strong>Diff unavailable.</strong> Likely the feature branch doesn't exist (branch isolation may be disabled, or the worker hasn't run yet).</div>
            <pre style={{ marginTop: '0.5rem', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: '#fca5a5', whiteSpace: 'pre-wrap' }}>{error}</pre>
          </div>
        ) : data ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <pre style={{ padding: '0.5rem 1rem', margin: 0, fontSize: '0.75rem', fontFamily: 'ui-monospace, monospace', color: '#d1d5db', whiteSpace: 'pre', borderBottom: '1px solid var(--border)', background: 'var(--bg-2)', maxHeight: '20vh', overflow: 'auto' }}>
              {data.stat || '(no changes)'}
            </pre>
            <div style={{ flex: 1, overflow: 'auto', padding: '0.5rem 1rem', background: 'var(--bg)', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem' }}>
              {data.diff.length === 0 ? (
                <div style={{ color: 'var(--fg-mute)' }}>(no diff output)</div>
              ) : (
                <pre style={{ margin: 0, whiteSpace: 'pre' }}>
                  {data.diff.split('\n').map((line, i) => {
                    let color = '#d1d5db';
                    if (line.startsWith('+') && !line.startsWith('+++')) color = '#6ee7b7';
                    else if (line.startsWith('-') && !line.startsWith('---')) color = '#fca5a5';
                    else if (line.startsWith('@@')) color = '#818cf8';
                    else if (line.startsWith('diff --git')) color = '#fbbf24';
                    return <div key={i} style={{ color }}>{line}</div>;
                  })}
                </pre>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
  );
}

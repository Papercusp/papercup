'use client';

import { memo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useQueryState, parseAsString } from 'nuqs';
import { Modal } from './Modal';

interface Identity {
  role: string;
  content: string;
  bytes: number;
  mtimeMs: number;
}

interface Props {
  onClose: () => void;
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function contentLines(s: string): number {
  return s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('<!--')).length;
}

function IdentityPanelInner({ onClose }: Props) {
  const [selected, setSelected] = useQueryState('identityRole', parseAsString);

  // Push-driven. Server emits `notifySyncInvalidate('harnessIdentity')`
  // from writeIdentity / flipExpertEngaged. The SSEAdapter mounted by
  // HarnessZeroProvider (root layout) matches `queryKey[1] === 'harnessIdentity'`
  // and invalidates → react-query refetches. No setInterval.
  const { data, error } = useQuery<{ identities: Identity[] }>({
    queryKey: ['sync', 'harnessIdentity', {}],
    queryFn: async ({ signal }) => {
      const r = await fetch('/api/harness/identity', { signal });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    staleTime: Infinity, // refetch only on SSE invalidate
  });
  const list = data?.identities ?? [];
  const err = error ? String(error) : null;

  // Auto-select first identity when data arrives.
  useEffect(() => {
    if (!selected && list.length > 0) setSelected(list[0].role);
  }, [list, selected, setSelected]);

  const cur = list.find((i) => i.role === selected);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Identity`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '85vw', maxWidth: 1200, height: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: 'var(--fg)' }}
    >
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Cross-mission identity</strong>
          <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>~/autonomous-harness/identity/</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--fg-mute)' }}>Agent-Swarm-inspired · curator-maintained · read on every role invocation</span>
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--fg-mute)' }}>auto-refresh 10s</span>
          {err && <span style={{ color: 'var(--bad)', fontSize: '0.75rem' }}>err: {err}</span>}
          <button onClick={onClose} style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}>close</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: '0 0 200px', borderRight: '1px solid var(--border)', overflow: 'auto' }}>
            {list.length === 0 ? (
              <div style={{ padding: '1rem', color: 'var(--fg-mute)', fontSize: '0.85rem', textAlign: 'center' }}>no identity files</div>
            ) : (
              list.map((i) => {
                const active = i.role === selected;
                const lines = contentLines(i.content);
                return (
                  <button
                    key={i.role}
                    onClick={() => setSelected(i.role)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '0.6rem 0.85rem',
                      background: active ? '#1f2937' : 'transparent',
                      color: 'var(--fg)', border: 'none', borderBottom: '1px solid var(--border)',
                      cursor: 'pointer', fontSize: '0.85rem',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{i.role}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--fg-mute)', marginTop: 2 }}>
                      {lines} lessons · {i.bytes}b · {fmtTs(i.mtimeMs)}
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.25rem' }}>
            {cur ? (
              <pre style={{
                margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: 'var(--fg)',
              }}>{cur.content || '(empty — curator will populate as missions run)'}</pre>
            ) : (
              <div style={{ color: 'var(--fg-mute)', fontStyle: 'italic', marginTop: '20%', textAlign: 'center' }}>
                Select a role on the left.
              </div>
            )}
          </div>
        </div>
      </Modal>
  );
}

const IdentityPanel = memo(IdentityPanelInner);
export default IdentityPanel;

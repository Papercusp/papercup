'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { MarkdownPreview } from '../_components/MarkdownEditor';

interface Checkpoint {
  name: string;
  content: string;
  waitingSinceMs: number;
  granted: boolean;
}

interface Props {
  slug: string;
  onGranted?: () => void;
}

function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function CheckpointBanner({ slug, onGranted }: Props) {
  const [list, setList] = useState<Checkpoint[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${slug}/checkpoints`);
      if (!r.ok) throw new Error(`${r.status}`);
      const d = await r.json();
      setList(d.checkpoints ?? []);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const grant = useCallback(async (name: string) => {
    setBusy(name);
    try {
      const r = await fetch(`/api/harness/${slug}/checkpoint/${encodeURIComponent(name)}/grant`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      await load();
      onGranted?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }, [slug, load, onGranted]);

  if (list.length === 0) return null;

  return (
    <div style={{
      background: 'color-mix(in oklab, #f59e0b, transparent 85%)',
      border: '1px solid #d97706',
      borderRadius: 6,
      padding: '0.75rem 1rem',
      margin: '0.5rem 0',
      color: '#fde68a',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: list.length > 1 ? 8 : 0 }}>
        <span style={{ fontSize: '1.1rem' }}>⏸</span>
        <strong>{list.length} checkpoint{list.length === 1 ? '' : 's'} awaiting approval</strong>
        <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: '#d1d5db' }}>auto-refresh 5s</span>
        {err && <span style={{ color: '#f87171', fontSize: '0.75rem' }}>err: {err}</span>}
      </div>

      {list.map((cp) => {
        const isExpanded = expanded === cp.name;
        return (
          <Collapsible.Root
            key={cp.name}
            open={isExpanded}
            onOpenChange={(o) => setExpanded(o ? cp.name : null)}
          >
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 6,
              padding: '0.5rem 0', borderTop: list.indexOf(cp) > 0 ? '1px solid rgba(255,255,255,0.08)' : undefined,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <code style={{ fontSize: '0.85rem', color: '#fde68a', fontWeight: 600 }}>{cp.name}</code>
                <span style={{ fontSize: '0.75rem', color: '#d1d5db' }}>waiting {fmtAge(cp.waitingSinceMs)}</span>
                {cp.granted && <span style={{ fontSize: '0.7rem', color: '#10b981' }}>✓ granted</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <Collapsible.Trigger asChild>
                    <button
                      style={{
                        background: 'transparent',
                        border: '1px solid rgba(255,255,255,0.2)',
                        color: '#fde68a', padding: '0.25rem 0.6rem',
                        borderRadius: 3, cursor: 'pointer', fontSize: '0.75rem',
                      }}
                    >
                      {isExpanded ? 'hide' : 'details'}
                    </button>
                  </Collapsible.Trigger>
                  {!cp.granted && (
                    <button
                      onClick={() => grant(cp.name)}
                      disabled={busy === cp.name}
                      style={{
                        background: '#10b981', color: 'white', border: 'none',
                        padding: '0.25rem 0.75rem', borderRadius: 3,
                        cursor: busy === cp.name ? 'wait' : 'pointer',
                        fontSize: '0.8rem', fontWeight: 600,
                      }}
                    >
                      {busy === cp.name ? '…' : 'Grant'}
                    </button>
                  )}
                </span>
              </div>
              <Collapsible.Content>
                <div style={{
                  margin: 0,
                  background: 'rgba(0,0,0,0.3)',
                  padding: '0.6rem 0.8rem', borderRadius: 3,
                  maxHeight: 240, overflow: 'auto',
                }}>
                  <MarkdownPreview value={cp.content || '(no content)'} />
                </div>
              </Collapsible.Content>
            </div>
          </Collapsible.Root>
        );
      })}

      {list.some((c) => c.granted) && (
        <div style={{ marginTop: 6, fontSize: '0.75rem', color: '#d1d5db' }}>
          Granted checkpoints require the harness to be re-run to consume the grant.
        </div>
      )}
    </div>
  );
}

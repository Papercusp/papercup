/**
 * LayoutsMenu — save, switch, and reset named dock layouts.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §4.9
 *
 * Three operations:
 *   - "Save current as…" — prompt for name, PUT current toJSON()
 *     under that layout name
 *   - "Switch to…" — dispatch loadLayout(name) which HarnessDock
 *     listens for
 *   - "Reset to default" — dispatch resetLayout() event
 *
 * The list of layouts is fetched from /api/dock-layouts/_list on open
 * and cached until the menu reopens.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Layers, X } from 'lucide-react';
import {
  getLayoutSnapshot,
  loadLayout,
  resetLayout,
} from './dock-actions';

interface LayoutListItem {
  name: string;
  updatedTs: number;
}

interface LayoutsResponse {
  layouts: LayoutListItem[];
}

export function LayoutsMenu({
  currentLayoutName,
  className,
}: {
  currentLayoutName?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<LayoutListItem[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/dock-layouts/_list');
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j: LayoutsResponse = await r.json();
      setList(j.layouts.sort((a, b) => b.updatedTs - a.updatedTs));
    } catch (e) {
      setError(e as Error);
      setList([]);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const saveAs = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const name = window.prompt('Save current layout as:');
    if (!name || !name.trim()) return;
    const sanitized = name.trim();
    setSaving(true);
    try {
      const layout = getLayoutSnapshot();
      const r = await fetch(
        `/api/dock-layouts/${encodeURIComponent(sanitized)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layout }),
        },
      );
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`PUT failed (${r.status}): ${text}`);
      }
      await refresh();
    } catch (e) {
      setError(e as Error);
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const switchTo = (name: string) => {
    setOpen(false);
    loadLayout(name);
  };

  const reset = () => {
    setOpen(false);
    resetLayout();
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }} className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Layouts menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Save, switch, or reset named layouts"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 8px',
          fontSize: 11,
          background: 'var(--card, #1a1a1a)',
          color: 'var(--foreground, #ccc)',
          border: '1px solid var(--border, #333)',
          borderRadius: 3,
          cursor: 'pointer',
        }}
      >
        <Layers size={12} aria-hidden />
        Layouts
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 998 }}
            aria-hidden
          />
          <div
            role="menu"
            aria-label="Layouts"
            style={{
              position: 'absolute',
              top: 28,
              right: 0,
              minWidth: 240,
              maxHeight: 360,
              overflowY: 'auto',
              background: 'var(--card, #1a1a1a)',
              border: '1px solid var(--border, #333)',
              borderRadius: 4,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              zIndex: 999,
              padding: 4,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '6px 10px',
                fontSize: 11,
                color: 'var(--muted-foreground, #888)',
                borderBottom: '1px solid var(--border, #333)',
                marginBottom: 2,
              }}
            >
              <span>Layouts</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  marginLeft: 'auto',
                  background: 'transparent',
                  border: 0,
                  color: 'var(--muted-foreground, #888)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  padding: 2,
                }}
              >
                <X size={12} aria-hidden />
              </button>
            </div>

            <button
              type="button"
              onClick={() => void saveAs()}
              disabled={saving}
              style={menuBtnStyle()}
            >
              {saving ? 'Saving…' : '+ Save current as…'}
            </button>
            <button type="button" onClick={reset} style={menuBtnStyle()}>
              ↺ Reset to default
            </button>

            <div
              style={{
                height: 1,
                background: 'var(--border, #333)',
                margin: '4px 0',
              }}
            />

            {error && (
              <div style={{ padding: '6px 10px', color: '#f87171', fontSize: 11 }}>
                {error.message}
              </div>
            )}
            {!list && !error && (
              <div
                style={{ padding: '6px 10px', color: 'var(--muted-foreground, #888)', fontSize: 11 }}
              >
                Loading…
              </div>
            )}
            {list && list.length === 0 && (
              <div
                style={{ padding: '6px 10px', color: 'var(--muted-foreground, #888)', fontSize: 11 }}
              >
                No saved layouts yet.
              </div>
            )}
            {list &&
              list.map((l) => {
                const isCurrent = currentLayoutName === l.name;
                return (
                  <button
                    key={l.name}
                    type="button"
                    onClick={() => switchTo(l.name)}
                    disabled={isCurrent}
                    style={menuBtnStyle(isCurrent)}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 8,
                        justifyContent: 'space-between',
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>{l.name}</span>
                      {isCurrent && (
                        <span style={{ fontSize: 10, color: 'var(--muted-foreground, #888)' }}>
                          current
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--muted-foreground, #888)',
                      }}
                    >
                      saved {ageOf(l.updatedTs)}
                    </div>
                  </button>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}

function ageOf(ts: number): string {
  const age = Date.now() - ts;
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

function menuBtnStyle(disabled = false): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '6px 10px',
    fontSize: 12,
    background: 'transparent',
    color: disabled ? 'var(--muted-foreground, #888)' : 'var(--foreground, #ccc)',
    border: 0,
    borderRadius: 3,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

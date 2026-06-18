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

import { Tooltip } from '@/app/harness/Tooltip';
import { useCallback, useEffect, useState } from 'react';
import { Layers, X } from 'lucide-react';
import { usePromptDialog } from '../usePromptDialog';
import { Popover } from '../Popover';
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
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

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

  const saveAs = useCallback(async () => {
    const name = await askPrompt({
      title: 'Save current layout',
      label: 'Name',
      placeholder: 'e.g. my-dashboard',
      submitLabel: 'Save',
      validate: (v) => (v.trim().length > 0 ? null : 'Required'),
    });
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
  }, [refresh, askPrompt]);

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
      {promptEl}
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="end"
        sideOffset={4}
        ariaLabel="Layouts"
        contentStyle={{
          minWidth: 240,
          maxHeight: 360,
          overflowY: 'auto',
          background: 'var(--bg-2)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          boxShadow: '0 8px 24px color-mix(in oklab, black, transparent 50%)',
          padding: 4,
          zIndex: 999,
        }}
        trigger={
        <button
        type="button"
        aria-label="Layouts menu"
        aria-haspopup="menu"
        aria-expanded={open}

        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 8px',
          fontSize: 11,
          background: 'var(--bg-2)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          borderRadius: 3,
          cursor: 'pointer',
        }}
      >
        <Layers size={12} aria-hidden />
        Layouts
      </button>
        }
      >
          <div role="menu" aria-label="Layouts">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '6px 10px',
                fontSize: 11,
                color: 'var(--fg-mute)',
                borderBottom: '1px solid var(--border)',
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
                  color: 'var(--fg-mute)',
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
                background: 'var(--border)',
                margin: '4px 0',
              }}
            />

            {error && (
              <div style={{ padding: '6px 10px', color: 'var(--bad)', fontSize: 11 }}>
                {error.message}
              </div>
            )}
            {!list && !error && (
              <div
                style={{ padding: '6px 10px', color: 'var(--fg-mute)', fontSize: 11 }}
              >
                Loading…
              </div>
            )}
            {list && list.length === 0 && (
              <div
                style={{ padding: '6px 10px', color: 'var(--fg-mute)', fontSize: 11 }}
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
                        <span style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
                          current
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--fg-mute)',
                      }}
                    >
                      saved {ageOf(l.updatedTs)}
                    </div>
                  </button>
                );
              })}
          </div>
      </Popover>
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
    color: disabled ? 'var(--fg-mute)' : 'var(--fg)',
    border: 0,
    borderRadius: 3,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

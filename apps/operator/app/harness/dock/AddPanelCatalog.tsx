/**
 * AddPanelCatalog — modal-ish picker for "+ Add panel".
 *
 * Lists every registered panel type and opens the chosen one. Renders
 * as a popover anchored to the trigger button. Click outside or Esc
 * closes.
 *
 * The catalog excludes the MissingPanel sentinel + the SamplePanel
 * stubs by default; pass `includeStubs` to show them too.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.2 (+
 * Round-5 audit gap: no top-level + button).
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { panelRegistry } from './panel-registry';
import { openPanel, focusPanel } from './dock-actions';

interface AddPanelCatalogProps {
  /** Default slug to pass as params.harnessSlug for opened panels. */
  defaultSlug?: string;
  /** Optional className for the trigger button. */
  className?: string;
  /** Show stub panel types (view:design/proposals/etc) in the catalog. */
  includeStubs?: boolean;
}

const HUMAN_LABELS: Record<string, string> = {
  'data:features': 'Features',
  'data:issues': 'Issues',
  'data:agents': 'Agents',
  'data:logs': 'Logs',
  'data:git': 'Git graph',
  'data:chat': 'Chat',
  'view:harness-overview': 'Harness overview',
  'view:dashboard-overview': 'Dashboard summary',
  'view:docs': 'Docs',
  'view:design': 'Design',
  'view:proposals': 'Proposals',
  'view:summary': 'Summary',
  'view:insights': 'Insights',
  'view:config': 'Config',
};

const STUB_TYPES = new Set([
  'view:dashboard-overview',
  'view:design',
  'view:proposals',
  'view:summary',
  'view:insights',
  'view:config',
  'data:chat',
]);

function labelFor(type: string): string {
  if (HUMAN_LABELS[type]) return HUMAN_LABELS[type];
  if (type.startsWith('plugin:')) {
    const parts = type.split(':');
    // plugin:<name>:<id>
    return `${parts[1]?.replace(/^@/, '')} · ${parts[2] ?? ''}`;
  }
  return type;
}

export function AddPanelCatalog({
  defaultSlug,
  className,
  includeStubs = false,
}: AddPanelCatalogProps) {
  const [open, setOpen] = useState(false);
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => panelRegistry.subscribe(() => setRegistryTick((t) => t + 1)), []);

  const types = useMemo(() => {
    void registryTick;
    return panelRegistry
      .list()
      .filter((t) => t !== '__missing__')
      .filter((t) => includeStubs || !STUB_TYPES.has(t));
  }, [registryTick, includeStubs]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const handleAdd = (type: string) => {
    setOpen(false);
    try {
      const id = openPanel({
        type,
        params: defaultSlug ? { harnessSlug: defaultSlug } : {},
        title: labelFor(type),
      });
      focusPanel(id);
    } catch (err) {
      console.error('[AddPanelCatalog] openPanel failed', err);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }} className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add panel"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Add panel"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
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
        <Plus size={12} aria-hidden />
        Add panel
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 998,
            }}
            aria-hidden
          />
          <div
            role="dialog"
            aria-label="Panel catalog"
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
              <span>Open new panel</span>
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
            {types.length === 0 ? (
              <div
                style={{
                  padding: '8px 10px',
                  fontSize: 12,
                  color: 'var(--muted-foreground, #888)',
                }}
              >
                No panel types registered.
              </div>
            ) : (
              types.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => handleAdd(t)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 10px',
                    fontSize: 12,
                    background: 'transparent',
                    color: 'var(--foreground, #ccc)',
                    border: 0,
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = 'var(--accent, #2a2a2a)')
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ fontWeight: 500 }}>{labelFor(t)}</div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--muted-foreground, #888)',
                      fontFamily: 'ui-monospace, monospace',
                    }}
                  >
                    {t}
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

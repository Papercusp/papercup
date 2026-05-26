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
import { Popover } from '../Popover';

interface AddPanelCatalogProps {
  /** Default slug to pass as params.harnessSlug for opened panels. */
  defaultSlug?: string;
  /** Optional className for the trigger button. */
  className?: string;
  /** Show stub panel types (view:design/proposals/etc) in the catalog. */
  includeStubs?: boolean;
  /**
   * When provided, only these panel types are shown. Useful for context-
   * scoped catalogs (e.g. adv harnesses dock only shows adv:* panels).
   */
  allowedTypes?: string[];
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
  'adv:features': 'Features',
  'adv:issues': 'Issues',
  'adv:detail': 'Detail',
  'adv:git': 'Git',
};

const STUB_TYPES = new Set([
  'view:dashboard-overview',
  'view:design',
  'view:proposals',
  'view:summary',
  'view:insights',
  'view:config',
  'data:chat',
  // spawned programmatically via pin action — not user-openable
  'adv:pinned',
]);

function labelFor(type: string): string {
  if (HUMAN_LABELS[type]) return HUMAN_LABELS[type];
  const registryTitle = panelRegistry.get(type)?.meta.title;
  if (registryTitle) return registryTitle;
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
  allowedTypes,
}: AddPanelCatalogProps) {
  const [open, setOpen] = useState(false);
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => panelRegistry.subscribe(() => setRegistryTick((t) => t + 1)), []);

  const types = useMemo(() => {
    void registryTick;
    return panelRegistry
      .list()
      .filter((t) => t !== '__missing__')
      .filter((t) => includeStubs || !STUB_TYPES.has(t))
      .filter((t) => !allowedTypes || allowedTypes.includes(t));
  }, [registryTick, includeStubs, allowedTypes]);

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
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label="Panel catalog"
      trigger={
        <button
          type="button"
          aria-label="Add panel"
          className={className}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 11 }}
        >
          <Plus size={12} aria-hidden />
          Add panel
        </button>
      }
    >
      <div style={{ minWidth: 240, maxHeight: 360, overflowY: 'auto', padding: 4 }}>
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
          <span>Open new panel</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 0,
              color: 'var(--fg-mute)',
              display: 'inline-flex',
              padding: 2,
            }}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
        {types.length === 0 ? (
          <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--fg-mute)' }}>
            No panel types registered.
          </div>
        ) : (
          types.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => handleAdd(t)}
              className="pc-btn-ghost"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                fontSize: 12,
                color: 'var(--fg)',
                borderRadius: 3,
              }}
            >
              <div style={{ fontWeight: 500 }}>{labelFor(t)}</div>
              <div style={{ fontSize: 10, color: 'var(--fg-mute)', fontFamily: 'ui-monospace, monospace' }}>
                {t}
              </div>
            </button>
          ))
        )}
      </div>
    </Popover>
  );
}

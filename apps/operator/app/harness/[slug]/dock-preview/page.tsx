/**
 * /harness/<slug>/dock-preview — interactive preview of the dock model
 * shipping in Phase 5.
 *
 * Mounts <HarnessDock layoutName='preview'> against the PG-backed
 * /api/dock-layouts/preview row, with sample panel components
 * registered. Demonstrates:
 *   - Drag tabs into splits, floating groups
 *   - Layout persistence (refresh → restored)
 *   - useNavHistory in the Docs panel (back/forward chevrons)
 *   - openPanel from a button into the live dock
 *
 * Not yet shown here (later phases):
 *   - Iframe portal for VSCode/code-server
 *   - Plugin-contributed panels
 *   - Pin-as-panel from feature/issue rows
 */

'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { HarnessDock } from '../../dock/HarnessDock';
import { registerSamplePanels } from '../../dock/sample-panels';
import { openPanel, listPanels, getLayoutSnapshot, onDockApiBind, setPanelParams } from '../../dock/dock-actions';
import { AddPanelCatalog } from '../../dock/AddPanelCatalog';
import { DockNavChevrons } from '../../dock/DockNavChevrons';
import { DockOnboarding } from '../../dock/DockOnboarding';

export default function DockPreviewPage() {
  const routeParams = useParams<{ slug: string }>();
  const routeSlug = routeParams?.slug ?? 'sheets';
  const [ready, setReady] = useState(false);
  const [panelCount, setPanelCount] = useState(0);

  useEffect(() => {
    registerSamplePanels();
  }, []);

  useEffect(() => {
    return onDockApiBind((api) => {
      setReady(api !== null);
      if (!api) return;
      const refresh = () => {
        try {
          setPanelCount(listPanels().length);
        } catch {
          setPanelCount(0);
        }
      };
      refresh();
      api.onDidAddPanel(refresh);
      api.onDidRemovePanel(refresh);

      // Patch the seed: default layout has empty harnessSlug. Fill in
      // the route's slug for panels missing it. One-shot.
      try {
        for (const p of listPanels()) {
          const hs = p.params?.harnessSlug;
          if (!hs || hs === '') {
            setPanelParams(p.id, { ...p.params, harnessSlug: routeSlug });
          }
        }
      } catch {
        // Layout not yet hydrated — handled by useEffect re-fire on api change.
      }
    });
  }, [routeSlug]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border, #333)',
          background: 'var(--card, #1a1a1a)',
          fontSize: 12,
          color: 'var(--foreground, #ccc)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <strong>Dock preview</strong>
        <span style={{ color: 'var(--muted-foreground, #888)' }}>
          {ready ? `${panelCount} panels open` : 'mounting…'}
        </span>
        <DockOnboarding />
        <div style={{ flex: 1 }} />
        <DockNavChevrons />
        <AddPanelCatalog defaultSlug={routeSlug} />
        <button
          type="button"
          onClick={() =>
            openPanel({
              type: 'data:features',
              params: { harnessSlug: routeSlug, view: 'compact' },
              title: `Features: ${routeSlug} (floating)`,
              floating: { width: 480, height: 320 },
            })
          }
          style={previewBtn}
          title="Quick: open Features as a floating panel"
        >
          + Floating Features
        </button>
        <button
          type="button"
          onClick={() => {
            const snap = getLayoutSnapshot();
            console.log('layout snapshot', snap);
            alert(`Layout has ${listPanels().length} panels. See console.`);
          }}
          style={previewBtn}
        >
          snapshot
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <HarnessDock layoutName="preview" slug={routeSlug} />
      </div>
    </div>
  );
}

const previewBtn: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  background: 'var(--card, #1a1a1a)',
  color: 'var(--foreground, #ccc)',
  border: '1px solid var(--border, #333)',
  borderRadius: 4,
  cursor: 'pointer',
};

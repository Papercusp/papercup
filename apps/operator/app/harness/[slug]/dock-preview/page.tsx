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
import { HarnessDock } from '../../dock/HarnessDock';
import { registerSamplePanels } from '../../dock/sample-panels';
import { openPanel, listPanels, getLayoutSnapshot, onDockApiBind } from '../../dock/dock-actions';

export default function DockPreviewPage() {
  const [ready, setReady] = useState(false);
  const [panelCount, setPanelCount] = useState(0);

  useEffect(() => {
    registerSamplePanels();
  }, []);

  useEffect(() => {
    return onDockApiBind((api) => {
      setReady(api !== null);
      if (api) {
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
      }
    });
  }, []);

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
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() =>
            openPanel({
              type: 'data:features',
              params: { harnessSlug: 'sample' },
              title: 'Features',
            })
          }
          style={previewBtn}
        >
          + Features
        </button>
        <button
          type="button"
          onClick={() =>
            openPanel({
              type: 'data:issues',
              params: { harnessSlug: 'sample' },
              title: 'Issues',
            })
          }
          style={previewBtn}
        >
          + Issues
        </button>
        <button
          type="button"
          onClick={() =>
            openPanel({
              type: 'view:docs',
              title: 'Docs',
            })
          }
          style={previewBtn}
        >
          + Docs
        </button>
        <button
          type="button"
          onClick={() =>
            openPanel({
              type: 'data:features',
              params: { harnessSlug: 'sample', view: 'compact' },
              title: 'Features (floating)',
              floating: { width: 480, height: 320 },
            })
          }
          style={previewBtn}
        >
          + Floating
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
        <HarnessDock layoutName="preview" />
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

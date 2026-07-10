import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { HarnessDock } from '@/app/harness/dock/HarnessDock';
import { registerSamplePanels } from '@/app/harness/dock/sample-panels';
import {
  openPanel,
  listPanels,
  getLayoutSnapshot,
  onDockApiBind,
  setPanelParams,
} from '@/app/harness/dock/dock-actions';
import { AddPanelCatalog } from '@/app/harness/dock/AddPanelCatalog';
import { DockNavChevrons } from '@/app/harness/dock/DockNavChevrons';
import { DockOnboarding } from '@/app/harness/dock/DockOnboarding';
import { LayoutsMenu } from '@/app/harness/dock/LayoutsMenu';
import { Tooltip } from '@/app/harness/Tooltip';

/**
 * /harness/$slug/dock-preview — interactive preview of the dock model
 * shipping in Phase 5. Translated from
 * `apps/operator/app/harness/[slug]/dock-preview/page.tsx`.
 *
 * next → TSR diff:
 *   - `useParams<{slug:string}>()` from next/navigation → `Route.useParams()`.
 *     (Could also use the next shim — identical behavior — but TSR's typed
 *     `Route.useParams()` is the SPA-native idiom.)
 */
export const Route = createFileRoute('/harness/$slug/dock-preview')({
  component: DockPreviewPage,
});

function DockPreviewPage() {
  const { slug: routeSlug = 'sheets' } = Route.useParams();
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
          background: 'var(--bg-2)',
          fontSize: 12,
          color: 'var(--fg)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <strong>Dock preview</strong>
        <span style={{ color: 'var(--fg-mute)' }}>
          {ready ? `${panelCount} panels open` : 'mounting…'}
        </span>
        <DockOnboarding />
        <div style={{ flex: 1 }} />
        <DockNavChevrons />
        <AddPanelCatalog defaultSlug={routeSlug} />
        <LayoutsMenu currentLayoutName="preview" />
        <Tooltip label="Quick: open Features as a floating panel">
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
          >
            + Floating Features
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => {
            const snap = getLayoutSnapshot();
            console.log('layout snapshot', snap);
            toast.info(`Layout has ${listPanels().length} panels. See console.`);
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
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  border: '1px solid var(--border, #333)',
  borderRadius: 4,
  cursor: 'pointer',
};

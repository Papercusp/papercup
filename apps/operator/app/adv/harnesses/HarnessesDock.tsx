'use client';

import { useEffect } from 'react';
import { HarnessDock } from '../../harness/dock/HarnessDock';
import { panelRegistry } from '../../harness/dock/panel-registry';
import { listPanels, onDockApiBind, setPanelParams } from '../../harness/dock/dock-actions';
import FeaturesPanel from './FeaturesPanel';
import IssuesPanel from './IssuesPanel';

let registered = false;
function ensureRegistered() {
  if (registered) return;
  panelRegistry.register('adv:features', FeaturesPanel, { title: 'Features' });
  panelRegistry.register('adv:issues', IssuesPanel, { title: 'Issues' });
  registered = true;
}

/**
 * Mounts the dockview shell for /adv/harnesses with a layout name
 * keyed by harness slug. The seed (`defaultAdvHarnessesLayout` in
 * lib/dock-layouts.ts) is a 50/50 split: Features left, Issues right.
 *
 * When the user switches slug, `listPanels()` is walked and each
 * panel's `harnessSlug` param is rebound — same trick `HarnessDockShell`
 * uses for the legacy dock.
 */
export default function HarnessesDock({ slug }: { slug: string }) {
  useEffect(() => {
    ensureRegistered();
  }, []);

  const layoutName = slug ? `adv-harnesses:${slug}` : 'adv-harnesses';

  useEffect(() => {
    if (!slug) return;
    let addPanelDispose: { dispose: () => void } | null = null;
    const unbind = onDockApiBind((api) => {
      if (addPanelDispose) {
        addPanelDispose.dispose();
        addPanelDispose = null;
      }
      if (!api) return;
      const patch = (p: { id: string; params: Record<string, unknown> }) => {
        if (p.params.harnessSlug !== slug) {
          setPanelParams(p.id, { ...p.params, harnessSlug: slug });
        }
      };
      try {
        for (const p of listPanels()) patch(p);
      } catch {
        /* dock not yet hydrated; onDidAddPanel covers it */
      }
      addPanelDispose = api.onDidAddPanel((panel) => {
        try {
          const found = listPanels().find((x) => x.id === panel.id);
          if (found) patch(found);
        } catch {
          /* ignore */
        }
      });
    });
    return () => {
      if (addPanelDispose) addPanelDispose.dispose();
      unbind();
    };
  }, [slug]);

  // Absolute fill instead of height:100%. DockviewReact's root (.dv-shell)
  // sizes from its container; a height:100% chain collapses to 0 in
  // WebKitGTK (the Tauri webview) when an ancestor's height comes from
  // `flex: 1` rather than an explicit value — Chromium resolves it, WebKit
  // doesn't. position:absolute + inset:0 against the relative dock wrapper
  // gives a definite pixel box that both engines honour.
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <HarnessDock layoutName={layoutName} />
    </div>
  );
}

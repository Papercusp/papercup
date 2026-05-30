'use client';

/**
 * AdvGitDock — the dockview shell for the /adv Git page. A sibling of
 * HarnessesDock, scoped to two panel types: the RichGrid git-graph
 * (`adv:git-graph`) and pull requests (`adv:prs`). Seeded by
 * `defaultAdvGitLayout` (lib/dock-layouts.ts) under the `adv-git:<slug>`
 * layout name.
 *
 * Like HarnessesDock, it rebinds every panel's `harnessSlug` param when the
 * active slug changes so a slug switch refetches without remounting.
 */

import { useEffect } from 'react';
import { HarnessDock } from '../../harness/dock/HarnessDock';
import { panelRegistry } from '../../harness/dock/panel-registry';
import { listPanels, onDockApiBind, setPanelParams } from '../../harness/dock/dock-actions';
import AdvGitGraphPanel from './AdvGitGraphPanel';
import AdvPrsPanel from './AdvPrsPanel';

let registered = false;
function ensureRegistered() {
  if (registered) return;
  panelRegistry.register('adv:git-graph', AdvGitGraphPanel, { title: 'Git graph' });
  panelRegistry.register('adv:prs', AdvPrsPanel, { title: 'Pull requests' });
  registered = true;
}

export default function AdvGitDock({ slug }: { slug: string }) {
  useEffect(() => {
    ensureRegistered();
  }, []);

  const layoutName = slug ? `adv-git:${slug}` : 'adv-git';

  // Rebind each panel's harnessSlug when the active slug changes (same trick
  // HarnessesDock uses) so panels refetch for the new harness.
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

  // Absolute fill (see HarnessesDock for the WebKitGTK height:100% rationale).
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <HarnessDock layoutName={layoutName} className="dockview-theme-dark" slug={slug} />
    </div>
  );
}

/**
 * HarnessDockShell — Phase 5 dock mount for /harness/<slug>?dock=1.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.1, §10 Phase 5
 *
 * Opt-in shell. Replaces the entire HarnessDashboard render with a
 * full-viewport <HarnessDock layoutName="dashboard:<slug>"> + a small
 * exit-back-to-classic affordance. When user feedback warrants, this
 * becomes the default and ?dock=1 inverts to ?dock=0 for the legacy
 * dashboard.
 */

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { HarnessDock } from '../dock/HarnessDock';
import { registerSamplePanels } from '../dock/sample-panels';
import { AddPanelCatalog } from '../dock/AddPanelCatalog';
import { DockNavChevrons } from '../dock/DockNavChevrons';
import {
  openPanel,
  listPanels,
  setPanelParams,
  onDockApiBind,
} from '../dock/dock-actions';

interface HarnessDockShellProps {
  slug: string;
}

export default function HarnessDockShell({ slug }: HarnessDockShellProps) {
  const router = useRouter();

  useEffect(() => {
    registerSamplePanels();
  }, []);

  useEffect(() => {
    let addPanelDispose: { dispose: () => void } | null = null;
    const unbind = onDockApiBind((api) => {
      // Clean up previous binding's listener (if any) before
      // re-attaching to the new api.
      if (addPanelDispose) {
        addPanelDispose.dispose();
        addPanelDispose = null;
      }
      if (!api) return;
      // Patch any panel still seeded with an empty harnessSlug.
      // Server-side now bakes the slug into seeded panels
      // (defaultDashboardLayout(seededSlug) in getLayout) so this only
      // fires on previously-saved rows. Also subscribes to
      // onDidAddPanel for panels added after mount (loadLayout-induced
      // swaps + agent openPanel calls without harnessSlug).
      const patch = (p: { id: string; params: Record<string, unknown> }) => {
        const hs = p.params.harnessSlug;
        if (!hs || hs === '') {
          setPanelParams(p.id, { ...p.params, harnessSlug: slug });
        }
      };
      const patchExisting = () => {
        try {
          for (const p of listPanels()) patch(p);
        } catch {
          /* dock not yet hydrated; onDidAddPanel covers it */
        }
      };
      patchExisting();
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

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 12px',
          borderBottom: '1px solid var(--border, #333)',
          background: 'var(--card, #1a1a1a)',
          fontSize: 11,
          color: 'var(--muted-foreground, #888)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <strong style={{ color: 'var(--foreground, #ccc)' }}>Dock</strong>
        <span>{slug}</span>
        <div style={{ flex: 1 }} />
        <DockNavChevrons />
        <AddPanelCatalog defaultSlug={slug} />
        <button
          type="button"
          onClick={() => router.push(`/harness/${slug}`)}
          style={{ ...btn, color: 'var(--bad)' }}
          title="Exit dock view, go back to classic dashboard"
        >
          ← Classic
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <HarnessDock layoutName={`dashboard:${slug}`} slug={slug} />
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 11,
  background: 'var(--card, #1a1a1a)',
  color: 'var(--foreground, #ccc)',
  border: '1px solid var(--border, #333)',
  borderRadius: 3,
  cursor: 'pointer',
};

/**
 * Sample panel components registered for the dock-preview route +
 * eventual default registrations for Phase 5 root dock.
 *
 * These are minimal stubs that render the panel type + params so the
 * dock layout machinery can be exercised end-to-end without depending
 * on the full HarnessDashboard component tree.
 *
 * Real implementations replace these in Phase 5 by extracting current
 * dashboard sections into focused components.
 */

'use client';

import { useEffect } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { panelRegistry, type PanelComponentProps } from './panel-registry';
import { useNavHistory } from './useNavHistory';
import { NavChevrons } from './NavChevrons';
import { RealFeaturesPanel } from './RealFeaturesPanel';
import { RealIssuesPanel } from './RealIssuesPanel';
import { RealAgentsPanel } from './RealAgentsPanel';
import { RealLogsPanel } from './RealLogsPanel';
import { RealGitPanel } from './RealGitPanel';
import { RealHarnessOverviewPanel } from './RealHarnessOverviewPanel';
import { PinnedFeaturePanel } from './PinnedFeaturePanel';
import { PinnedIssuePanel } from './PinnedIssuePanel';

function SamplePanel({ panelType, params }: PanelComponentProps) {
  return (
    <div
      style={{
        padding: 16,
        height: '100%',
        overflow: 'auto',
        fontSize: 13,
        color: 'var(--fg)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h3 style={{ margin: 0, marginBottom: 8, fontSize: 14, fontWeight: 600 }}>
        {panelType}
      </h3>
      <Collapsible.Root>
        <Collapsible.Trigger style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', marginBottom: 8 }}>
          params
        </Collapsible.Trigger>
        <Collapsible.Content>
          <pre
            style={{
              margin: 0,
              padding: 8,
              background: 'var(--bg-2)',
              fontSize: 11,
              borderRadius: 4,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(params, null, 2)}
          </pre>
        </Collapsible.Content>
      </Collapsible.Root>
      <p style={{ marginTop: 16, color: 'var(--fg-mute)' }}>
        Sample panel. Drag the tab to split, drag outside group for floating,
        right-click the title for options.
      </p>
    </div>
  );
}

/** Docs-style panel with internal navigation, demos useNavHistory. */
function DocsSamplePanel(props: PanelComponentProps) {
  const { params, api } = props;
  type Route = { doc: string };
  const initial: Route = (params.initial as Route) ?? { doc: 'getting-started' };

  const nav = useNavHistory<Route>(initial, {
    params,
    setParams: api.setParams,
  });

  const docs = [
    { id: 'getting-started', label: 'Getting Started', body: 'Welcome to the dock.' },
    { id: 'panels', label: 'Panels', body: 'Each panel is a draggable view.' },
    { id: 'floating', label: 'Floating Groups', body: 'Drag a tab outside its group to float it.' },
    { id: 'nav', label: 'Navigation', body: 'Use the chevrons to go back and forward.' },
  ];

  const current = docs.find((d) => d.id === nav.current.doc) ?? docs[0];

  return (
    <div
      style={{
        padding: 12,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        color: 'var(--fg)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <NavChevrons nav={nav} />
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{current.label}</h3>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <p>{current.body}</p>
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 4 }}>
            Navigate to:
          </div>
          {docs.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => nav.push({ doc: d.id })}
              disabled={d.id === current.id}
              style={{
                textAlign: 'left',
                padding: '4px 8px',
                background: d.id === current.id ? 'var(--accent, #2a2a2a)' : 'transparent',
                color: 'inherit',
                border: '1px solid var(--border, #333)',
                borderRadius: 3,
                cursor: d.id === current.id ? 'default' : 'pointer',
                fontSize: 12,
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

let registered = false;

/**
 * Ensure the sample panels are registered exactly once per module load.
 * Importable from any client component; safe to call repeatedly.
 */
export function registerSamplePanels(): void {
  if (registered) return;
  registered = true;
  // Stub registrations so layouts referencing these types render
  // SamplePanel (with type + params) instead of MissingPanel.
  // Real implementations replace these as the corresponding feature
  // panels are extracted from HarnessDashboard.
  for (const stubType of [
    'view:dashboard-overview',
    'view:design',
    'view:proposals',
    'view:summary',
    'view:insights',
    'view:config',
    'data:chat',
  ]) {
    panelRegistry.register(stubType, SamplePanel);
  }
  // Real implementations — fetch live data per slug.
  panelRegistry.register('view:harness-overview', RealHarnessOverviewPanel);
  panelRegistry.register('data:features', RealFeaturesPanel);
  panelRegistry.register('data:issues', RealIssuesPanel);
  panelRegistry.register('data:agents', RealAgentsPanel, { keepAlive: true });
  panelRegistry.register('data:logs', RealLogsPanel, { keepAlive: true });
  panelRegistry.register('data:git', RealGitPanel, { keepAlive: true });
  panelRegistry.register('view:docs', DocsSamplePanel, { keepAlive: true });
  // Pin-as-panel target types (§3.2). RealFeaturesPanel + RealIssuesPanel
  // dispatch openPanel({ type: 'pin:feature', params: { harnessSlug,
  // featureId }}) on a Cmd/Ctrl-click or right-click "Pin as panel".
  panelRegistry.register('pin:feature', PinnedFeaturePanel);
  panelRegistry.register('pin:issue', PinnedIssuePanel);
}

export function useEnsureSamplePanels(): void {
  useEffect(() => {
    registerSamplePanels();
  }, []);
}

// Self-register on module import so the registry is populated before
// any React render walks a layout. Without this, the dock's first paint
// after hydrate shows MissingPanel for every panel until the page's
// registerSamplePanels useEffect runs (one tick later) — a brief flash.
//
// Safe because panelRegistry.register is idempotent + the called
// functions are pure component refs (no side effects).
registerSamplePanels();

import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { HarnessDock } from '@/app/harness/dock/HarnessDock';
import { registerWorkbenchPanels } from '@/app/harness/dock/workbench-panels';
import { registerWorkbenchVoicePanel } from '../components/workbench/WorkbenchVoicePanel';
import { registerWorkbenchHiveDirectoryPanel } from '../components/workbench/WorkbenchHiveDirectoryPanel';
import { onDockApiBind, listPanels, setPanelParams } from '@/app/harness/dock/dock-actions';
import { useLexicon } from '@/lib/useLexicon';

/**
 * /workbench — the top-level desktop workbench
 * (plan `desktop-workbench-shell-2026-06-05`, P-001;
 *  pui pane retired by `native-terminal-desktop-2026-06-06` D-002/D-008).
 *
 * Two GUI panes (left→right): the **main /adv app** and a **voice/video**
 * comms pane. The standalone operator-chat pane is retired (D-001) — the
 * operator chat lives inside the /adv app pane. The **pui/terminal is no
 * longer a pane**: a webview can't host a native terminal, so it runs as a
 * native sibling window glued to the GUI (launched by the Tauri shell).
 *
 * A separate URL from `/adv`, so it doesn't replace the current shell until
 * verified (the plan's isolation guard). The active harness is `?harness=`
 * (nuqs, agent-driveable + deep-linkable); it's patched into the voice panel
 * at runtime (the dock-preview pattern), since the static seed bakes an empty
 * slug. The /adv app pane self-manages its own harness selector.
 */
export const Route = createFileRoute('/workbench')({
  component: WorkbenchPage,
});

interface ProjectLite {
  slug: string;
  title?: string;
}

function WorkbenchPage() {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const [harness, setHarness] = useQueryState('harness', parseAsString.withDefault(''));
  const [projects, setProjects] = useState<ProjectLite[]>([]);

  // Register the workbench panel types before the dock walks the layout.
  // pui + app come from @/app; voice is registered here (operator-vite) since
  // it mounts the operator-vite VideoGrid.
  useEffect(() => {
    registerWorkbenchPanels();
    registerWorkbenchVoicePanel();
    registerWorkbenchHiveDirectoryPanel();
  }, []);

  // Harness list for the header picker. Default the selection to the first
  // project when nothing is pinned in the URL yet.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/harness/projects/lite', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        const next: ProjectLite[] = Array.isArray(d?.projects) ? d.projects : [];
        setProjects(next);
        if (!harness && next.length > 0) void setHarness(next[0].slug);
      })
      .catch(() => {
        /* picker stays empty; the pui pane shows its own empty state */
      });
    return () => {
      cancelled = true;
    };
    // Only on mount — the default-selection is one-shot; later harness changes
    // come from the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Patch the active harness into the voice panel whenever it changes.
  // Mirrors dock-preview: the seed bakes an empty slug, the route fills it in
  // once the dock API is bound (and again on each harness change).
  useEffect(() => {
    return onDockApiBind((api) => {
      if (!api) return;
      const patch = () => {
        try {
          for (const p of listPanels()) {
            if (p.type === 'workbench:voice') {
              if (p.params?.harnessSlug !== harness) {
                setPanelParams(p.id, { ...p.params, harnessSlug: harness });
              }
            }
          }
        } catch {
          /* layout not hydrated yet — re-fires on the next api bind */
        }
      };
      patch();
      api.onDidAddPanel(patch);
    });
  }, [harness]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 12px',
          borderBottom: '1px solid var(--border, #2a2a2a)',
          background: 'var(--bg-2, #16181d)',
          fontSize: 12,
          color: 'var(--fg)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <strong>Workbench</strong>
        <span style={{ color: 'var(--fg-mute, #888)' }}>app · peers · terminal (native sibling)</span>
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--fg-mute, #888)' }}>{t('pot')}</span>
          <select
            value={harness}
            onChange={(e) => void setHarness(e.target.value)}
            data-testid="workbench-harness-select"
            style={{
              background: 'var(--bg, #0e0f13)',
              color: 'var(--fg)',
              border: '1px solid var(--border, #333)',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
            }}
          >
            {harness === '' && <option value="">— select —</option>}
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title ?? p.slug}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('papercusp:dock-reset-layout'))}
          data-testid="workbench-reset-layout"
          title="Reset the workbench layout to the default 3-pane arrangement"
          style={{
            padding: '3px 10px',
            fontSize: 11,
            background: 'var(--bg, #0e0f13)',
            color: 'var(--fg)',
            border: '1px solid var(--border, #333)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Reset layout
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <HarnessDock layoutName="workbench" slug={harness} />
      </div>
    </div>
  );
}

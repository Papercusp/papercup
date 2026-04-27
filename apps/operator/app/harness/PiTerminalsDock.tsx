'use client';

/**
 * PiTerminalsDock — multi-pane container for pi/omp terminals.
 *
 * Wraps `dockview-react` so the operator can open multiple terminals as
 * tabs, drag them into splits, and rearrange. Each panel mounts its own
 * `<PiPanel>` instance, which independently spawns a pty, owns its xterm
 * instance, and tears everything down on unmount.
 *
 * Layout is persisted in localStorage per harness slug. On reload, the
 * previous arrangement is restored; pty contents are NOT restored (each
 * pane spawns a fresh pty).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview';
import 'dockview-react/dist/styles/dockview.css';
import { Plus, TerminalSquare } from 'lucide-react';
import PiPanel from './PiPanel';

interface PiTerminalsDockProps {
  slug: string;
  /** Optional initial laneId for the first terminal — typically the active feature. */
  initialLaneId?: string;
}

interface TerminalPanelParams {
  slug: string;
  laneId?: string;
}

const LAYOUT_STORAGE_PREFIX = 'papercusp:pi-dock-layout:';

function layoutKey(slug: string): string {
  return `${LAYOUT_STORAGE_PREFIX}${slug}`;
}

/** Component rendered inside each dockview panel. */
function TerminalPanelComponent(props: IDockviewPanelProps<TerminalPanelParams>) {
  const { slug, laneId } = props.params;
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <PiPanel slug={slug} laneId={laneId} />
    </div>
  );
}

/** Header action: "+" to add another terminal as a new tab. */
function AddTerminalAction({ api, slug }: { api: DockviewApi | null; slug: string }) {
  const onClick = useCallback(() => {
    if (!api) return;
    const id = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = api.panels.length;
    api.addPanel({
      id,
      component: 'terminal',
      title: `terminal ${existing + 1}`,
      params: { slug } satisfies TerminalPanelParams,
    });
  }, [api, slug]);

  return (
    <button
      type="button"
      onClick={onClick}
      title="Open another terminal"
      className="pi-dock__add-btn"
    >
      <Plus size={13} />
      <span>terminal</span>
    </button>
  );
}

export default function PiTerminalsDock({ slug, initialLaneId }: PiTerminalsDockProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [api, setApi] = useState<DockviewApi | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setApi(event.api);

      // Try to restore a saved layout; on any failure, seed a single terminal.
      let restored = false;
      try {
        const raw = window.localStorage.getItem(layoutKey(slug));
        if (raw) {
          const parsed = JSON.parse(raw);
          event.api.fromJSON(parsed);
          restored = event.api.panels.length > 0;
        }
      } catch {
        restored = false;
      }

      if (!restored) {
        event.api.addPanel({
          id: `term-initial`,
          component: 'terminal',
          title: 'terminal 1',
          params: { slug, laneId: initialLaneId } satisfies TerminalPanelParams,
        });
      }

      // Persist layout on every change.
      const persist = () => {
        try {
          window.localStorage.setItem(layoutKey(slug), JSON.stringify(event.api.toJSON()));
        } catch { /* quota / private mode — ignore */ }
      };
      event.api.onDidLayoutChange(persist);
      event.api.onDidAddPanel(persist);
      event.api.onDidRemovePanel(persist);
    },
    [slug, initialLaneId],
  );

  // Reset stored layout when the harness slug changes (defensive — DockviewReact
  // remounts on key change so this is mostly belt-and-braces).
  useEffect(() => {
    return () => {
      apiRef.current = null;
    };
  }, [slug]);

  return (
    <div className="pi-dock">
      <div className="pi-dock__header">
        <span className="pi-dock__title">
          <TerminalSquare size={13} /> pi
        </span>
        <AddTerminalAction api={api} slug={slug} />
      </div>
      <div className="pi-dock__body">
        <DockviewReact
          key={slug}
          components={{ terminal: TerminalPanelComponent }}
          onReady={onReady}
          className="dockview-theme-dark"
        />
      </div>
    </div>
  );
}

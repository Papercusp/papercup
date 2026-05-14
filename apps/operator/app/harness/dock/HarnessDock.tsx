/**
 * HarnessDock — the root DockviewReact for /harness/*.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.1, §3.3
 *
 * Responsibilities:
 *   - Mount DockviewReact with components resolved through PanelRegistry
 *   - Hydrate from /api/dock-layouts/:layoutName via useDockLayout
 *   - Persist on layout changes via debounced save (800ms)
 *   - Bridge panel API → registry-side React components
 *
 * NOTE: this is the Phase 5 root dock. Phase 3 uses a separate
 * <DashboardDock> nested inside the existing harness tab; that's a
 * thinner shim that imports this file's helpers.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview';
import 'dockview-react/dist/styles/dockview.css';
import './dock-drawer-guard.css';
import {
  panelRegistry,
  type PanelComponent,
  type PanelComponentProps,
} from './panel-registry';
import { MissingPanel } from './MissingPanel';
import { toDockviewJson, toLayoutDoc, type DockviewLayout } from './layout-adapter';
import { useDockLayout, type DockLayoutRow } from './useDockLayout';
import { bindDockApi } from './dock-actions';
import { useNavShortcuts } from './useNavShortcuts';
import { useLayoutResetShortcut } from './useLayoutResetShortcut';
import { useRegisterPluginPanels } from './useRegisterPluginPanels';
import { useFocusedPanelTracker } from './useFocusedPanelTracker';
import { destroy as destroyIframe } from './iframe-host';
import type { LayoutDoc } from '../../../lib/dock-layouts';

interface HarnessDockProps {
  /**
   * Initial PG-backed layout name. e.g. 'default', 'dashboard:sheets'.
   * Agent dispatch via `loadLayout(name)` swaps this at runtime via a
   * window CustomEvent; the dock re-hydrates from the new layout.
   */
  layoutName: string;
  /** Optional className on the dockview root for theming. */
  className?: string;
  /**
   * Optional slug used to fetch + register plugin panels via
   * /api/plugins?slug=<slug>. Required if the layout will reference any
   * `plugin:*` types.
   */
  slug?: string;
}

/**
 * Bridge a dockview panel into the registry. Dockview calls our
 * component with its own props shape (`IDockviewPanelProps`); we
 * translate to PanelComponentProps and look up the real component.
 */
function makeBridge(type: string) {
  function Bridge(dvProps: IDockviewPanelProps<Record<string, unknown>>) {
    const { api, params } = dvProps;
    const panelProps: PanelComponentProps = useMemo(
      () => ({
        panelId: api.id,
        panelType: type,
        params: (params ?? {}) as Record<string, unknown>,
        api: {
          setParams: (next) => api.updateParameters(next),
          setTitle: (t) => api.setTitle(t),
          close: () => api.close(),
        },
      }),
      [api, params],
    );

    const entry = panelRegistry.get(type);
    const Real: PanelComponent = entry?.component ?? MissingPanel;
    return <Real {...panelProps} />;
  }
  Bridge.displayName = `PanelBridge(${type})`;
  return Bridge;
}

/**
 * Build the `components` map dockview wants. We include a sentinel
 * "__bridge__" component covered by getComponent? — but dockview v6
 * requires `components` to be a static object. So we walk the layout
 * at render time and inflate a bridge component for each unique type.
 *
 * Re-evaluates when the registry changes (subscribes via tick).
 */
function useComponentsForLayout(layout: LayoutDoc | null): Record<string, PanelComponent> {
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => panelRegistry.subscribe(() => setRegistryTick((t) => t + 1)), []);

  return useMemo(() => {
    void registryTick; // dependency to refresh on registry change
    const types = new Set<string>();
    if (layout) collectTypes(layout, types);
    // Always include the missing-fallback alias so dockview can ask for it.
    types.add('__missing__');
    const map: Record<string, PanelComponent> = {};
    for (const t of types) {
      map[t] = makeBridge(t) as unknown as PanelComponent;
    }
    return map;
  }, [layout, registryTick]);
}

function collectTypes(doc: LayoutDoc, into: Set<string>): void {
  function walk(n: LayoutDoc['root']): void {
    if (n.kind === 'tabs') {
      for (const p of n.panels) into.add(p.type);
    } else {
      for (const c of n.children) walk(c);
    }
  }
  walk(doc.root);
  for (const f of doc.floating ?? []) {
    for (const p of f.panels) into.add(p.type);
  }
}

export function HarnessDock({ layoutName: initialLayoutName, className, slug }: HarnessDockProps) {
  // layoutName tracked as state so loadLayout() can swap at runtime.
  const [activeLayoutName, setActiveLayoutName] = useState(initialLayoutName);
  useEffect(() => {
    setActiveLayoutName(initialLayoutName);
  }, [initialLayoutName]);

  const { state, save, reset } = useDockLayout(activeLayoutName);
  const apiRef = useRef<DockviewApi | null>(null);
  const restoredOnceRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cmd+[/] global shortcuts; ignored when focus is in an input.
  useNavShortcuts();
  // Shift+Esc (1s long-press) hard-resets to seed. Recovery hatch when
  // the dock is wedged.
  useLayoutResetShortcut(() => {
    restoredOnceRef.current = false;
    void reset();
  });
  // Plugin panels — registers in panelRegistry via /api/plugins. Hot-swap
  // (§8.3) handles registration that lands after layout hydration.
  useRegisterPluginPanels(slug ?? '');
  // Sync focused panel's harnessSlug → ?focusSlug= so agent + voice
  // context defaults track whichever panel the user is looking at.
  useFocusedPanelTracker();

  const layoutDoc: LayoutDoc | null =
    state.status === 'ready' && state.row.schemaVersion === 1
      ? (state.row.layoutJson as LayoutDoc)
      : null;

  const components = useComponentsForLayout(layoutDoc);

  // Hydrate once the layout AND the dockview API are both ready.
  useEffect(() => {
    if (restoredOnceRef.current) return;
    if (!apiRef.current || !layoutDoc) return;
    try {
      const dvJson: DockviewLayout = toDockviewJson(layoutDoc);
      apiRef.current.fromJSON(dvJson as unknown as Parameters<DockviewApi['fromJSON']>[0]);
      restoredOnceRef.current = true;
    } catch (err) {
      console.error('[HarnessDock] hydrate failed:', err);
    }
  }, [layoutDoc]);

  const persist = useCallback(() => {
    if (!apiRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const dv = apiRef.current?.toJSON() as unknown as DockviewLayout | undefined;
      if (!dv) return;
      const doc = toLayoutDoc(dv);
      save(doc).catch((err: Error & { conflict?: boolean }) => {
        if (err.conflict) {
          // Another tab wrote first. useDockLayout refreshed state; next
          // persist will use the new updatedTs.
          return;
        }
        console.warn('[HarnessDock] save failed:', err.message);
      });
    }, 800);
  }, [save]);

  // Track whether dockview is ready. Listeners attach via a separate
  // effect that depends on `persist` so a loadLayout-induced re-bind
  // of `save` correctly resubscribes (otherwise old listeners save to
  // the previous layout name).
  const [apiReady, setApiReady] = useState(false);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    bindDockApi(event.api);
    setApiReady(true);
  }, []);

  // Subscribe to dockview events whenever `persist` changes (i.e. after
  // `save` rebinds to a new layout name). Cleans up disposables on
  // re-subscription + on unmount.
  useEffect(() => {
    if (!apiReady || !apiRef.current) return;
    const api = apiRef.current;
    const disposables = [
      api.onDidLayoutChange(persist),
      api.onDidAddPanel(persist),
      api.onDidRemovePanel((panel) => {
        persist();
        // Tear down any iframe-host entry keyed by this panel id.
        // No-op for panels that never registered an iframe.
        try {
          destroyIframe(panel.id);
        } catch {
          /* destroy is idempotent; absorb errors */
        }
      }),
    ];
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [apiReady, persist]);

  // Clean up the debounce timer + api-binding on unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      bindDockApi(null);
    };
  }, []);

  // Agent dispatch surface (§9.1): listen for cross-process events.
  useEffect(() => {
    const onResetLayout = () => {
      restoredOnceRef.current = false;
      void reset();
    };
    const onLoadLayout = (e: Event) => {
      const detail = (e as CustomEvent<{ name?: string }>).detail;
      if (detail?.name && typeof detail.name === 'string') {
        restoredOnceRef.current = false;
        setActiveLayoutName(detail.name);
      }
    };
    window.addEventListener('papercusp:dock-reset-layout', onResetLayout);
    window.addEventListener('papercusp:dock-load-layout', onLoadLayout);
    return () => {
      window.removeEventListener('papercusp:dock-reset-layout', onResetLayout);
      window.removeEventListener('papercusp:dock-load-layout', onLoadLayout);
    };
  }, [reset]);

  if (state.status === 'error') {
    return (
      <div style={{ padding: 16, color: '#f99', fontSize: 13 }}>
        Failed to load layout {activeLayoutName}: {state.error.message}
      </div>
    );
  }

  return (
    <DockviewReact
      onReady={onReady}
      components={components}
      className={className ?? 'dockview-theme-dark'}
    />
  );
}

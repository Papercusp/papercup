/**
 * HarnessDock — Papercusp adapter around the shared @papercusp/dock-workbench
 * DockWorkspace.
 *
 * The generic package owns dockview hydration, persistence, layout schema,
 * panel bridging, and reset/load events. This adapter keeps the app-specific
 * behavior: plugin panels, close guards, keyboard shortcuts, focused-panel
 * tracking, iframe teardown, and the global dock-actions API binding.
 */

'use client';

import { useCallback, useEffect } from 'react';
import { DockWorkspace, createFetchDockLayoutStore } from '@papercusp/dock-workbench';
import './dock-drawer-guard.css';
import { MissingPanel } from './MissingPanel';
import { bindDockApi } from './dock-actions';
import { canClosePanel, configureCloseGuard } from './close-guard';
import { useNavShortcuts } from './useNavShortcuts';
import { useLayoutResetShortcut } from './useLayoutResetShortcut';
import { useRegisterPluginPanels } from './useRegisterPluginPanels';
import { useFocusedPanelTracker } from './useFocusedPanelTracker';
import { destroy as destroyIframe } from './iframe-host';
import { useConfirmDialog } from '../useConfirmDialog';

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
   * /api/plugins?slug=<slug>. Required if the layout references `plugin:*`.
   */
  slug?: string;
}

const layoutStore = createFetchDockLayoutStore('/api/dock-layouts');

export function HarnessDock({ layoutName, className, slug }: HarnessDockProps) {
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  useEffect(() => {
    configureCloseGuard({
      confirm: () =>
        askConfirm({
          title: 'Discard unsaved changes?',
          body: 'This panel has unsaved changes. Close it anyway?',
          confirmLabel: 'Close panel',
          destructive: true,
        }),
    });
  }, [askConfirm]);

  useNavShortcuts();
  useLayoutResetShortcut(() => {
    window.dispatchEvent(new CustomEvent('papercusp:dock-reset-layout'));
  });
  useRegisterPluginPanels(slug ?? '');
  useFocusedPanelTracker();

  const onApiReady = useCallback((api: Parameters<typeof bindDockApi>[0]) => {
    bindDockApi(api);
  }, []);

  const onApiDispose = useCallback(() => {
    bindDockApi(null);
  }, []);

  const onPanelRemoved = useCallback((panelId: string) => {
    try {
      destroyIframe(panelId);
    } catch {
      /* destroy is idempotent; absorb errors */
    }
  }, []);

  return (
    <>
      {confirmEl}
      <DockWorkspace
        layoutName={layoutName}
        store={layoutStore}
        className={className ?? 'dockview-theme-dark'}
        missingComponent={MissingPanel}
        canClosePanel={canClosePanel}
        onApiReady={onApiReady}
        onApiDispose={onApiDispose}
        onPanelRemoved={onPanelRemoved}
        resetEventName="papercusp:dock-reset-layout"
        loadEventName="papercusp:dock-load-layout"
      />
    </>
  );
}

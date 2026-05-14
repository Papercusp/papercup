/**
 * useNavShortcuts — global Cmd+[ / Cmd+] (Ctrl+[ / Ctrl+] on linux/win)
 * dispatching to the focused panel's nav history.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §6.2
 *
 * Mount once at the dock root. Reads the focused panel id via
 * onDockApiBind + activeGroup, then looks up its nav via
 * getNavForPanel(). Panels that opt out of nav don't register; the
 * shortcut becomes a no-op for them.
 */

'use client';

import { useEffect } from 'react';
import { onDockApiBind } from './dock-actions';
import { getNavForPanel } from './NavChevrons';

export function useNavShortcuts(): void {
  useEffect(() => {
    let activePanelId: string | null = null;

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key !== '[' && e.key !== ']') return;
      // Don't hijack from input fields.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return;
      }
      if (!activePanelId) return;
      const nav = getNavForPanel(activePanelId);
      if (!nav) return;
      if (e.key === '[' && nav.canBack) {
        e.preventDefault();
        nav.back();
      } else if (e.key === ']' && nav.canForward) {
        e.preventDefault();
        nav.forward();
      }
    };

    const unbindApi = onDockApiBind((api) => {
      if (!api) {
        activePanelId = null;
        return;
      }
      const refresh = () => {
        activePanelId = api.activeGroup?.activePanel?.id ?? null;
      };
      refresh();
      api.onDidActivePanelChange(refresh);
    });

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      unbindApi();
    };
  }, []);
}

'use client';

import {
  createFetchDockLayoutStore,
  useDockLayout as useSharedDockLayout,
  type DockLayoutRow,
  type UseDockLayoutResult,
} from '@papercusp/dock-workbench';

const store = createFetchDockLayoutStore('/api/dock-layouts');

export type { DockLayoutRow, UseDockLayoutResult };

export function useDockLayout(name: string): UseDockLayoutResult {
  return useSharedDockLayout(name, store);
}

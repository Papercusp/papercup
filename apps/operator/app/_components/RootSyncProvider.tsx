'use client';
import type { ReactNode } from 'react';
import { HarnessZeroProvider } from '../../providers/HarnessZeroProvider';
export function RootSyncProvider({ children }: { children: ReactNode }) {
  return <HarnessZeroProvider>{children}</HarnessZeroProvider>;
}

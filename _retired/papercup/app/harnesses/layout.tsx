import type { ReactNode } from 'react';
import { HarnessZeroProvider } from '../../providers/HarnessZeroProvider';

export default function HarnessesLayout({ children }: { children: ReactNode }) {
  return <HarnessZeroProvider>{children}</HarnessZeroProvider>;
}

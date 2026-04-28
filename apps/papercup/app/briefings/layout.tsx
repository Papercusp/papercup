import type { ReactNode } from 'react';
import { HarnessZeroProvider } from '../../providers/HarnessZeroProvider';

export default function BriefingsLayout({ children }: { children: ReactNode }) {
  return <HarnessZeroProvider>{children}</HarnessZeroProvider>;
}

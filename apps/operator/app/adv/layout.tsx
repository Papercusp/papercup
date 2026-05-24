import type { ReactNode } from 'react';
import AdvShell from './_components/AdvShell';

export const metadata = { title: 'Advanced · Papercusp' };

export default function AdvLayout({ children }: { children: ReactNode }) {
  return <AdvShell>{children}</AdvShell>;
}

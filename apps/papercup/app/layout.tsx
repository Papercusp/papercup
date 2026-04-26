import { PapercupTabs } from '@restart/papercup-shared';
import './papercup.css';

export const metadata = { title: 'Papercup' };

export default function PapercupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="papercup-shell">
      <PapercupTabs basePath="/papercup" />
      <main className="papercup-route">{children}</main>
    </div>
  );
}

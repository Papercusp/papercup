export const dynamic = 'force-dynamic';
import { PapercupTabs } from '@restart/papercup-shared';
import { HarnessZeroProvider } from '../providers/HarnessZeroProvider';
import { ChatwootWidget } from './_components/ChatwootWidget';
import './papercup.css';

export const metadata = { title: 'Papercup' };

export default function PapercupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="papercup-shell">
      <PapercupTabs basePath="" />
      <main className="papercup-route">
        <HarnessZeroProvider>{children}</HarnessZeroProvider>
      </main>
      <ChatwootWidget />
    </div>
  );
}

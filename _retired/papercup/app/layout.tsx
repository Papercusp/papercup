export const dynamic = 'force-dynamic';
import { PapercupTabs } from '@papercusp/papercusp-shared';
import { HarnessZeroProvider } from '../providers/HarnessZeroProvider';
import { ChatwootWidget } from './_components/ChatwootWidget';
import './papercup.css';

export const metadata = { title: 'Papercup' };

// Server-side resolved at request time. HARNESS_ZERO_SERVER is set by the
// papercup container env (e.g. https://zero-papercup.papercupai.com).
// Falls back to NEXT_PUBLIC_* (if baked at build time) or localhost for dev.
const HARNESS_ZERO_SERVER =
  process.env.HARNESS_ZERO_SERVER ??
  process.env.NEXT_PUBLIC_HARNESS_ZERO_SERVER ??
  'http://localhost:4849';

export default function PapercupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="papercup-shell">
      <script
        dangerouslySetInnerHTML={{
          __html: `window.__HARNESS_ZERO_SERVER=${JSON.stringify(HARNESS_ZERO_SERVER)};`,
        }}
      />
      <PapercupTabs basePath="" />
      <main className="papercup-route">
        <HarnessZeroProvider>{children}</HarnessZeroProvider>
      </main>
      <ChatwootWidget />
    </div>
  );
}

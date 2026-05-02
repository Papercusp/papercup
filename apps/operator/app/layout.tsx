import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import WorkspaceSwitcher from './_components/WorkspaceSwitcher';
import UpdateChip from './_components/UpdateChip';
import { ChatwootWidget } from './_components/ChatwootWidget';
import { OracleDock } from './_components/OracleDock';
import TutorialButton from './_components/TutorialButton';
import { HostCheckBanner } from './_components/HostCheckBanner';
import './globals.css';

export const metadata: Metadata = {
  title: 'Papercusp',
  description: 'Open-source autonomous-harness framework. Build, share, and run multi-agent missions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <NuqsAdapter>
          <header className="pc-header">
            <a href="/" className="brand" aria-label="papercusp" style={{ display: 'flex', alignItems: 'center' }}>
              <img src="/wordmark.svg" alt="papercusp" height={22} style={{ display: 'block' }} />
            </a>
            <span className="pc-header-quote">Nothing is so painful to the human mind as a great and sudden change</span>
            <a href="/harness" className="pc-header-cta" aria-label="Mission Control">Mission Control</a>
            <nav aria-label="Primary navigation">
              <a href="/marketplace/">Marketplace</a>
              <a href="/installed/harnesses">Harnesses</a>
              <a href="/installed/plugins">Plugins</a>
              <a href="/installed/snapshots">Snapshots</a>
              <a href="/support">Support</a>
              <a href="/settings/api-keys">Settings</a>
              <a href="https://github.com/papercupai/papercusp" target="_blank" rel="noopener noreferrer">GitHub</a>
              <TutorialButton />
              <UpdateChip />
              <WorkspaceSwitcher />
            </nav>
          </header>
          <HostCheckBanner />
          <main>{children}</main>
          <Toaster theme="dark" position="top-right" />
          <ChatwootWidget />
          <OracleDock />
        </NuqsAdapter>
      </body>
    </html>
  );
}

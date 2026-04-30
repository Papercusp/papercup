import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import SessionIndicator from './_components/SessionIndicator';
import WorkspaceSwitcher from './_components/WorkspaceSwitcher';
import { ChatwootWidget } from './_components/ChatwootWidget';
import { OracleDock } from './_components/OracleDock';
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
            <a href="/" className="brand" aria-label="papercusp">
              <img src="/wordmark.svg" alt="papercusp" height={32} />
            </a>
            <span className="pc-header-quote">Nothing is so painful to the human mind as a great and sudden change</span>
            <nav aria-label="Primary navigation">
              <a href="/harness">Harnesses</a>
              <a href="/snapshots">Snapshots</a>
              <a href="/marketplace/">Marketplace</a>
              <a href="/support">Support</a>
              <a href="/settings/api-keys">Settings</a>
              <WorkspaceSwitcher />
              <SessionIndicator />
            </nav>
          </header>
          <main>{children}</main>
          <Toaster theme="dark" position="top-right" />
          <ChatwootWidget />
          <OracleDock />
        </NuqsAdapter>
      </body>
    </html>
  );
}

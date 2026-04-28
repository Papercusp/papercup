import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import SessionIndicator from './_components/SessionIndicator';
import { ChatwootWidget } from './_components/ChatwootWidget';
import './globals.css';

export const metadata: Metadata = {
  title: 'Papercusp',
  description: 'Open-source autonomous-harness framework. Build, share, and run multi-agent missions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <header className="pc-header">
          <a href="/" className="brand" aria-label="papercusp" style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
            <img src="/wordmark.svg" alt="papercusp" height={28} style={{ display: 'block' }} />
          </a>
          <nav>
            <a href="/harness">Harnesses</a>
            <a href="/marketplace/templates">Templates</a>
            <a href="/marketplace/plugins">Plugins</a>
            <a href="/support">Support</a>
            <a href="/settings/api-keys">Settings</a>
            <SessionIndicator />
          </nav>
        </header>
        <main>{children}</main>
        <Toaster theme="dark" position="top-right" />
        <ChatwootWidget />
      </body>
    </html>
  );
}

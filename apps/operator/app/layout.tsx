import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import ChromeShell from './_components/ChromeShell';
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
          <ChromeShell />
          <main>{children}</main>
          <Toaster theme="dark" position="top-right" />
        </NuqsAdapter>
      </body>
    </html>
  );
}

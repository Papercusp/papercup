import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import WorkspaceSwitcher from './_components/WorkspaceSwitcher';
import UpdateChip from './_components/UpdateChip';
import { ChatwootWidget } from './_components/ChatwootWidget';
import { OracleDock } from './_components/OracleDock';
import TutorialButton from './_components/TutorialButton';
import { SiteHeader } from '@papercup/marketplace-public-ui';
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
          <SiteHeader
            navLinks={[
              { href: '/marketplace/', label: 'Marketplace' },
              { href: '/harness', label: 'Harnesses' },
              { href: '/installed/plugins', label: 'Plugins' },
              { href: '/installed/snapshots', label: 'Snapshots' },
              { href: '/docs', label: 'Docs' },
              { href: '/support', label: 'Support' },
              { href: 'https://github.com/papercupai/papercusp', label: 'GitHub', external: true },
            ]}
            extras={<><TutorialButton /><UpdateChip /><WorkspaceSwitcher /></>}
          />
          <main>{children}</main>
          <Toaster theme="dark" position="top-right" />
          <ChatwootWidget />
          <OracleDock />
        </NuqsAdapter>
      </body>
    </html>
  );
}

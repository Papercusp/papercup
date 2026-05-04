import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ViewTransitions } from 'next-view-transitions';
import ChromeShell from './_components/ChromeShell';
import GlobalShortcutDispatcher from './_components/GlobalShortcutDispatcher';
import RouteProgressProvider from './_components/RouteProgressProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Papercusp',
  description: 'Open-source autonomous-harness framework. Build, share, and run multi-agent missions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransitions>
      <html lang="en" suppressHydrationWarning>
        <body>
          {/* Tooltip.Provider hoisted to the root so ChromeShell-rendered
              children (OperatorPanel, OracleDock) can use the harness/Tooltip
              wrapper without each route layout having to install its own
              provider. The /harness and /pi sub-layouts had their own providers
              historically — those are now redundant but harmless (Radix allows
              nested providers). */}
          <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
            <RouteProgressProvider>
              <GlobalShortcutDispatcher />
              <NuqsAdapter>
                <ChromeShell />
                <main>{children}</main>
                {/* Single app-wide Toaster, outside <main> so toasts can stack
                    above pc-header (z:1300) and OracleDock (z:80). Sub-pages
                    must not mount their own — those are trapped inside
                    <main z:70> and can't visually escape regardless of
                    inline z-index. */}
                <Toaster theme="dark" position="top-right" richColors style={{ zIndex: 2147483646 }} />
              </NuqsAdapter>
            </RouteProgressProvider>
          </Tooltip.Provider>
        </body>
      </html>
    </ViewTransitions>
  );
}

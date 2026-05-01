import type { ReactNode } from 'react';
import 'fumadocs-ui/style.css';
import './blue-frost.css';
import { RootProvider } from 'fumadocs-ui/provider/next';

export const metadata = {
  title: 'Papercusp Docs',
  description: 'Public documentation for the Papercusp platform.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <RootProvider theme={{ defaultTheme: 'dark', enableSystem: false, attribute: 'class' }}>{children}</RootProvider>
      </body>
    </html>
  );
}

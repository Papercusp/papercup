import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://theswarm.dev'),
  title: 'The Swarm',
  description:
    'Create or Join a Hive, start a swarm, and mold the future for whatever comes next.',
  openGraph: {
    title: 'The Swarm',
    description:
      'Welcome to the End. Be part of the new beginning. Create or Join a Hive, start a swarm, and mold the future for whatever comes next.',
    url: 'https://theswarm.dev',
    siteName: 'The Swarm',
    images: [{ url: '/brand/swarm-hero.png', width: 1672, height: 941 }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'The Swarm',
    description:
      'Create or Join a Hive, start a swarm, and mold the future for whatever comes next.',
    images: ['/brand/swarm-hero.png'],
  },
  icons: {
    icon: '/favicon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#050505',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

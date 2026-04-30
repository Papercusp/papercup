import { RootProvider } from 'fumadocs-ui/provider/next';
import Chromeless from '../_components/Chromeless';
import './docs.css';

export default function DocsRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <RootProvider theme={{ defaultTheme: 'dark', forcedTheme: 'dark', enableSystem: false }}>
      <Chromeless auto />
      {children}
    </RootProvider>
  );
}
